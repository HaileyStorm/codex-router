import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ageToolResults } from "../src/tool-result-aging.mjs";

const retentionRoot = mkdtempSync(path.join(os.tmpdir(), "tool-result-retention-test-"));
process.env.MODEL_ROUTER_STATE_DIR = retentionRoot;
process.env.MODEL_ROUTER_TOOL_RESULT_RETENTION_DIR = path.join(retentionRoot, "retained");
process.env.MODEL_ROUTER_TOOL_RESULT_RETENTION_MAX_FILES = "2";
const {
  retainToolResult,
  retrieveToolResult,
  retrieveToolResultByDigest,
  toolResultRetentionContext,
  TOOL_RESULT_RETENTION_DIR,
} = await import("../src/tool-result-retention.mjs");
test.after(() => rmSync(retentionRoot, { recursive: true, force: true }));
let realStoreFixture;

function retained(bytes, { expectedDigest }) {
  return {
    handle: "A".repeat(43),
    digest: expectedDigest,
    byteLength: bytes.length,
  };
}

function call(id, name = "exec_command", argumentsValue = JSON.stringify({ cmd: "npm test" })) {
  return { type: "function_call", call_id: id, name, arguments: argumentsValue };
}

function output(id, value) {
  return { type: "function_call_output", call_id: id, output: value };
}

test("ages a large consumed result while preserving its call pairing and recovery evidence", () => {
  const value = `HEAD\n${"middle\n".repeat(8_000)}TAIL`;
  const input = [
    call("old", "exec_command"),
    output("old", value),
    { type: "message", role: "assistant", content: "I used that result." },
    ...Array.from({ length: 4 }, (_, index) => [
      call(`new-${index}`),
      output(`new-${index}`, "small"),
    ]).flat(),
  ];

  let retainedBeforeRewrite = false;
  const result = ageToolResults(input, {
    retain(bytes, metadata) {
      assert.equal(input[1].output, value);
      assert.equal(bytes.toString("utf8"), value);
      assert.equal(metadata.callId, "old");
      assert.equal(metadata.outputType, "function_call_output");
      retainedBeforeRewrite = true;
      return retained(bytes, metadata);
    },
  });
  assert.equal(retainedBeforeRewrite, true);
  assert.notEqual(result.input, input);
  assert.equal(result.stats.toolResultsAged, 1);
  assert.ok(result.stats.toolResultBytesSaved > 40_000);
  assert.equal(result.input[1].call_id, "old");
  assert.doesNotMatch(result.input[1].output, /\.\/bin\/control|retrieve\s/i);
  // The receipt names the recovery the model can actually perform. Describing
  // the owner-private retention instead pointed it at bytes it has no way to
  // reach, which is how a model ends up claiming it re-read something it did
  // not; the graduation A/B measured re-running the tool, not retrieval.
  assert.match(
    result.input[1].output,
    /Repeat the preceding exec_command call with the same arguments/,
  );
  assert.doesNotMatch(result.input[1].output, /owner-priv|Owner-local|Retrieval is/i);
  assert.match(result.input[1].output, /HEAD/);
  assert.match(result.input[1].output, /TAIL/);
  assert.match(
    result.input[1].output,
    new RegExp(createHash("sha256").update(value).digest("hex")),
  );
});

test("smart policy preserves unknown custom-tool output, pairing, call ids, and order", () => {
  const value = `custom-head\n${"custom-middle\n".repeat(3_000)}custom-tail`;
  const input = [
    { type: "custom_tool_call", call_id: "custom-1", name: "bulk_fetch", input: "query" },
    { type: "custom_tool_call_output", call_id: "custom-1", output: value },
    { type: "message", role: "assistant", content: "acted" },
  ];
  const result = ageToolResults(input, { frontier: 0, retain: retained });
  assert.equal(result.stats.toolResultsAged, 0);
  assert.equal(result.input, input);
  assert.deepEqual(result.input[0], input[0]);
  assert.equal(result.input[1].type, "custom_tool_call_output");
  assert.equal(result.input[1].call_id, "custom-1");
  assert.equal(result.input[2], input[2]);
  assert.equal(result.input.length, input.length);
});

test("rejects orphan, duplicate, mismatched, and out-of-order call pairs", () => {
  const value = "retention row\n".repeat(4_000);
  const cases = [
    [output("orphan", value), { type: "message", role: "assistant", content: "acted" }],
    [call("dup"), call("dup"), output("dup", value), { type: "message", role: "assistant", content: "acted" }],
    [
      { type: "custom_tool_call", call_id: "wrong", name: "x", input: "" },
      output("wrong", value),
      { type: "message", role: "assistant", content: "acted" },
    ],
    [output("late", value), call("late"), { type: "message", role: "assistant", content: "acted" }],
  ];
  for (const input of cases) {
    const result = ageToolResults(input, { frontier: 0, retain: retained });
    assert.equal(result.input, input);
    assert.equal(result.stats.toolResultsAged, 0);
  }
});

test("retention failure or invalid retained metadata preserves the original by reference", () => {
  const value = "retention row\n".repeat(4_000);
  const input = [
    call("old"),
    output("old", value),
    { type: "message", role: "assistant", content: "acted" },
  ];
  for (const retain of [
    () => { throw new Error("disk full"); },
    (bytes, metadata) => ({ ...retained(bytes, metadata), digest: "0".repeat(64) }),
    (bytes, metadata) => ({ ...retained(bytes, metadata), byteLength: bytes.length - 1 }),
  ]) {
    const result = ageToolResults(input, { frontier: 0, retain });
    assert.equal(result.input, input);
    assert.equal(result.input[1], input[1]);
    assert.equal(result.input[1].output, value);
    assert.equal(result.stats.toolResultsAged, 0);
    assert.equal(result.stats.toolResultRetentionFailures, 1);
    assert.equal(result.stats.toolResultRetentionDegradedReason, "storage");
  }
});

test("in-progress, incomplete, and non-UTF8-round-trippable results pass through", () => {
  const cases = [
    { ...output("pending", "x".repeat(40_000)), status: "in_progress" },
    { ...output("incomplete", "x".repeat(40_000)), status: "incomplete" },
    output("surrogate", `${"x".repeat(40_000)}\ud800`),
  ];
  for (const item of cases) {
    const input = [
      call(item.call_id),
      item,
      { type: "message", role: "assistant", content: "acted" },
    ];
    const result = ageToolResults(input, { frontier: 0, retain: retained });
    assert.equal(result.input, input);
    assert.equal(result.stats.toolResultsAged, 0);
  }
});

test("smart aging preserves critical, structured, exact-tool, and ambiguous output", () => {
  const structured = JSON.stringify({ rows: Array.from({ length: 5_000 }, (_, id) => ({ id })) });
  const cases = [
    { name: "exec_command", value: `fatal error: integrity mismatch\n${"trace\n".repeat(8_000)}` },
    { name: "bulk_fetch", value: structured },
    { name: "apply_patch", value: `patch bytes\n${"same\n".repeat(8_000)}` },
    { name: "exec_command", value: Array.from({ length: 5_000 }, (_, n) => `unique-${n}-${n * 7919}`).join("\n") },
  ];
  for (const [index, entry] of cases.entries()) {
    const id = `smart-${index}`;
    const input = [
      call(id, entry.name),
      output(id, entry.value),
      { type: "message", role: "assistant", content: "acted" },
    ];
    const result = ageToolResults(input, { frontier: 0, retain: retained });
    assert.equal(result.input, input, entry.name);
    assert.equal(result.stats.toolResultsAged, 0, entry.name);
  }
});

test("smart aging keeps structured, exact, authority, and one-line classes full", () => {
  const repeatedJsonl = `${'{"status":"ok","rows":[1,2,3]}\n'.repeat(2_000)}`;
  const repeatedCsv = `name,status,value\n${"build,ok,1\n".repeat(4_000)}`;
  const cases = [
    { id: "jsonl", tool: call("jsonl"), value: repeatedJsonl },
    { id: "csv", tool: call("csv"), value: repeatedCsv },
    { id: "diff", tool: call("diff"), value: `diff --git a/a b/a\n${"+same\n".repeat(8_000)}` },
    { id: "schema", tool: call("schema", "read_schema", "{}"), value: `${"field string\n".repeat(4_000)}` },
    { id: "authority", tool: call("authority"), value: `${"approval required\n".repeat(4_000)}` },
    { id: "one-line", tool: call("one-line"), value: "x".repeat(40_000) },
    { id: "base64", tool: call("base64"), value: Buffer.alloc(40_000, 7).toString("base64") },
  ];
  for (const entry of cases) {
    const input = [
      entry.tool,
      output(entry.id, entry.value),
      { type: "message", role: "assistant", content: "acted" },
    ];
    const result = ageToolResults(input, { frontier: 0, retain: retained });
    assert.equal(result.input, input, entry.id);
    assert.equal(result.stats.toolResultsAged, 0, entry.id);
  }
});

test("smart aging preserves unknown tools, malformed arguments, and terminal controls", () => {
  const bulky = `row\n${"healthy repeat\n".repeat(8_000)}`;
  const cases = [
    call("unknown", "bulk_fetch", JSON.stringify({ query: "rows" })),
    call("malformed", "exec_command", "{not-json"),
    call("compound", "exec_command", JSON.stringify({ cmd: "npm test && upload-results" })),
  ];
  for (const toolCall of cases) {
    const input = [
      toolCall,
      output(toolCall.call_id, bulky),
      { type: "message", role: "assistant", content: "acted" },
    ];
    assert.equal(ageToolResults(input, { frontier: 0, retain: retained }).input, input);
  }
  const terminal = `${"healthy repeat\n".repeat(8_000)}\u001b]0;unsafe-title\u0007`;
  const terminalInput = [
    call("terminal"),
    output("terminal", terminal),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const terminalResult = ageToolResults(terminalInput, { frontier: 0, retain: retained });
  assert.equal(terminalResult.input, terminalInput);
  assert.equal(terminalResult.stats.toolResultsAged, 0);
});

test("smart aging keeps mutating shell forms, warnings, and nonzero exits full", () => {
  const repetitive = "healthy row\n".repeat(5_000);
  const cases = [
    { id: "find-delete", command: "find . -delete", value: repetitive },
    { id: "pipe-delete", command: "rg TODO . | xargs rm", value: repetitive },
    { id: "redirect", command: "git status > status.txt", value: repetitive },
    { id: "snapshot", command: "npm test -- --updateSnapshot", value: repetitive },
    { id: "snapshot-equals", command: "npm test -- --updateSnapshot=true", value: repetitive },
    { id: "update-equals", command: "npm test -- -u=true", value: repetitive },
    { id: "fix-equals", command: "npm run check -- --fix=true", value: repetitive },
    { id: "ifs-expansion", command: "npm test ${IFS}--updateSnapshot", value: repetitive },
    { id: "variable-expansion", command: "npm test $MUTATING_TEST_ARGS", value: repetitive },
    { id: "escaped-word", command: "npm test -- --updateSnap\\shot", value: repetitive },
    { id: "quoted-word", command: "npm test -- --updateSnap''shot", value: repetitive },
    { id: "newline", command: "npm test\nrm -f result", value: repetitive },
    { id: "source-head", command: "head -n 500 generated.js", value: repetitive },
    { id: "source-rg", command: "rg needle generated.js", value: repetitive },
    { id: "find-print", command: "find . -fprint generated.txt", value: repetitive },
    { id: "rg-pre", command: "rg --pre 'touch generated.txt' needle .", value: repetitive },
    { id: "warning", command: "npm test", value: `${"healthy row\n".repeat(2_500)}WARNING: flaky result\n${"healthy row\n".repeat(2_500)}` },
    { id: "warnings", command: "npm test", value: `${"healthy row\n".repeat(2_500)}3 warnings generated\n${"healthy row\n".repeat(2_500)}` },
    { id: "exit", command: "npm test", value: `${"healthy row\n".repeat(2_500)}exit code 2\n${"healthy row\n".repeat(2_500)}` },
  ];
  for (const entry of cases) {
    const input = [
      call(entry.id, "exec_command", JSON.stringify({ cmd: entry.command })),
      output(entry.id, entry.value),
      { type: "message", role: "assistant", content: "acted" },
    ];
    const result = ageToolResults(input, { frontier: 0, retain: retained });
    assert.equal(result.input, input, entry.id);
    assert.equal(result.stats.toolResultsAged, 0, entry.id);
  }
});

test("a summary that misses the savings gate never invokes or writes retention", () => {
  const value = `${"界".repeat(100)}\n`.repeat(109);
  const id = "unicode-savings";
  const input = [
    call(id),
    output(id, value),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const before = existsSync(TOOL_RESULT_RETENTION_DIR)
    ? readdirSync(TOOL_RESULT_RETENTION_DIR).filter((name) => name.endsWith(".result")).length
    : 0;
  let called = false;
  const result = ageToolResults(input, {
    frontier: 0,
    retain(...args) {
      called = true;
      return retainToolResult(...args);
    },
    retentionContext: toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro"),
  });
  const after = existsSync(TOOL_RESULT_RETENTION_DIR)
    ? readdirSync(TOOL_RESULT_RETENTION_DIR).filter((name) => name.endsWith(".result")).length
    : 0;
  assert.equal(result.input, input);
  assert.equal(result.stats.toolResultsAged, 0);
  assert.equal(called, false);
  assert.equal(after, before);
});

test("smart aging emits a deterministic summary only for safe bulky replay", () => {
  const value = `start\n${"repeated healthy row\n".repeat(8_000)}end`;
  const input = [
    call("safe-bulk", "exec_command", JSON.stringify({ cmd: "npm test" })),
    output("safe-bulk", value),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const first = ageToolResults(input, { frontier: 0, retain: retained });
  const second = ageToolResults(input, { frontier: 0, retain: retained });
  assert.equal(first.stats.toolResultsAged, 1);
  assert.equal(second.input[1].output, first.input[1].output);
  assert.match(first.input[1].output, /Deterministic summary:/);
  assert.match(first.input[1].output, /policy=SUMMARIZE reason=repetitive-observational-log/);
  assert.doesNotMatch(first.input[1].output, /tool-result-aging retrieve|\.\/bin\/control/iu);
});

test("keeps the newest four result items byte-for-byte intact", () => {
  const value = "x".repeat(40_000);
  const input = Array.from({ length: 4 }, (_, index) => [
    call(`call-${index}`),
    output(`call-${index}`, value),
    { type: "message", role: "assistant", content: "acted" },
  ]).flat();

  const result = ageToolResults(input);
  assert.equal(result.input, input);
  assert.equal(result.stats.toolResultsAged, 0);
});

test("keeps an unconsumed result even when it is outside a zero-sized frontier", () => {
  const input = [call("pending"), output("pending", "x".repeat(40_000))];
  const result = ageToolResults(input, { frontier: 0, retain: retained });
  assert.equal(result.input, input);
});

test("retains exact bytes once, retrieves idempotently, and binds call provenance", () => {
  const bytes = Buffer.from(
    `exact tool result with unicode 😀\n${"large retained source\n".repeat(2_000)}`,
    "utf8",
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  const metadata = {
    expectedDigest: digest,
    callId: "call-exact",
    outputType: "function_call_output",
    context: toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro"),
  };
  const first = retainToolResult(bytes, metadata);
  realStoreFixture = { bytes, first, metadata };
  const second = retainToolResult(bytes, metadata);
  assert.deepEqual(second, first);
  assert.deepEqual(
    retrieveToolResult(
      first.handle,
      digest,
      bytes.length,
      metadata.callId,
      metadata.outputType,
      metadata.context,
    ),
    bytes,
  );
  assert.deepEqual(
    retrieveToolResultByDigest(
      digest,
      bytes.length,
      metadata.callId,
      metadata.outputType,
      metadata.context,
    ),
    bytes,
  );
  assert.throws(
    () => retrieveToolResult(
      first.handle,
      digest,
      bytes.length,
      "another-call",
      metadata.outputType,
      metadata.context,
    ),
    /retrieval failed/,
  );
  assert.throws(
    () => retrieveToolResult(
      first.handle,
      digest,
      bytes.length,
      metadata.callId,
      metadata.outputType,
      toolResultRetentionContext("routed", "grok-api/grok-4.5"),
    ),
    /retrieval failed/,
  );
  assert.throws(
    () => retrieveToolResult(
      first.handle,
      "0".repeat(64),
      bytes.length,
      metadata.callId,
      metadata.outputType,
      metadata.context,
    ),
    /retrieval failed/,
  );
  assert.throws(
    () => retrieveToolResult(
      first.handle,
      digest,
      bytes.length + 1,
      metadata.callId,
      metadata.outputType,
      metadata.context,
    ),
    /retrieval failed/,
  );
  const input = [
    call(metadata.callId),
    output(metadata.callId, bytes.toString("utf8")),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const aged = ageToolResults(input, {
    frontier: 0,
    retain: retainToolResult,
    retentionContext: metadata.context,
  });
  assert.equal(aged.stats.toolResultsAged, 1, "the real retention store permits rewriting");
  assert.match(aged.input[1].output, new RegExp(digest));
  const resultFiles = readdirSync(TOOL_RESULT_RETENTION_DIR)
    .filter((name) => name.endsWith(".result"));
  assert.equal(resultFiles.length, 1, "same source replay reuses one retained blob");
  if (process.platform !== "win32") {
    assert.equal(statSync(path.join(TOOL_RESULT_RETENTION_DIR, resultFiles[0])).mode & 0o777, 0o600);
    assert.equal(statSync(TOOL_RESULT_RETENTION_DIR).mode & 0o777, 0o700);
  }
});

test("retention capacity never evicts an existing receipt", () => {
  const second = Buffer.from("second result");
  const secondDigest = createHash("sha256").update(second).digest("hex");
  retainToolResult(second, {
    expectedDigest: secondDigest,
    callId: "call-second",
    outputType: "function_call_output",
    context: toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro"),
  });
  const third = Buffer.from("third result");
  const thirdDigest = createHash("sha256").update(third).digest("hex");
  assert.throws(
    () => retainToolResult(third, {
      expectedDigest: thirdDigest,
      callId: "call-third",
      outputType: "function_call_output",
      context: toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro"),
    }),
    /retention is full|retain the exact tool result safely/,
  );
  assert.equal(
    readdirSync(TOOL_RESULT_RETENTION_DIR).filter((name) => name.endsWith(".result")).length,
    2,
  );
  const large = "capacity-row\n".repeat(4_000);
  const input = [
    call("call-capacity"),
    output("call-capacity", large),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const aged = ageToolResults(input, {
    frontier: 0,
    retain: retainToolResult,
    retentionContext: toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro"),
  });
  assert.equal(aged.input, input);
  assert.equal(aged.stats.toolResultRetentionFailures, 1);
  assert.equal(aged.stats.toolResultRetentionDegradedReason, "capacity");
});

test("unprotected corrupt retained content passes the original and reports sanitized degradation", { skip: process.platform === "win32" }, () => {
  assert.ok(realStoreFixture);
  const target = path.join(TOOL_RESULT_RETENTION_DIR, `${realStoreFixture.first.handle}.result`);
  writeFileSync(target, Buffer.alloc(realStoreFixture.bytes.length, 0x7a), { mode: 0o600 });
  chmodSync(target, 0o644);
  const value = realStoreFixture.bytes.toString("utf8");
  const input = [
    call(realStoreFixture.metadata.callId),
    output(realStoreFixture.metadata.callId, value),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const aged = ageToolResults(input, {
    frontier: 0,
    retain: retainToolResult,
    retentionContext: realStoreFixture.metadata.context,
  });
  assert.equal(aged.input, input);
  assert.equal(aged.input[1].output, value);
  assert.equal(aged.stats.toolResultRetentionFailures, 1);
  assert.equal(aged.stats.toolResultRetentionDegradedReason, "storage");
});

test("does not rewrite image-bearing or mixed output parts", () => {
  const input = [
    call("image", "view_image"),
    {
      type: "function_call_output",
      call_id: "image",
      output: [
        { type: "input_text", text: "x".repeat(40_000) },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    },
    { type: "message", role: "assistant", content: "acted" },
  ];
  const result = ageToolResults(input, { frontier: 0, retain: retained });
  assert.equal(result.input, input);
});

test("can be disabled without copying or changing the input", () => {
  const input = [
    call("old"),
    output("old", "x".repeat(40_000)),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const result = ageToolResults(input, { enabled: false, frontier: 0 });
  assert.equal(result.input, input);
  assert.deepEqual(result.stats, {
    toolResultsAged: 0,
    toolResultBytesBefore: 0,
    toolResultBytesAfter: 0,
    toolResultBytesSaved: 0,
  });
});

test("does not split surrogate pairs at either preview boundary", () => {
  const value = `${"q".repeat(1_023)}😀\n${"z\n".repeat(20_000)}😀${"y".repeat(1_023)}`;
  const input = [
    call("old"),
    output("old", value),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const result = ageToolResults(input, { frontier: 0, retain: retained });
  assert.doesNotMatch(result.input[1].output, /�/);
  // Each emoji straddles a preview boundary, so the safe slice omits both
  // complete pairs instead of emitting either half as U+FFFD.
  assert.equal((result.input[1].output.match(/😀/gu) || []).length, 0);
});

// The failure this instrumentation exists for: a session that spends its whole
// context on results which each sit under the floor reported the same empty
// stats as a pass that never ran, so an operator could not tell an ineffective
// feature from an unloaded one.
test("a pass that ages nothing still reports what it evaluated and the largest result it saw", () => {
  const input = [
    ...Array.from({ length: 12 }, (_, index) => [
      call(`mid-${index}`),
      output(`mid-${index}`, "x".repeat(12_000)),
      { type: "message", role: "assistant", content: `read ${index}` },
    ]).flat(),
  ];
  const { stats, input: unchanged } = ageToolResults(input);
  assert.equal(stats.toolResultsAged, 0);
  assert.equal(stats.toolResultsEvaluated, 8, "the four newest results stay protected");
  assert.equal(stats.toolResultBytesLargest, 12_000);
  assert.equal(unchanged, input, "nothing qualified, so the input is passed through by reference");
});

test("a disabled pass stays distinguishable from one that ran and found nothing", () => {
  const input = [call("a"), output("a", "x".repeat(12_000))];
  const off = ageToolResults(input, { enabled: false });
  assert.equal(off.stats.toolResultsEvaluated, undefined);
  assert.equal(off.stats.toolResultBytesLargest, undefined);
  const on = ageToolResults(input);
  assert.equal(on.stats.toolResultsEvaluated, 0, "every result here sits inside the frontier");
});
