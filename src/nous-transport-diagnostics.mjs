const requests = new WeakMap();
const failures = new WeakMap();
const PHASES = new Set([
  "admitted", "normalization", "agent_relay_headers", "agent_relay_status",
  "agent_relay_body", "agent_relay_validate", "vision", "request_serialization",
  "gateway_headers", "gateway_error_body", "gateway_body",
]);
const CODES = new Set([
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT",
  "ENOTFOUND", "EAI_AGAIN", "ERR_NATIVE_RELAY_RESPONSE_TOO_LARGE",
]);

export function beginNousTransport(request, attemptId) {
  if (!request || typeof request !== "object" || !/^[a-f0-9]{64}$/.test(attemptId || "")) return;
  requests.set(request, { attempt_id: attemptId, phase: "admitted", startedAt: Date.now() });
}

export function markNousTransport(request, phase, details = {}) {
  const context = requests.get(request);
  if (!context || !PHASES.has(phase)) return;
  context.phase = phase;
  if (phase === "agent_relay_headers" || phase === "gateway_headers" ||
      (!phase.startsWith("agent_relay_") && !phase.startsWith("gateway_"))) {
    delete context.upstream_status;
  }
  for (const field of ["cache_eligible", "cache_hit"]) {
    if (typeof details[field] === "boolean") context[field] = details[field];
  }
  if (Number.isInteger(details.upstream_status) && details.upstream_status >= 100 && details.upstream_status <= 599) {
    context.upstream_status = details.upstream_status;
  } else if (phase === "gateway_headers") {
    delete context.upstream_status;
  }
}

function snapshot(request) {
  const context = requests.get(request);
  if (!context) return undefined;
  const { startedAt, ...fields } = context;
  return { ...fields, at: new Date().toISOString(), elapsed_ms: Math.max(0, Date.now() - startedAt) };
}

function errorCode(error) {
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth += 1) {
    if (CODES.has(current.code)) return current.code;
  }
  return "OTHER";
}

export function wrapNousTransportError(request, error) {
  const context = snapshot(request);
  if (!context) return error;
  const relay = context.phase.startsWith("agent_relay_");
  const mayHaveContacted = context.phase.startsWith("gateway_");
  const message = relay
    ? "The native task-message relay could not complete its response. Nous was not contacted; this request will not be retried."
    : mayHaveContacted
      ? "The Nous gateway connection failed. Its outcome may be uncertain; this request will not be replayed."
      : "The router could not prepare this Nous request. Nous was not contacted; this request will not be retried.";
  const originalStatus = typeof error?.status === "number" ? error.status : 502;
  const details = Object.freeze({
    ...context,
    type: "local_nous_transport_failure",
    message,
    retryable: false,
    provider_contact_possible: mayHaveContacted,
    original_status: Number.isInteger(originalStatus) && originalStatus >= 400 && originalStatus <= 599 ? originalStatus : 502,
    transport_code: errorCode(error),
  });
  const wrapped = new Error(message);
  wrapped.status = 400;
  // Never attach the untrusted cause/body or trust marker properties on errors.
  failures.set(wrapped, details);
  return wrapped;
}

export function safeNousTransportFailure(error) {
  const details = failures.get(error);
  return details ? { ...details } : undefined;
}

export function logNousTransportEvent(request, event, { errorType } = {}) {
  if (!["admission_rejected", "client_disconnected"].includes(event)) return;
  const details = snapshot(request);
  if (!details) return;
  const allowedType = ["local_nous_attempt_already_admitted", "local_nous_attempt_record_unavailable"].includes(errorType)
    ? errorType : undefined;
  console.error(`[codex-router] nous_transport ${JSON.stringify({ ...details, event, ...(allowedType ? { error_type: allowedType } : {}) })}`);
}
