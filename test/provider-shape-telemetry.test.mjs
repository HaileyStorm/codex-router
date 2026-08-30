import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProviderShapeTelemetry,
  appendProviderShapeEvent,
  createProviderShapeTelemetry,
  providerShapeTelemetryStatus,
  providerToolShape,
} from "../src/provider-shape-telemetry.mjs";
import { privateFileIsProtected } from "../src/file-security.mjs";

const KEY = Buffer.alloc(32, 7);

test("provider tool shape is deterministic without persisting tool names", () => {
  const tools = [
    { type: "function", name: "view_image", parameters: { type: "object" } },
    { type: "x_search" },
    { type: "function", name: "exec_command" },
  ];
  const first = providerToolShape(tools, KEY);
  const reordered = providerToolShape([tools[2], tools[0], tools[1]], KEY);
  const changed = providerToolShape([...tools, { type: "web_search" }], KEY);
  assert.equal(first.toolCount, 3);
  assert.deepEqual(first, reordered);
  assert.notEqual(first.toolNameDigest, changed.toolNameDigest);
  assert.match(first.toolNameDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /view_image|exec_command|x_search/);
});

test("provider shape telemetry records bounded item types and terminal state", () => {
  const telemetry = new ProviderShapeTelemetry({
    provider: "grok-oauth",
    model: "grok-4.6",
    tools: [{ type: "function", name: "view_image" }],
    key: KEY,
    requestId: "00000000-0000-4000-8000-000000000001",
    at: Date.parse("2026-08-30T00:00:00Z"),
  });
  telemetry.noteAttempt();
  telemetry.noteEvent({
    type: "response.output_item.added",
    item: { id: "fc_1", call_id: "call_1", type: "function_call", name: "view_image" },
  });
  telemetry.noteEvent({
    type: "response.output_item.done",
    item: { call_id: "call_1", type: "function_call", name: "view_image" },
  });
  telemetry.noteEvent({
    type: "response.output_item.done",
    item: { id: "secret_1", type: "provider_private_future_type" },
  });
  telemetry.noteParserError();
  telemetry.noteEvent({ type: "response.completed", response: { output: [] } });
  const event = telemetry.finish({ status: 200 });
  assert.deepEqual(event.responseOutputItemTypeCounts, {
    function_call: 1,
    unknown: 1,
  });
  assert.equal(event.responseCompleted, true);
  assert.equal(event.terminal, "completed");
  assert.equal(event.upstreamAttempts, 1);
  assert.equal(event.parserErrors, 1);
  assert.doesNotMatch(
    JSON.stringify(event),
    /view_image|secret_1|provider_private_future_type/,
  );
  assert.equal(telemetry.finish({ status: 200 }), undefined);
});

test("provider shape telemetry deduplicates disjoint item ids by output index", () => {
  const telemetry = new ProviderShapeTelemetry({
    provider: "grok-oauth",
    model: "grok-4.6",
    tools: [],
    key: KEY,
    at: 0,
  });
  telemetry.noteEvent({
    type: "response.output_item.added",
    output_index: 3,
    item: { id: "item-only", type: "function_call" },
  });
  telemetry.noteEvent({
    type: "response.output_item.done",
    output_index: 3,
    item: { call_id: "call-only", type: "function_call" },
  });
  const event = telemetry.finish({ status: 200, terminal: "completed" });
  assert.deepEqual(event.responseOutputItemTypeCounts, { function_call: 1 });
  assert.doesNotMatch(JSON.stringify(event), /item-only|call-only/);
});

test("provider shape diagnostic appends a private sanitized record", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "provider-shape-"));
  const eventsPath = path.join(directory, "events.jsonl");
  try {
    const telemetry = new ProviderShapeTelemetry({
      provider: "grok-oauth",
      model: "grok-4.6",
      tools: [{ type: "function", name: "view_image" }],
      key: KEY,
    });
    telemetry.noteAttempt();
    const event = telemetry.finish({ status: 200, terminal: "incomplete" });
    assert.equal(appendProviderShapeEvent(event, { eventsPath }), true);
    const stored = readFileSync(eventsPath, "utf8");
    assert.match(stored, /"terminal":"incomplete"/);
    assert.doesNotMatch(stored, /view_image/);
    assert.equal(privateFileIsProtected(eventsPath), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("telemetry construction does not clear an append-capacity failure", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "provider-shape-capacity-"));
  const eventsPath = path.join(directory, "events.jsonl");
  try {
    writeFileSync(eventsPath, Buffer.alloc(4 * 1024 * 1024), { mode: 0o600 });
    assert.equal(appendProviderShapeEvent({ terminal: "incomplete" }, { eventsPath }), false);
    assert.deepEqual(providerShapeTelemetryStatus(), {
      enabled: true,
      healthy: false,
      reason: "capacity",
    });
    assert.ok(
      createProviderShapeTelemetry({
        provider: "grok-oauth",
        model: "grok-4.6",
        tools: [],
        key: KEY,
      }),
    );
    assert.deepEqual(providerShapeTelemetryStatus(), {
      enabled: true,
      healthy: false,
      reason: "capacity",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider shape telemetry can be disabled without creating a key", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "provider-shape-disabled-"));
  const keyPath = path.join(directory, "key");
  try {
    assert.equal(
      createProviderShapeTelemetry({
        provider: "grok-oauth",
        model: "grok-4.6",
        tools: [],
        keyPath,
        enabled: false,
      }),
      undefined,
    );
    assert.throws(() => readFileSync(keyPath));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
