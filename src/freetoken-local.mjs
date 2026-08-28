export const FREETOKEN_PROVIDER_ID = "freetoken";
export const FREETOKEN_BASE_URL = "http://127.0.0.1:1919/v1";
export const FREETOKEN_MODEL_ID = "Qwen3.8-Flash-Next-NVFP4-FP8-344f3a68";
export const FREETOKEN_CONTEXT_WINDOW = 65_792;
export const FREETOKEN_AUTO_COMPACT = 56_000;

const READINESS_TIMEOUT_MS = 5_000;
const ROUTER_COMPACTION_PREFIX = "kcr1:";

function localError(message, status = 503, type = "local_model_unavailable") {
  const error = new Error(message);
  error.status = status;
  error.type = type;
  error.provider = FREETOKEN_PROVIDER_ID;
  return error;
}

function readinessUrls(baseUrl) {
  const base = new URL(baseUrl);
  const origin = base.origin;
  return {
    health: `${origin}/health`,
    models: `${baseUrl}/models`,
    cache: `${baseUrl}/cache/status`,
  };
}

async function jsonGet(fetchImpl, url, signal) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch {
    throw localError(
      "Qwen3.8 Flash Next (Local) is unavailable. Start the owner-managed FreeToken server and wait for its readiness endpoints to report serving.",
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return { ok: response.ok, payload };
}

export async function requireFlashNextReady({
  fetchImpl = fetch,
  signal,
  timeoutMs = READINESS_TIMEOUT_MS,
} = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const readySignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const urls = readinessUrls(FREETOKEN_BASE_URL);

  const health = await jsonGet(fetchImpl, urls.health, readySignal);
  if (
    !health.ok ||
    health.payload?.status !== "ok" ||
    health.payload?.maintenance !== "serving"
  ) {
    throw localError(
      "Qwen3.8 Flash Next (Local) is not ready. Wait for /health to report status=ok and maintenance=serving.",
    );
  }

  const [models, cache] = await Promise.all([
    jsonGet(fetchImpl, urls.models, readySignal),
    jsonGet(fetchImpl, urls.cache, readySignal),
  ]);
  const exactModel = Array.isArray(models.payload?.data)
    ? models.payload.data.find((model) => model?.id === FREETOKEN_MODEL_ID)
    : undefined;
  if (
    !models.ok ||
    exactModel?.context_length !== FREETOKEN_CONTEXT_WINDOW ||
    exactModel?.max_model_len !== FREETOKEN_CONTEXT_WINDOW ||
    !cache.ok ||
    cache.payload?.state !== "serving"
  ) {
    throw localError(
      "Qwen3.8 Flash Next (Local) reports the wrong model, context, or cache state. Wait for /v1/models and /v1/cache/status to match the configured endpoint contract.",
    );
  }

  return {
    health: health.payload,
    model: exactModel,
    cache: cache.payload,
  };
}

function routerCompactionSummary(value) {
  if (typeof value !== "string" || !value.startsWith(ROUTER_COMPACTION_PREFIX)) return undefined;
  const encoded = value.slice(ROUTER_COMPACTION_PREFIX.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return undefined;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return undefined;
  try {
    const summary = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return summary.trim() ? summary : undefined;
  } catch {
    return undefined;
  }
}

export function assertFlashNextInputCompatible(input) {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (item?.type === "context_compaction") {
      throw localError(
        "Qwen3.8 Flash Next (Local) cannot resume context_compaction history. Start a new task or use an un-compacted conversation.",
        409,
        "local_model_compaction_incompatible",
      );
    }
    if (
      item?.type === "compaction" &&
      routerCompactionSummary(item.encrypted_content) === undefined
    ) {
      throw localError(
        "Qwen3.8 Flash Next (Local) cannot resume this compacted history because it is not a readable router summary. Start a new task or use an un-compacted conversation.",
        409,
        "local_model_compaction_incompatible",
      );
    }
  }
}

export function normalizeFlashNextInput(input) {
  assertFlashNextInputCompatible(input);
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (item?.type !== "compaction") return item;
    const summary = routerCompactionSummary(item.encrypted_content);
    return {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `[Earlier conversation summary from Codex Router]\n\n${summary}`,
      }],
    };
  });
}

export function normalizeFlashNextReasoning(payload, route) {
  const fromResponses = payload.reasoning?.effort;
  const effort = fromResponses ?? payload.reasoning_effort;
  if (effort !== undefined && !["off", "low", "medium", "xhigh"].includes(effort)) {
    throw localError(
      "Qwen3.8 Flash Next (Local) reasoning effort must be off, low, medium, or xhigh.",
      400,
      "local_model_reasoning_effort",
    );
  }
  if (route === "/responses") {
    delete payload.reasoning_effort;
    if (effort !== undefined) payload.reasoning = { ...(payload.reasoning || {}), effort };
  } else {
    delete payload.reasoning;
    if (effort !== undefined) payload.reasoning_effort = effort;
  }
  return payload;
}

let serialTail = Promise.resolve();

export function runFlashNextSerial(task) {
  const result = serialTail.then(task, task);
  serialTail = result.catch(() => undefined);
  return result;
}

export function dispatchFlashNext(task, readinessOptions = {}) {
  return runFlashNextSerial(async () => {
    await requireFlashNextReady(readinessOptions);
    return task();
  });
}
