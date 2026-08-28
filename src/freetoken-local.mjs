export const FREETOKEN_PROVIDER_ID = "freetoken";
export const FREETOKEN_BASE_URL = "http://127.0.0.1:1919/v1";
export const FREETOKEN_HEALTH_URL = "http://127.0.0.1:1919/health";
export const FREETOKEN_MODEL_ID = "Qwen3.8-Flash-Next-NVFP4-7b719225";
export const FREETOKEN_CONTEXT_WINDOW = 65_792;
export const FREETOKEN_AUTO_COMPACT = 65_536;
export const FREETOKEN_MAX_OUTPUT_TOKENS = 255;

const READINESS_TIMEOUT_MS = 3_000;

function localError(message, status = 503, type = "local_model_unavailable") {
  const error = new Error(message);
  error.status = status;
  error.type = type;
  error.provider = FREETOKEN_PROVIDER_ID;
  return error;
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function requireFlashNextReady({
  fetchImpl = fetch,
  signal,
  timeoutMs = READINESS_TIMEOUT_MS,
} = {}) {
  let response;
  try {
    response = await fetchImpl(FREETOKEN_HEALTH_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: combinedSignal(signal, timeoutMs),
    });
  } catch {
    throw localError(
      "Qwen3.8 Flash Next (Local) is unavailable. Start the owner-managed FreeToken server and wait for /health to report serving.",
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (
    !response.ok ||
    payload?.status !== "ok" ||
    payload?.maintenance !== "serving" ||
    payload?.model !== FREETOKEN_MODEL_ID
  ) {
    throw localError(
      "Qwen3.8 Flash Next (Local) is not ready or reports the wrong model. Start the owner-managed FreeToken server and wait for the exact /health identity to report serving.",
    );
  }
  return payload;
}

export function normalizeFlashNextOutputLimit(payload) {
  const fields = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
  const supplied = fields.filter((field) => payload[field] !== undefined);
  for (const field of supplied) {
    if (
      !Number.isInteger(payload[field]) ||
      payload[field] < 1 ||
      payload[field] > FREETOKEN_MAX_OUTPUT_TOKENS
    ) {
      throw localError(
        `Qwen3.8 Flash Next (Local) requires ${field} to be an integer from 1 to ${FREETOKEN_MAX_OUTPUT_TOKENS}.`,
        400,
        "local_model_output_limit",
      );
    }
  }
  if (supplied.length > 1) {
    throw localError(
      "Qwen3.8 Flash Next (Local) accepts only one output-token limit field.",
      400,
      "local_model_output_limit",
    );
  }
  if (supplied.length === 0) payload.max_tokens = FREETOKEN_MAX_OUTPUT_TOKENS;
  if (supplied[0] === "max_output_tokens") {
    payload.max_tokens = payload.max_output_tokens;
    delete payload.max_output_tokens;
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
