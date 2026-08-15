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

function resultReceipt(value, toolName) {
  const bytes = Buffer.byteLength(value, "utf8");
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  const recovery = toolName
    ? `Repeat the preceding ${toolName} call with the same arguments`
    : "Repeat the preceding tool call with the same arguments";
  return [
    `[Older tool result compacted by Codex Router after the model acted on it: ${bytes} bytes, sha256:${digest}.`,
    `${recovery} if exact or omitted content is needed. The original result remains in Codex; only this routed copy was compacted.]`,
    "",
    "--- beginning of original result ---",
    safeHead(value),
    "--- omitted middle of original result ---",
    safeTail(value),
    "--- end of original result ---",
  ].join("\n");
}

function callNames(input) {
  const names = new Map();
  for (const item of input) {
    if (
      ["function_call", "custom_tool_call"].includes(item?.type) &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      names.set(item.call_id, item.name);
    }
  }
  return names;
}

export function ageToolResults(
  input,
  {
    enabled = true,
    minBytes = TOOL_RESULT_AGING_MIN_BYTES,
    frontier = TOOL_RESULT_AGING_FRONTIER,
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
  const protectedIndexes = new Set(outputIndexes.slice(-Math.max(0, frontier)));
  const names = callNames(input);
  let changed = false;
  let toolResultsAged = 0;
  let toolResultBytesBefore = 0;
  let toolResultBytesAfter = 0;
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
    const size = Buffer.byteLength(value, "utf8");
    toolResultsEvaluated += 1;
    if (size > toolResultBytesLargest) toolResultBytesLargest = size;
    if (size <= minBytes) continue;
    // A later result alone does not prove the model saw this one. A later
    // model-authored message, reasoning item, or tool call does.
    if (!actedAfter[index]) continue;
    const receipt = resultReceipt(value, names.get(item.call_id));
    const rewritten = { ...item, output: receipt };
    // Count model-visible text rather than serializing the whole item again.
    // The request path will serialize once later; avoiding a second copy here
    // matters when the result itself is hundreds of megabytes.
    const before = size;
    const after = Buffer.byteLength(receipt, "utf8");
    if (after >= before) continue;
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
    },
  };
}
