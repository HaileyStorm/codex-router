import assert from "node:assert/strict";
import test from "node:test";

import {
  beginNousTransport,
  markNousTransport,
  safeNousTransportFailure,
  wrapNousTransportError,
} from "../src/nous-transport-diagnostics.mjs";

const ATTEMPT_ID = "a".repeat(64);

function socketFailure(message = "provider body must never cross the boundary") {
  const error = new TypeError(message);
  error.status = 503;
  error.cause = Object.assign(new Error("other side closed: private provider text"), {
    code: "UND_ERR_SOCKET",
  });
  return error;
}

test("Nous transport diagnostics are authenticated snapshots, not spoofable error fields", () => {
  const request = {};
  beginNousTransport(request, ATTEMPT_ID);
  markNousTransport(request, "agent_relay_body", {
    cache_eligible: false,
    cache_hit: false,
  });

  const wrapped = wrapNousTransportError(request, socketFailure());
  assert.equal(wrapped.status, 400);

  const safe = safeNousTransportFailure(wrapped);
  assert.ok(safe);
  assert.equal(safe.type, "local_nous_transport_failure");
  assert.equal(safe.phase, "agent_relay_body");
  assert.equal(safe.attempt_id, ATTEMPT_ID);
  assert.equal(safe.transport_code, "UND_ERR_SOCKET");
  assert.equal(safe.original_status, 503);
  assert.equal(safe.provider_contact_possible, false);
  assert.equal(safe.retryable, false);
  assert.equal(safe.cache_eligible, false);
  assert.equal(safe.cache_hit, false);
  assert.match(safe.message, /native task-message relay/);
  assert.doesNotMatch(JSON.stringify(safe), /private provider text|provider body/);

  // A caller can mutate the returned JSON object, but that must not mutate the
  // authenticated snapshot retained by the WeakMap.
  safe.phase = "gateway_headers";
  safe.transport_code = "forged";
  safe.provider_contact_possible = true;
  const reread = safeNousTransportFailure(wrapped);
  assert.equal(reread.phase, "agent_relay_body");
  assert.equal(reread.transport_code, "UND_ERR_SOCKET");
  assert.equal(reread.provider_contact_possible, false);

  // Matching marker properties on an unrelated error are not credentials.
  const forged = Object.assign(new Error("forged"), {
    type: "local_nous_transport_failure",
    phase: "gateway_headers",
    attempt_id: ATTEMPT_ID,
    transport_code: "UND_ERR_SOCKET",
  });
  assert.equal(safeNousTransportFailure(forged), undefined);

  // Mutating the wrapped Error's public fields cannot rewrite its private
  // diagnostic snapshot either.
  wrapped.type = "local_nous_transport_failure";
  wrapped.code = "UND_ERR_SOCKET";
  wrapped.message = "forged raw provider body";
  assert.equal(safeNousTransportFailure(wrapped).message.includes("forged"), false);
});

test("Nous transport diagnostics preserve relay status and distinguish gateway contact", () => {
  const relayRequest = {};
  beginNousTransport(relayRequest, "b".repeat(64));
  markNousTransport(relayRequest, "agent_relay_status", { upstream_status: 401 });
  const relay = safeNousTransportFailure(
    wrapNousTransportError(relayRequest, Object.assign(new Error("provider body"), { status: 401 })),
  );
  assert.equal(relay.phase, "agent_relay_status");
  assert.equal(relay.upstream_status, 401);
  assert.equal(relay.original_status, 401);
  assert.equal(relay.provider_contact_possible, false);
  assert.equal(relay.transport_code, "OTHER");

  const gatewayRequest = {};
  beginNousTransport(gatewayRequest, "c".repeat(64));
  markNousTransport(gatewayRequest, "gateway_headers");
  const gateway = safeNousTransportFailure(
    wrapNousTransportError(gatewayRequest, socketFailure("gateway body must stay local")),
  );
  assert.equal(gateway.phase, "gateway_headers");
  assert.equal(gateway.provider_contact_possible, true);
  assert.equal(gateway.transport_code, "UND_ERR_SOCKET");
  assert.match(gateway.message, /gateway connection failed/);
  assert.doesNotMatch(JSON.stringify(gateway), /gateway body must stay local/);
});

test("unbegun or invalid requests keep raw errors out of the trusted snapshot path", () => {
  const error = socketFailure("raw private message");
  assert.equal(wrapNousTransportError({}, error), error);
  assert.equal(safeNousTransportFailure(error), undefined);

  const invalidRequest = {};
  beginNousTransport(invalidRequest, "not-a-64-byte-attempt");
  markNousTransport(invalidRequest, "agent_relay_body");
  const wrapped = wrapNousTransportError(invalidRequest, error);
  assert.equal(wrapped, error);
  assert.equal(safeNousTransportFailure(wrapped), undefined);
});
