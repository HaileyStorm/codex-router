import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";

export const NOUS_CHAT_ADAPTER = "nous-chat";
export const NOUS_MAX_OUTPUT_TOKENS = 131072;
export const NOUS_PROVIDER_ID = "nous";
export const NOUS_BASE_URL = "https://inference-api.nousresearch.com/v1";
export const NOUS_MODEL_SLUG = "nous/deepseek/deepseek-v4.1-flash";
export const NOUS_GATEWAY_MODEL = "nous-deepseek-v4-1-flash";
export const NOUS_UPSTREAM_MODEL = "deepseek/deepseek-v4.1-flash";
export const NOUS_REASONING_ENVELOPE_PREFIX = "cr-nous-r1:";
export const NOUS_UPSTREAM_TIMEOUT_MS = 1_200_000;
export const NOUS_CREDENTIAL_ENVIRONMENT_KEY = "NOUS_API_KEY";

const MAX_TOOL_CALLS = 16;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_REASONING_DETAILS_BYTES = 4 * 1024 * 1024;
const NOUS_REASONING_ENVELOPE_VERSION = 1;
const NOUS_REASONING_ENVELOPE_DOMAIN = "codex-router/nous-direct/reasoning-envelope";
const NOUS_REASONING_NONCE_BYTES = 12;
const NOUS_REASONING_TAG_BYTES = 16;
const TEXT_PART_TYPES = new Set(["input_text", "output_text", "text"]);
const DIRECT_ERROR_TYPE = "local_nous_direct_error";
// Only locally authored diagnostics may cross the HTTP boundary. Snapshot
// them now: neither a matching error code nor a later mutable message is trust.
const DIRECT_ERROR_DETAILS = new WeakMap();

function directError(message, { status = 400, code = "nous_direct_invalid_request" } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  DIRECT_ERROR_DETAILS.set(error, Object.freeze({
    status,
    type: DIRECT_ERROR_TYPE,
    message,
  }));
  return error;
}

export function safeNousDirectError(error) {
  const details = DIRECT_ERROR_DETAILS.get(error);
  return details ? { ...details } : undefined;
}

function internalKeyBytes(internalKey) {
  const bytes = Buffer.isBuffer(internalKey)
    ? internalKey
    : internalKey instanceof Uint8Array
      ? Buffer.from(internalKey)
      : typeof internalKey === "string"
        ? Buffer.from(internalKey, "utf8")
        : undefined;
  if (!bytes || bytes.length < 16) {
    throw directError("Nous Direct requires the host-local router internal key.", {
      status: 500,
      code: "nous_direct_internal_key_missing",
    });
  }
  return bytes;
}

function reasoningEnvelopeKey(internalKey) {
  return createHmac("sha256", internalKeyBytes(internalKey))
    .update(NOUS_REASONING_ENVELOPE_DOMAIN, "utf8")
    .digest();
}

function reasoningEnvelopeAad(model) {
  return Buffer.from(
    `${NOUS_REASONING_ENVELOPE_DOMAIN}\0${NOUS_REASONING_ENVELOPE_VERSION}\0${NOUS_PROVIDER_ID}\0${model}`,
    "utf8",
  );
}

function cloneReasoningDetails(details, label) {
  if (details === undefined || details === null) return undefined;
  if (!Array.isArray(details)) throw directError(`${label} reasoning_details must be an array.`);
  let cloned;
  try {
    cloned = structuredClone(details);
    const encoded = Buffer.from(JSON.stringify(cloned), "utf8");
    if (encoded.length > MAX_REASONING_DETAILS_BYTES) {
      throw directError(`${label} reasoning_details exceeds the local replay limit.`);
    }
  } catch (error) {
    if (error?.code === "nous_direct_invalid_request") throw error;
    throw directError(`${label} reasoning_details is not replayable.`);
  }
  return cloned;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function reasoningDetailsEqual(left, right) {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

export function isNousReasoningEnvelope(value) {
  return typeof value === "string" && value.startsWith(NOUS_REASONING_ENVELOPE_PREFIX);
}

export function createNousReasoningEnvelope({ internalKey, model, text, details } = {}) {
  if (typeof model !== "string" || !model) {
    throw directError("Nous Direct reasoning envelope has no model binding.");
  }
  if (typeof text !== "string" || !text) {
    throw directError("Nous Direct reasoning envelope has no replayable text.");
  }
  const clonedDetails = cloneReasoningDetails(details, "Nous Direct envelope");
  const plaintext = Buffer.from(JSON.stringify({
    version: NOUS_REASONING_ENVELOPE_VERSION,
    provider: NOUS_PROVIDER_ID,
    model,
    text,
    details: clonedDetails ?? null,
  }), "utf8");
  const nonce = randomBytes(NOUS_REASONING_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", reasoningEnvelopeKey(internalKey), nonce);
  cipher.setAAD(reasoningEnvelopeAad(model));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${NOUS_REASONING_ENVELOPE_PREFIX}${Buffer.concat([nonce, tag, ciphertext]).toString("base64url")}`;
}

export function decodeNousReasoningEnvelope(
  value,
  { internalKey, expectedModel, visibleText, visibleDetails } = {},
) {
  if (value === undefined || value === null) return undefined;
  if (!isNousReasoningEnvelope(value)) {
    throw directError("Nous Direct cannot replay foreign reasoning encrypted_content.");
  }
  if (typeof expectedModel !== "string" || !expectedModel) {
    throw directError("Nous Direct cannot validate an unbound reasoning envelope.");
  }
  const encoded = value.slice(NOUS_REASONING_ENVELOPE_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw directError("Nous Direct reasoning envelope is malformed.");
  }
  let packed;
  try {
    packed = Buffer.from(encoded, "base64url");
  } catch {
    throw directError("Nous Direct reasoning envelope is malformed.");
  }
  if (packed.toString("base64url") !== encoded || packed.length <= NOUS_REASONING_NONCE_BYTES + NOUS_REASONING_TAG_BYTES) {
    throw directError("Nous Direct reasoning envelope is malformed.");
  }
  const nonce = packed.subarray(0, NOUS_REASONING_NONCE_BYTES);
  const tag = packed.subarray(NOUS_REASONING_NONCE_BYTES, NOUS_REASONING_NONCE_BYTES + NOUS_REASONING_TAG_BYTES);
  const ciphertext = packed.subarray(NOUS_REASONING_NONCE_BYTES + NOUS_REASONING_TAG_BYTES);
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", reasoningEnvelopeKey(internalKey), nonce);
    decipher.setAuthTag(tag);
    decipher.setAAD(reasoningEnvelopeAad(expectedModel));
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw directError("Nous Direct reasoning envelope authentication failed.");
  }
  let decoded;
  try {
    decoded = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw directError("Nous Direct reasoning envelope is not valid JSON.");
  }
  if (
    !decoded ||
    Array.isArray(decoded) ||
    decoded.version !== NOUS_REASONING_ENVELOPE_VERSION ||
    decoded.provider !== NOUS_PROVIDER_ID ||
    decoded.model !== expectedModel ||
    typeof decoded.text !== "string" ||
    !decoded.text
  ) {
    throw directError("Nous Direct reasoning envelope identity is invalid.");
  }
  const details = cloneReasoningDetails(decoded.details, "Nous Direct envelope");
  if (visibleText !== undefined && decoded.text !== visibleText) {
    throw directError("Nous Direct reasoning envelope disagrees with its visible summary.");
  }
  if (visibleDetails !== undefined && !reasoningDetailsEqual(details, visibleDetails)) {
    throw directError("Nous Direct reasoning envelope disagrees with its visible details.");
  }
  return { text: decoded.text, details };
}

function canonicalNousBaseUrl(value, label) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw directError(`Nous Direct ${label} base URL is invalid.`, { code: "nous_direct_binding" });
  }
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (
    url.protocol !== "https:" ||
    url.hostname !== "inference-api.nousresearch.com" ||
    pathname !== "/v1" ||
    url.search ||
    url.hash
  ) {
    throw directError(`Nous Direct ${label} base URL is not the exact Nous endpoint.`, {
      code: "nous_direct_binding",
    });
  }
  return `${url.origin}${pathname}`;
}

export function assertNousDirectBinding({ provider, model, baseUrl } = {}) {
  if (
    !provider ||
    provider.id !== NOUS_PROVIDER_ID ||
    provider.kind !== "openai-compatible" ||
    provider.protocol !== "openai-responses" ||
    provider.responseAdapter !== NOUS_CHAT_ADAPTER ||
    canonicalNousBaseUrl(provider.baseUrl, "registry") !== NOUS_BASE_URL
  ) {
    throw directError("Nous Direct provider metadata is not the exact registered Nous route.", {
      code: "nous_direct_binding",
    });
  }
  if (
    !model ||
    model.provider !== NOUS_PROVIDER_ID ||
    model.slug !== NOUS_MODEL_SLUG ||
    model.gatewayModel !== NOUS_GATEWAY_MODEL ||
    model.upstreamModel !== NOUS_UPSTREAM_MODEL
  ) {
    throw directError("Nous Direct model metadata is not the exact DeepSeek V4.1 route.", {
      code: "nous_direct_binding",
    });
  }
  const resolvedBaseUrl = canonicalNousBaseUrl(baseUrl, "resolved");
  if (resolvedBaseUrl !== NOUS_BASE_URL) {
    throw directError("Nous Direct resolved base URL is not the exact Nous endpoint.", {
      code: "nous_direct_binding",
    });
  }
  return resolvedBaseUrl;
}

export function assertNousDirectCredentialMetadata(provider) {
  const credential = provider?.credential;
  const forbiddenCredentialFields = [
    "file",
    "externalFile",
    "legacyFiles",
    "keychainServices",
    "cliSession",
  ];
  const exactEnvironment =
    Array.isArray(credential?.environment) &&
    credential.environment.length === 1 &&
    credential.environment[0] === NOUS_CREDENTIAL_ENVIRONMENT_KEY;
  if (
    !provider ||
    provider.id !== NOUS_PROVIDER_ID ||
    provider.kind !== "openai-compatible" ||
    provider.protocol !== "openai-responses" ||
    provider.responseAdapter !== NOUS_CHAT_ADAPTER ||
    !credential ||
    Array.isArray(credential) ||
    credential.environmentOnly !== true ||
    !exactEnvironment ||
    forbiddenCredentialFields.some((field) => credential[field] !== undefined)
  ) {
    throw directError(
      "Nous Direct requires an environment-only NOUS_API_KEY credential; file-backed or mistagged metadata is refused.",
      { code: "nous_direct_credential_binding" },
    );
  }
  return credential;
}

function contentText(content, label) {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) throw directError(`${label} content must be text.`);
  let text = "";
  for (const [index, part] of content.entries()) {
    if (!part || typeof part !== "object" || !TEXT_PART_TYPES.has(part.type) || typeof part.text !== "string") {
      throw directError(`${label} content[${index}] is not a supported text part.`);
    }
    text += part.text;
  }
  return text;
}

function reasoningText(item, index) {
  for (const [label, parts] of [["summary", item.summary], ["content", item.content]]) {
    if (!Array.isArray(parts) || !parts.length) continue;
    let text = "";
    for (const [partIndex, part] of parts.entries()) {
      if (!part || typeof part !== "object" || typeof part.text !== "string") {
        throw directError(`input[${index}] reasoning ${label}[${partIndex}] is not text.`);
      }
      text += part.text;
    }
    if (text) return text;
  }
  throw directError(`input[${index}] reasoning has no replayable text.`);
}

function reasoningDetails(item, index) {
  return cloneReasoningDetails(item.reasoning_details, `input[${index}]`);
}

function functionCall(item, index) {
  if (
    typeof item.call_id !== "string" ||
    !item.call_id ||
    typeof item.name !== "string" ||
    !item.name ||
    typeof item.arguments !== "string"
  ) {
    throw directError(`input[${index}] function_call is incomplete.`);
  }
  return {
    id: item.call_id,
    type: "function",
    function: { name: item.name, arguments: item.arguments },
  };
}

function claimCallIds(toolCalls, seenCallIds, label) {
  for (const call of toolCalls) {
    if (seenCallIds.has(call.id)) throw directError(`${label} repeats a function call id.`);
    seenCallIds.add(call.id);
  }
}

function inputItems(input) {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (!Array.isArray(input)) throw directError("Responses input must be a string or array.");
  return input;
}

export function responsesInputToNousMessages(input, instructions, { upstreamModel, internalKey } = {}) {
  const items = inputItems(input);
  const messages = [];
  if (instructions !== undefined) {
    if (typeof instructions !== "string") throw directError("Responses instructions must be text.");
    if (instructions) messages.push({ role: "system", content: instructions });
  }

  let pendingReasoning;
  let pendingReasoningDetails;
  let outstandingCallIds = [];
  const seenCallIds = new Set();
  let totalToolCalls = 0;
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw directError(`input[${index}] must be an object.`);
    }
    if (item.type === "reasoning") {
      if (outstandingCallIds.length) {
        throw directError(`input[${index}] reasoning is out of order.`);
      }
      const hasEncryptedContent = item.encrypted_content !== undefined;
      const ownEnvelope = isNousReasoningEnvelope(item.encrypted_content);
      let visibleText;
      try {
        visibleText = reasoningText(item, index);
      } catch (error) {
        if (hasEncryptedContent && !ownEnvelope) {
          throw directError(
            "Nous Direct cannot replay foreign reasoning without a readable summary; provide a fresh task packet.",
            { code: "nous_direct_foreign_reasoning_context" },
          );
        }
        throw error;
      }
      if (hasEncryptedContent && !ownEnvelope) {
        messages.push({ role: "assistant", content: visibleText });
        index += 1;
        continue;
      }
      const visibleDetails = reasoningDetails(item, index);
      const envelope = ownEnvelope
        ? decodeNousReasoningEnvelope(item.encrypted_content, {
          internalKey,
          expectedModel: upstreamModel,
          visibleText,
          visibleDetails,
        })
        : undefined;
      pendingReasoning = (pendingReasoning || "") + visibleText;
      const details = envelope?.details ?? visibleDetails;
      if (details !== undefined) {
        pendingReasoningDetails = pendingReasoningDetails === undefined
          ? details
          : [...pendingReasoningDetails, ...details];
      }
      index += 1;
      continue;
    }

    if (item.type === "function_call_output") {
      if (pendingReasoning !== undefined || outstandingCallIds.length === 0) {
        throw directError(`input[${index}] has an orphan function_call_output.`);
      }
      if (item.call_id !== outstandingCallIds[0]) {
        throw directError(`input[${index}] function_call_output is not in call order.`);
      }
      if (typeof item.output !== "string") {
        throw directError(`input[${index}] function_call_output must preserve a string result.`);
      }
      messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
      outstandingCallIds = outstandingCallIds.slice(1);
      index += 1;
      continue;
    }

    if (outstandingCallIds.length) {
      throw directError(`input[${index}] arrives before all prior tool results.`);
    }

    if (item.type === "function_call") {
      const toolCalls = [];
      while (index < items.length && items[index]?.type === "function_call") {
        toolCalls.push(functionCall(items[index], index));
        index += 1;
      }
      totalToolCalls += toolCalls.length;
      if (totalToolCalls > MAX_TOOL_CALLS) {
        throw directError(`input contains more than ${MAX_TOOL_CALLS} function calls.`);
      }
      claimCallIds(toolCalls, seenCallIds, `input[${index - toolCalls.length}]`);
      messages.push({
        role: "assistant",
        content: null,
        ...(pendingReasoning === undefined ? {} : { reasoning_content: pendingReasoning }),
        ...(pendingReasoningDetails === undefined ? {} : { reasoning_details: pendingReasoningDetails }),
        tool_calls: toolCalls,
      });
      pendingReasoning = undefined;
      pendingReasoningDetails = undefined;
      outstandingCallIds = toolCalls.map((call) => call.id);
      continue;
    }

    if (item.type !== "message") {
      throw directError(`input[${index}] has an unsupported item type.`);
    }
    if (!["system", "developer", "user", "assistant"].includes(item.role)) {
      throw directError(`input[${index}] has an unsupported message role.`);
    }
    if (item.role === "assistant" && item.tool_calls !== undefined) {
      throw directError(`input[${index}] assistant tool_calls must use function_call items.`);
    }
    const text = contentText(item.content, `input[${index}]`);
    if (item.role !== "assistant") {
      if (pendingReasoning !== undefined) {
        throw directError(`input[${index}] interrupts an assistant reasoning turn.`);
      }
      messages.push({ role: item.role === "developer" ? "system" : item.role, content: text });
      index += 1;
      continue;
    }

    const toolCalls = [];
    let callIndex = index + 1;
    while (callIndex < items.length && items[callIndex]?.type === "function_call") {
      toolCalls.push(functionCall(items[callIndex], callIndex));
      callIndex += 1;
    }
    totalToolCalls += toolCalls.length;
    if (totalToolCalls > MAX_TOOL_CALLS) {
      throw directError(`input contains more than ${MAX_TOOL_CALLS} function calls.`);
    }
    claimCallIds(toolCalls, seenCallIds, `input[${index}]`);
    messages.push({
      role: "assistant",
      content: text || null,
      ...(pendingReasoning === undefined ? {} : { reasoning_content: pendingReasoning }),
      ...(pendingReasoningDetails === undefined ? {} : { reasoning_details: pendingReasoningDetails }),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    pendingReasoning = undefined;
    pendingReasoningDetails = undefined;
    if (toolCalls.length) outstandingCallIds = toolCalls.map((call) => call.id);
    index = callIndex;
  }

  if (pendingReasoning !== undefined) {
    throw directError("Responses input ends with unattached reasoning.");
  }
  if (outstandingCallIds.length) {
    throw directError("Responses input ends before every tool call has an exact result.");
  }
  if (!messages.length) throw directError("Responses input is empty.");
  return messages;
}

function chatTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw directError("Responses tools must be an array.");
  const names = new Set();
  return tools.map((tool, index) => {
    if (!tool || tool.type !== "function" || typeof tool.name !== "string" || !tool.name) {
      throw directError(`tools[${index}] is not a flattened function tool.`);
    }
    if (names.has(tool.name)) throw directError(`tools[${index}] repeats a function name.`);
    names.add(tool.name);
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw directError(`tools[${index}] parameters must be an object schema.`);
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      throw directError(`tools[${index}] strict must be boolean when provided.`);
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: tool.parameters,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
    };
  });
}

function chatToolChoice(choice, toolNames) {
  if (choice === undefined) return undefined;
  if (["auto", "none", "required"].includes(choice)) return choice;
  if (choice && choice.type === "function" && typeof choice.name === "string" && choice.name) {
    if (!toolNames?.has(choice.name)) {
      throw directError("Nous Direct received a tool_choice for an undeclared function.");
    }
    return { type: "function", function: { name: choice.name } };
  }
  throw directError("Nous Direct received an unsupported tool_choice.");
}

function chatResponseFormat(payload) {
  let responsesFormat;
  if (payload.text !== undefined) {
    if (!payload.text || typeof payload.text !== "object" || Array.isArray(payload.text)) {
      throw directError("Nous Direct text must be an object.");
    }
    const fields = Object.keys(payload.text);
    if (fields.some((field) => field !== "format")) {
      throw directError("Nous Direct does not support the requested text controls.");
    }
    responsesFormat = payload.text.format;
  }
  if (payload.response_format !== undefined) {
    if (
      !payload.response_format ||
      typeof payload.response_format !== "object" ||
      Array.isArray(payload.response_format)
    ) {
      throw directError("Nous Direct response_format must be an object.");
    }
    if (responsesFormat !== undefined && !reasoningDetailsEqual(responsesFormat, payload.response_format)) {
      throw directError("Nous Direct received conflicting text.format and response_format.");
    }
    responsesFormat = payload.response_format;
  }
  if (responsesFormat === undefined) return undefined;
  if (!responsesFormat || typeof responsesFormat !== "object" || Array.isArray(responsesFormat)) {
    throw directError("Nous Direct structured output format must be an object.");
  }
  if (responsesFormat.type === "json_object") {
    if (Object.keys(responsesFormat).some((field) => field !== "type")) {
      throw directError("Nous Direct json_object format has unsupported fields.");
    }
    return { type: "json_object" };
  }
  if (responsesFormat.type === "text") {
    if (Object.keys(responsesFormat).some((field) => field !== "type")) {
      throw directError("Nous Direct text format has unsupported fields.");
    }
    return undefined;
  }
  if (responsesFormat.type === "json_schema") {
    throw directError("Nous Direct does not support json_schema structured output.");
  }
  throw directError("Nous Direct received an unsupported structured output format.");
}

export function toNousChatRequest(payload, upstreamModel, { internalKey } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw directError("Responses request must be an object.");
  }
  if (typeof upstreamModel !== "string" || !upstreamModel) {
    throw directError("Nous Direct has no exact upstream model binding.");
  }
  if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
    throw directError("Nous Direct stream must be boolean when provided.");
  }
  const effort = payload.reasoning?.effort ?? payload.reasoning_effort ?? "max";
  if (effort !== "max") throw directError("Nous Direct supports reasoning effort max only.");
  if (
    payload.max_output_tokens !== undefined &&
    (!Number.isInteger(payload.max_output_tokens) || payload.max_output_tokens <= 0)
  ) {
    throw directError("max_output_tokens must be a positive integer.");
  }
  const tools = chatTools(payload.tools);
  const toolNames = new Set(tools?.map((tool) => tool.function.name) || []);
  const toolChoice = chatToolChoice(payload.tool_choice, toolNames);
  if (toolChoice === "required" && !toolNames.size) {
    throw directError("Nous Direct requires a declared tool for tool_choice required.");
  }
  if (payload.parallel_tool_calls !== undefined && typeof payload.parallel_tool_calls !== "boolean") {
    throw directError("parallel_tool_calls must be boolean when provided.");
  }
  const responseFormat = chatResponseFormat(payload);
  return {
    model: upstreamModel,
    messages: responsesInputToNousMessages(payload.input, payload.instructions, {
      upstreamModel,
      internalKey,
    }),
    stream: false,
    reasoning_effort: "max",
    max_tokens: Math.min(payload.max_output_tokens ?? NOUS_MAX_OUTPUT_TOKENS, NOUS_MAX_OUTPUT_TOKENS),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    ...(payload.parallel_tool_calls === undefined
      ? {}
      : { parallel_tool_calls: payload.parallel_tool_calls }),
  };
}

function responseError(message, code = "nous_direct_invalid_response") {
  return directError(message, { status: 502, code });
}

function providerReasoningTexts(message) {
  let text;
  for (const field of ["reasoning_content", "reasoning"]) {
    const value = message[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") {
      throw responseError(`Nous Direct returned malformed ${field}.`);
    }
    if (text !== undefined && text !== value) {
      throw responseError("Nous Direct returned ambiguous plaintext reasoning fields.");
    }
    text = value;
  }
  let details;
  if (message.reasoning_details !== undefined && message.reasoning_details !== null) {
    try {
      details = cloneReasoningDetails(message.reasoning_details, "Nous Direct response");
    } catch (error) {
      throw responseError(error?.message || "Nous Direct returned non-replayable reasoning_details.");
    }
    if (text === undefined) {
      const detailText = details
        .map((part) => (part && typeof part.text === "string" ? part.text : ""))
        .join("");
      if (detailText) text = detailText;
    }
  }
  if (details !== undefined && !text) {
    throw responseError("Nous Direct returned reasoning_details without replayable text.");
  }
  return { texts: text ? [text] : [], details };
}

function parseCompletion(payload, model, { internalKey, toolNames } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw responseError("Nous Direct returned a non-object completion.");
  }
  if (!Array.isArray(payload.choices) || payload.choices.length !== 1) {
    throw responseError("Nous Direct returned an ambiguous completion choice set.");
  }
  if (payload.model !== model) {
    throw responseError("Nous Direct returned a different or missing model identity.");
  }
  const choice = payload.choices[0];
  if (choice?.index !== 0) {
    throw responseError("Nous Direct returned an invalid completion choice index.");
  }
  const message = choice?.message;
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    throw responseError("Nous Direct returned no assistant message.");
  }
  if (message.content !== null && message.content !== undefined && typeof message.content !== "string") {
    throw responseError("Nous Direct returned non-text assistant content.");
  }
  const content = message.content || "";
  const { texts: reasoningTexts, details: reasoningDetails } = providerReasoningTexts(message);
  const sourceCalls = message.tool_calls ?? [];
  if (!Array.isArray(sourceCalls) || sourceCalls.length > MAX_TOOL_CALLS) {
    throw responseError(`Nous Direct returned more than ${MAX_TOOL_CALLS} tool calls.`);
  }
  const allowedToolNames = toolNames === undefined ? undefined : new Set(toolNames);
  const seen = new Set();
  const toolCalls = sourceCalls.map((call, index) => {
    if (
      !call ||
      call.type !== "function" ||
      typeof call.id !== "string" ||
      !call.id ||
      typeof call.function?.name !== "string" ||
      !call.function.name ||
      typeof call.function?.arguments !== "string" ||
      seen.has(call.id)
    ) {
      throw responseError(`Nous Direct returned malformed tool_calls[${index}].`);
    }
    if (allowedToolNames !== undefined && !allowedToolNames.has(call.function.name)) {
      throw responseError("Nous Direct returned a tool name that was not requested.");
    }
    seen.add(call.id);
    return {
      id: `fc_${randomUUID().replaceAll("-", "")}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    };
  });
  const expectedFinishReason = toolCalls.length ? "tool_calls" : "stop";
  if (choice.finish_reason !== expectedFinishReason) {
    throw responseError("Nous Direct returned a nonterminal or inconsistent finish reason.");
  }
  if (!content && toolCalls.length === 0) {
    throw responseError("Nous Direct returned an empty completion.", "nous_direct_empty_completion");
  }

  const output = [];
  for (const reasoning of reasoningTexts) {
    let encryptedContent;
    if (internalKey !== undefined) {
      try {
        encryptedContent = createNousReasoningEnvelope({
          internalKey,
          model,
          text: reasoning,
          details: reasoningDetails,
        });
      } catch (error) {
        throw responseError(
          error?.message || "Nous Direct could not preserve provider reasoning.",
          "nous_direct_reasoning_envelope",
        );
      }
    } else if (reasoningDetails !== undefined) {
      throw responseError(
        "Nous Direct requires the host-local key to preserve provider reasoning details.",
        "nous_direct_reasoning_envelope",
      );
    }
    output.push({
      id: `rs_${randomUUID().replaceAll("-", "")}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoning }],
      ...(encryptedContent === undefined ? {} : { encrypted_content: encryptedContent }),
    });
  }
  if (content) {
    output.push({
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }],
    });
  }
  output.push(...toolCalls);
  const inputTokens = Number(payload.usage?.prompt_tokens);
  const outputTokens = Number(payload.usage?.completion_tokens);
  const usage = Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
    ? {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: Number.isFinite(Number(payload.usage?.total_tokens))
          ? Number(payload.usage.total_tokens)
          : inputTokens + outputTokens,
      }
    : null;
  return {
    id: typeof payload.id === "string" && payload.id ? payload.id : `resp_${randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Number.isInteger(payload.created) ? payload.created : Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage,
  };
}

function sseBlock(type, sequenceNumber, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...data })}\n\n`;
}

export function completionToResponsesBody(
  payload,
  model,
  stream = false,
  { internalKey, toolNames } = {},
) {
  const completed = parseCompletion(payload, model, { internalKey, toolNames });
  if (!stream) return { contentType: "application/json; charset=utf-8", body: JSON.stringify(completed) };

  let sequence = 0;
  const created = { ...completed, status: "in_progress", output: [], usage: null };
  let body = sseBlock("response.created", sequence++, { response: created });
  body += sseBlock("response.in_progress", sequence++, { response: created });
  for (const [outputIndex, item] of completed.output.entries()) {
    const addedItem = item.type === "function_call"
      ? { ...item, status: "in_progress", arguments: "" }
      : item.type === "message"
        ? { ...item, status: "in_progress", content: [] }
        : { ...item, status: "in_progress", summary: [] };
    body += sseBlock("response.output_item.added", sequence++, { output_index: outputIndex, item: addedItem });
    if (item.type === "message") {
      const text = item.content[0].text;
      body += sseBlock("response.output_text.delta", sequence++, {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        delta: text,
        logprobs: [],
      });
      body += sseBlock("response.output_text.done", sequence++, {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text,
        logprobs: [],
      });
    } else if (item.type === "function_call") {
      body += sseBlock("response.function_call_arguments.delta", sequence++, {
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
      body += sseBlock("response.function_call_arguments.done", sequence++, {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
    }
    body += sseBlock("response.output_item.done", sequence++, { output_index: outputIndex, item });
  }
  body += sseBlock("response.completed", sequence++, { response: completed });
  body += sseBlock("response.done", sequence++, { response: completed });
  body += "data: [DONE]\n\n";
  return { contentType: "text/event-stream; charset=utf-8", body };
}

function adaptedHeaders(upstreamHeaders, contentType) {
  const headers = new Headers(upstreamHeaders);
  for (const name of ["content-encoding", "content-length", "content-type", "transfer-encoding"]) {
    headers.delete(name);
  }
  headers.set("Content-Type", contentType);
  return headers;
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(NOUS_UPSTREAM_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function boundedResponseBytes(upstream) {
  const cancel = async () => {
    if (typeof upstream.body?.cancel === "function") {
      await upstream.body.cancel().catch(() => undefined);
    }
  };
  const contentLength = upstream.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      await cancel();
      throw responseError("Nous Direct returned an invalid content length.");
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_RESPONSE_BYTES) {
      await cancel();
      throw responseError("Nous Direct completion exceeded the local response limit.");
    }
  }
  if (!upstream.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of upstream.body) {
      if (!(chunk instanceof Uint8Array)) {
        throw responseError("Nous Direct returned a non-byte response chunk.");
      }
      if (chunk.byteLength > MAX_RESPONSE_BYTES - total) {
        throw responseError("Nous Direct completion exceeded the local response limit.");
      }
      total += chunk.byteLength;
      for (let offset = 0; offset < chunk.byteLength; offset += MAX_RESPONSE_CHUNK_BYTES) {
        const end = Math.min(offset + MAX_RESPONSE_CHUNK_BYTES, chunk.byteLength);
        chunks.push(Buffer.from(chunk.subarray(offset, end)));
      }
    }
  } catch (error) {
    await cancel();
    throw error;
  }
  return Buffer.concat(chunks, total);
}

export async function dispatchNousDirect({
  payload,
  model,
  provider,
  credential,
  baseUrl,
  internalKey,
  signal,
  fetchImpl = fetch,
}) {
  const resolvedBaseUrl = assertNousDirectBinding({ provider, model, baseUrl });
  internalKeyBytes(internalKey);
  if (typeof credential !== "string" || !credential) {
    throw directError("Nous Direct credential is missing.", {
      status: 503,
      code: "nous_direct_credential_missing",
    });
  }
  const chat = toNousChatRequest(payload, model.upstreamModel, { internalKey });
  const upstream = await fetchImpl(`${resolvedBaseUrl}/chat/completions`, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(chat),
    signal: requestSignal(signal),
  });
  if (!upstream.ok) return upstream;
  const bytes = await boundedResponseBytes(upstream);
  let completion;
  try {
    completion = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw responseError("Nous Direct returned invalid JSON.");
  }
  const adapted = completionToResponsesBody(completion, model.upstreamModel, payload.stream === true, {
    internalKey,
    toolNames: chat.tools?.map((tool) => tool.function.name) || [],
  });
  return new Response(adapted.body, {
    status: 200,
    headers: adaptedHeaders(upstream.headers, adapted.contentType),
  });
}
