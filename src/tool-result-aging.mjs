import { createHash } from "node:crypto";

// Tool results are replayed on every following turn. A single large command
// output can therefore cost its full size many times after the model has
// already acted on it. Keep the policy deliberately narrow: only old, textual
// results above this floor qualify, and the newest result frontier always stays
// byte-for-byte intact.
export const TOOL_RESULT_AGING_MIN_BYTES = 32 * 1024;
export const TOOL_RESULT_AGING_FRONTIER = 4;

const PREVIEW_CODE_UNITS = 1_024;
const OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const EXACT_OUTPUT_TOOL = /(?:^|[_-])(?:apply[_-]?patch|edit|write|read|view|save|download|export|schema|source|resource|web|browser|fetch)(?:$|[_-])/iu;
const CRITICAL_OUTPUT = /\b(?:error|warn(?:ing)?s?|fatal|exception|traceback|panic|failed|failure|denied|invalid|corrupt|mismatch|non[- ]zero exit|exit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*[=:]?\s*[1-9]\d*)\b/iu;
const EXACT_TEXT = /(?:sha(?:256|512)\s*:|\b[0-9a-f]{64}\b|^diff --git\s|^@@\s|^\*\*\* (?:Begin|End) Patch)/imu;
const AUTHORITY_TEXT = /\b(?:approval|authorize|authority|goal|handoff|task|credential|secret|token)\b/iu;
const OBSERVATIONAL_COMMAND = /^(?:npm\s+(?:test|run\s+(?:test|check|build))|node\s+--test|cargo\s+(?:test|build|check)|dotnet\s+(?:test|build)|cmake\s+--build|docker\s+logs)(?:\s|$)/iu;
// Smart aging needs only a tiny observational subset. Any expansion, quoting,
// escaping, globbing, redirection, grouping, or platform shell metacharacter
// makes a command ambiguous and therefore KEEP.
const SHELL_CONTROL = /[\r\n;&|`><$\\'"*?\[\]{}()!#~%^]/u;
const MUTATING_OBSERVATION_FLAG = /(?:^|\s)(?:-delete|-exec(?:dir)?|-ok(?:dir)?|--update[-_]?snapshot|--bless|--fix|--write|-u)(?=\s|=|$)/iu;
const MODEL_ACTION_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "reasoning",
]);

function modelActed(item) {
  if (MODEL_ACTION_TYPES.has(item?.type)) return true;
  return item?.type === "message" && item.role === "assistant";
}

function textualOutput(item) {
  if (!OUTPUT_TYPES.has(item?.type)) return undefined;
  if (typeof item.output === "string") return item.output;
  if (!Array.isArray(item.output)) return undefined;
  const text = [];
  for (const part of item.output) {
    if (
      !part ||
      typeof part !== "object" ||
      !["input_text", "text"].includes(part.type) ||
      typeof part.text !== "string"
    ) {
      return undefined;
    }
    text.push(part.text);
  }
  return text.join("");
}

function safeHead(value) {
  let end = Math.min(value.length, PREVIEW_CODE_UNITS);
  if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

function safeTail(value) {
  let start = Math.max(0, value.length - PREVIEW_CODE_UNITS);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start])) start += 1;
  return value.slice(start);
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function likelyStructured(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {}
  }
  if (/^(?:<\?xml\b|<[A-Za-z][^>]*>)/u.test(trimmed)) return true;
  const rows = value.split(/\r?\n/u, 65).filter((line) => line.trim()).slice(0, 64);
  if (rows.length < 8) return false;
  if (rows.slice(0, 16).every((row) => {
    try {
      const parsed = JSON.parse(row);
      return parsed !== null && typeof parsed === "object";
    } catch {
      return false;
    }
  })) return true;
  return ["\t", ",", "|"].some((delimiter) => {
    const counts = rows.map((row) => row.split(delimiter).length - 1);
    return counts[0] >= 2 && counts.every((count) => count === counts[0]);
  });
}

function parsedObject(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function observationalToolCall(call) {
  if (call.type === "function_call" && call.name === "exec_command") {
    const args = parsedObject(call.arguments);
    if (typeof args?.cmd !== "string") return false;
    const command = args.cmd.trim();
    return (
      OBSERVATIONAL_COMMAND.test(command) &&
      !SHELL_CONTROL.test(command) &&
      !MUTATING_OBSERVATION_FLAG.test(command)
    );
  }
  // These are explicit observational contracts. Arbitrary custom tools remain
  // KEEP because their input schema does not prove that the output is a log.
  if (
    call.type === "function_call" &&
    ["poll_status", "list_status", "build_log", "test_log", "install_log"].includes(call.name)
  ) {
    return parsedObject(call.arguments) !== undefined;
  }
  return false;
}

function deterministicRepetitionSummary(value, call) {
  if (
    !observationalToolCall(call) ||
    EXACT_OUTPUT_TOOL.test(call.name) ||
    CRITICAL_OUTPUT.test(value) ||
    EXACT_TEXT.test(value) ||
    AUTHORITY_TEXT.test(value) ||
    likelyStructured(value) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  ) {
    return undefined;
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  let lineCount = 0;
  let start = 0;
  while (start <= value.length) {
    const newline = value.indexOf("\n", start);
    const end = newline === -1 ? value.length : newline;
    const raw = value.slice(start, end);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (Buffer.byteLength(line, "utf8") > 16_384) return undefined;
    lineCount += 1;
    if (newline === -1) break;
    start = newline + 1;
  }
  if (lineCount < 8) return undefined;
  const sampleCount = Math.min(lineCount, 8_192);
  const targets = Array.from({ length: sampleCount }, (_, sample) =>
    sampleCount === 1
      ? 0
      : Math.floor((sample * (lineCount - 1)) / (sampleCount - 1)));
  const counts = new Map();
  let mostRepeated = 0;
  let lineIndex = 0;
  let targetIndex = 0;
  start = 0;
  while (targetIndex < targets.length && start <= value.length) {
    const newline = value.indexOf("\n", start);
    const end = newline === -1 ? value.length : newline;
    if (lineIndex === targets[targetIndex]) {
      const raw = value.slice(start, end);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const lineBytes = Buffer.byteLength(line, "utf8");
      const key = lineBytes > 256
        ? `sha256:${createHash("sha256").update(line, "utf8").digest("hex")}`
        : line;
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count > mostRepeated) mostRepeated = count;
      targetIndex += 1;
    }
    if (newline === -1) break;
    start = newline + 1;
    lineIndex += 1;
  }
  const repetition = sampleCount ? mostRepeated / sampleCount : 0;
  // Default-on aging is intentionally conservative: uncertainty preserves the
  // full output. Only demonstrably repetitive payloads are compacted.
  if (repetition < 0.8) return undefined;
  return {
    text: [
      `policy=SUMMARIZE reason=repetitive-observational-log tool=${call.name}.`,
      `${lineCount} lines and ${byteLength} UTF-8 bytes.`,
      `${sampleCount} source-ordered lines sampled; ${counts.size} distinct; most common ${Math.round(repetition * 100)}%.`,
      "No warning or error lines were omitted because such output is kept full by policy.",
    ].join(" "),
  };
}

function resultReceipt(value, summary, bytes, digest) {
  const head = safeHead(value);
  const tail = safeTail(value);
  const middle = value.slice(head.length, value.length - tail.length);
  const omittedBytes = Buffer.byteLength(middle, "utf8");
  const omittedNewlines = (middle.match(/\n/gu) || []).length;
  return [
    `[Older tool result smart summary v2 after the model acted on it: ${bytes} bytes, sha256:${digest}.`,
    `Deterministic summary: ${summary.text}`,
    `Omitted middle: ${omittedBytes} UTF-8 bytes across ${omittedNewlines} newline boundaries.`,
    "The exact original text bytes were retained owner-privately before this receipt was created.",
    `Owner-local exact note: sha256:${digest}. No path, command, or retrieval capability is sent to the model.`,
    "Retrieval is byte-identical and fails closed unless its owner-private capability, digest, and length all match.]",
    "",
    "--- beginning of original result ---",
    head,
    "--- omitted middle of original result ---",
    tail,
    "--- end of original result ---",
  ].join("\n");
}

export function ageToolResults(
  input,
  {
    enabled = true,
    minBytes = TOOL_RESULT_AGING_MIN_BYTES,
    frontier = TOOL_RESULT_AGING_FRONTIER,
    retain,
    retentionContext,
  } = {},
) {
  const empty = {
    toolResultsAged: 0,
    toolResultBytesBefore: 0,
    toolResultBytesAfter: 0,
    toolResultBytesSaved: 0,
  };
  // A disabled pass reports nothing beyond the zeroed counters, so "off" stays
  // distinguishable from "on and nothing qualified" -- two states this used to
  // report identically, leaving no way to prove the pass had run at all.
  if (!enabled || !Array.isArray(input)) return { input, stats: empty };

  const outputIndexes = [];
  const actedAfter = new Array(input.length).fill(false);
  let laterModelAction = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    actedAfter[index] = laterModelAction;
    if (modelActed(input[index])) laterModelAction = true;
  }
  for (let index = 0; index < input.length; index += 1) {
    if (OUTPUT_TYPES.has(input[index]?.type)) outputIndexes.push(index);
  }
  const protectedIndexes = new Set(
    frontier > 0 ? outputIndexes.slice(-Math.max(0, frontier)) : [],
  );
  const callsById = new Map();
  const outputsById = new Map();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (typeof item?.call_id !== "string") continue;
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      const entries = callsById.get(item.call_id) || [];
      entries.push({
        index,
        type: item.type,
        name: item.name,
        arguments: item.arguments,
        input: item.input,
      });
      callsById.set(item.call_id, entries);
    } else if (OUTPUT_TYPES.has(item.type)) {
      const entries = outputsById.get(item.call_id) || [];
      entries.push({ index, type: item.type });
      outputsById.set(item.call_id, entries);
    }
  }
  let changed = false;
  let toolResultsAged = 0;
  let toolResultBytesBefore = 0;
  let toolResultBytesAfter = 0;
  let toolResultRetentionFailures = 0;
  let toolResultRetentionDegradedReason;
  // What the pass looked at, recorded whether or not anything qualified. A
  // session can spend its whole context on results that each sit under the
  // floor, and without these the outcome is indistinguishable from the pass
  // never running. The largest result seen says which it was: compare it
  // against minBytes.
  let toolResultsEvaluated = 0;
  let toolResultBytesLargest = 0;
  const replacements = new Map();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (protectedIndexes.has(index)) continue;
    const value = textualOutput(item);
    if (value === undefined) continue;
    if (hasUnpairedSurrogate(value)) continue;
    const size = Buffer.byteLength(value, "utf8");
    toolResultsEvaluated += 1;
    if (size > toolResultBytesLargest) toolResultBytesLargest = size;
    if (size <= minBytes) continue;
    if (
      item.type === "function_call_output" &&
      item.status !== undefined &&
      item.status !== "completed"
    ) {
      continue;
    }
    const expectedCallType = item.type === "custom_tool_call_output"
      ? "custom_tool_call"
      : "function_call";
    const calls = callsById.get(item.call_id) || [];
    const outputs = outputsById.get(item.call_id) || [];
    if (
      calls.length !== 1 ||
      calls[0].type !== expectedCallType ||
      calls[0].index >= index ||
      outputs.length !== 1 ||
      outputs[0].index !== index
    ) {
      continue;
    }
    // A later result alone does not prove the model saw this one. A later
    // model-authored message, reasoning item, or tool call does.
    if (!actedAfter[index]) continue;
    const summary = deterministicRepetitionSummary(value, calls[0]);
    if (!summary) continue;
    const digest = createHash("sha256").update(value, "utf8").digest("hex");
    const receipt = resultReceipt(value, summary, size, digest);
    // Decide whether the smart summary is worthwhile before retaining. This
    // avoids a durable unreferenced blob when a Unicode-heavy preview cannot
    // meet the minimum 80% savings gate.
    const before = size;
    const after = Buffer.byteLength(receipt, "utf8");
    if (after >= before * 0.2) continue;
    // Retention is synchronous and verified before the routed copy is ever
    // rewritten. A missing store, full disk, ACL failure, or failed read-back
    // therefore preserves the original item byte-for-byte by reference.
    if (typeof retain !== "function") continue;
    let retained;
    try {
      retained = retain(Buffer.from(value, "utf8"), {
        expectedDigest: digest,
        callId: item.call_id,
        outputType: item.type,
        context: retentionContext,
      });
    } catch (error) {
      toolResultRetentionFailures += 1;
      toolResultRetentionDegradedReason = error?.retentionReason === "capacity"
        ? "capacity"
        : "storage";
      continue;
    }
    if (
      !retained ||
      !/^[A-Za-z0-9_-]{43}$/u.test(retained.handle) ||
      retained.digest !== digest ||
      retained.byteLength !== size
    ) {
      toolResultRetentionFailures += 1;
      toolResultRetentionDegradedReason = "storage";
      continue;
    }
    const rewritten = { ...item, output: receipt };
    // Count model-visible text rather than serializing the whole item again.
    // The request path will serialize once later; avoiding a second copy here
    // matters when the result itself is hundreds of megabytes.
    changed = true;
    toolResultsAged += 1;
    toolResultBytesBefore += before;
    toolResultBytesAfter += after;
    replacements.set(index, rewritten);
  }
  const next = changed
    ? input.map((item, index) => replacements.get(index) ?? item)
    : input;
  const toolResultBytesSaved = toolResultBytesBefore - toolResultBytesAfter;
  return {
    input: next,
    stats: {
      toolResultsAged,
      toolResultBytesBefore,
      toolResultBytesAfter,
      toolResultBytesSaved,
      toolResultsEvaluated,
      toolResultBytesLargest,
      ...(toolResultRetentionFailures > 0
        ? {
            toolResultRetentionFailures,
            toolResultRetentionDegradedReason,
            toolResultRetentionHealthy: false,
          }
        : toolResultsAged > 0
        ? { toolResultRetentionHealthy: true }
        : {}),
    },
  };
}
