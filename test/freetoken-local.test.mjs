import assert from "node:assert/strict";
import test from "node:test";

import {
  FREETOKEN_HEALTH_URL,
  FREETOKEN_MAX_OUTPUT_TOKENS,
  FREETOKEN_MODEL_ID,
  dispatchFlashNext,
  normalizeFlashNextOutputLimit,
  requireFlashNextReady,
  runFlashNextSerial,
} from "../src/freetoken-local.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Flash-Next readiness requires the exact loopback health identity", async () => {
  const calls = [];
  const payload = await requireFlashNextReady({
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return jsonResponse({
        status: "ok",
        maintenance: "serving",
        model: FREETOKEN_MODEL_ID,
      });
    },
  });
  assert.equal(payload.model, FREETOKEN_MODEL_ID);
  assert.deepEqual(calls, [{ url: FREETOKEN_HEALTH_URL, method: "GET" }]);
});

test("Flash-Next fails closed before dispatch on stopped, malformed, or wrong-model health", async () => {
  for (const response of [
    jsonResponse({ status: "ok", maintenance: "loading", model: FREETOKEN_MODEL_ID }),
    jsonResponse({ status: "ok", maintenance: "serving", model: "another-model" }),
    jsonResponse({ error: "unavailable" }, 503),
    new Response("not-json", { status: 200 }),
  ]) {
    let dispatched = false;
    await assert.rejects(
      dispatchFlashNext(
        async () => {
          dispatched = true;
        },
        { fetchImpl: async () => response },
      ),
      (error) =>
        error.status === 503 &&
        error.type === "local_model_unavailable" &&
        error.provider === "freetoken",
    );
    assert.equal(dispatched, false, "no alternate or chat dispatch occurs after failed health");
  }
});

test("Flash-Next clamps the accepted output envelope to 255 tokens", () => {
  assert.deepEqual(normalizeFlashNextOutputLimit({}), {
    max_tokens: FREETOKEN_MAX_OUTPUT_TOKENS,
  });
  assert.deepEqual(normalizeFlashNextOutputLimit({ max_tokens: 17 }), {
    max_tokens: 17,
  });
  assert.deepEqual(normalizeFlashNextOutputLimit({ max_output_tokens: 23 }), {
    max_tokens: 23,
  });
  for (const payload of [
    { max_tokens: 256 },
    { max_tokens: 0 },
    { max_tokens: 1.5 },
    { max_tokens: 1, max_completion_tokens: 1 },
  ]) {
    assert.throws(
      () => normalizeFlashNextOutputLimit(payload),
      (error) => error.status === 400 && error.type === "local_model_output_limit",
    );
  }
});

test("Flash-Next dispatch lane permits exactly one in-flight request", async () => {
  let active = 0;
  let maximum = 0;
  const order = [];
  const jobs = Array.from({ length: 4 }, (_, index) =>
    runFlashNextSerial(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(`start-${index}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end-${index}`);
      active -= 1;
    }),
  );
  await Promise.all(jobs);
  assert.equal(maximum, 1);
  assert.deepEqual(order, [
    "start-0", "end-0",
    "start-1", "end-1",
    "start-2", "end-2",
    "start-3", "end-3",
  ]);
});
