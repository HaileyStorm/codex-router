import assert from "node:assert/strict";
import test from "node:test";

import {
  FREETOKEN_AUTO_COMPACT,
  FREETOKEN_BASE_URL,
  FREETOKEN_CONTEXT_WINDOW,
  FREETOKEN_MODEL_ID,
  assertFlashNextInputCompatible,
  dispatchFlashNext,
  normalizeFlashNextInput,
  normalizeFlashNextReasoning,
  requireFlashNextReady,
  runFlashNextSerial,
} from "../src/freetoken-local.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const READY = Object.freeze({
  health: { status: "ok", maintenance: "serving" },
  models: {
    object: "list",
    data: [{
      id: FREETOKEN_MODEL_ID,
      context_length: FREETOKEN_CONTEXT_WINDOW,
      max_model_len: FREETOKEN_CONTEXT_WINDOW,
    }],
  },
  cache: { state: "serving" },
});

function readinessFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, authorization: options.headers.Authorization });
    const key = url.endsWith("/health")
      ? "health"
      : url.endsWith("/v1/models")
        ? "models"
        : url.endsWith("/v1/cache/status")
          ? "cache"
          : undefined;
    if (!key) throw new Error(`unexpected URL ${url}`);
    const value = overrides[key] ?? READY[key];
    if (value === "network-error") throw new Error("connection refused");
    if (value instanceof Response) return value;
    return jsonResponse(value);
  };
  return { calls, fetchImpl };
}

test("Flash-Next readiness requires fresh health, model geometry, and cache identity", async () => {
  const { calls, fetchImpl } = readinessFetch();
  const payload = await requireFlashNextReady({ fetchImpl });
  assert.equal(payload.model.id, FREETOKEN_MODEL_ID);
  assert.equal(payload.model.context_length, 65_792);
  assert.equal(payload.cache.state, "serving");
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:1919/health", method: "GET", authorization: undefined },
    { url: "http://127.0.0.1:1919/v1/models", method: "GET", authorization: undefined },
    { url: "http://127.0.0.1:1919/v1/cache/status", method: "GET", authorization: undefined },
  ]);
  assert.equal(FREETOKEN_AUTO_COMPACT, 56_000);
});

test("Flash-Next fails closed before dispatch on every readiness mismatch", async () => {
  const cases = [
    { health: { status: "ok", maintenance: "loading" } },
    { models: { data: [{ ...READY.models.data[0], id: "another-model" }] } },
    { models: { data: [{ ...READY.models.data[0], context_length: 65_791 }] } },
    { models: { data: [{ ...READY.models.data[0], max_model_len: 65_791 }] } },
    { cache: { state: "rebuilding" } },
    { models: { data: {} } },
    { models: new Response("not-json", { status: 200 }) },
    { cache: jsonResponse({ state: "serving" }, 503) },
    { health: "network-error" },
  ];
  for (const fixture of cases) {
    const { fetchImpl } = readinessFetch(fixture);
    let dispatched = false;
    await assert.rejects(
      dispatchFlashNext(
        async () => {
          dispatched = true;
        },
        { fetchImpl },
      ),
      (error) =>
        error.status === 503 &&
        error.type === "local_model_unavailable" &&
        error.provider === "freetoken",
    );
    assert.equal(dispatched, false, "no generation dispatch occurs after failed readiness");
  }
});

test("Flash-Next rejects incompatible compacted history before dispatch", () => {
  const compatible = [
    {
      type: "compaction",
      encrypted_content: `kcr1:${Buffer.from("readable summary", "utf8").toString("base64")}`,
    },
  ];
  assert.doesNotThrow(() => assertFlashNextInputCompatible(compatible));
  const normalized = normalizeFlashNextInput(compatible);
  assert.deepEqual(normalized[0], {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: "[Earlier conversation summary from Codex Router]\n\nreadable summary",
    }],
  });
  for (const input of [
    [{ type: "context_compaction", encrypted_content: "anything" }],
    [{ type: "compaction", encrypted_content: "opaque-provider-summary" }],
    [{ type: "compaction", encrypted_content: "kcr1:not-base64" }],
    [{ type: "compaction", encrypted_content: "kcr1://8=" }],
    [{ type: "compaction", encrypted_content: "kcr1:" }],
    [{
      type: "compaction",
      encrypted_content: `kcr1:${Buffer.from(" \n\t", "utf8").toString("base64")}`,
    }],
  ]) {
    assert.throws(
      () => assertFlashNextInputCompatible(input),
      (error) => error.status === 409 && error.type === "local_model_compaction_incompatible",
    );
  }
});

test("Flash-Next preserves only the advertised effort ladder on both API surfaces", () => {
  assert.deepEqual(
    normalizeFlashNextReasoning({ reasoning: { effort: "xhigh", summary: "auto" } }, "/responses"),
    { reasoning: { effort: "xhigh", summary: "auto" } },
  );
  assert.deepEqual(
    normalizeFlashNextReasoning({ reasoning: { effort: "low" } }, "/chat/completions"),
    { reasoning_effort: "low" },
  );
  assert.deepEqual(
    normalizeFlashNextReasoning({ reasoning_effort: "off" }, "/responses"),
    { reasoning: { effort: "off" } },
  );
  assert.throws(
    () => normalizeFlashNextReasoning({ reasoning_effort: "high" }, "/chat/completions"),
    (error) => error.status === 400 && error.type === "local_model_reasoning_effort",
  );
});

test("Flash-Next production endpoint is the fixed owner loopback URL", () => {
  assert.equal(FREETOKEN_BASE_URL, "http://127.0.0.1:1919/v1");
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

test("Flash-Next lane drops an aborted waiter and releases after the active task", async () => {
  let releaseActive;
  let activeStarted;
  const activeStartedPromise = new Promise((resolve) => {
    activeStarted = resolve;
  });
  const activeGate = new Promise((resolve) => {
    releaseActive = resolve;
  });
  const readyFetch = async (url, { signal }) => {
    signal?.throwIfAborted();
    if (url.endsWith("/health")) return jsonResponse(READY.health);
    if (url.endsWith("/v1/models")) return jsonResponse(READY.models);
    return jsonResponse(READY.cache);
  };
  const first = dispatchFlashNext(async () => {
    activeStarted();
    await activeGate;
    return "first";
  }, { fetchImpl: readyFetch });
  await activeStartedPromise;

  const aborter = new AbortController();
  let queuedGeneration = false;
  let queuedReadinessFetches = 0;
  const second = dispatchFlashNext(
    async () => {
      queuedGeneration = true;
    },
    {
      signal: aborter.signal,
      fetchImpl: async (url, options) => {
        options.signal.throwIfAborted();
        queuedReadinessFetches += 1;
        return readyFetch(url, options);
      },
    },
  );
  aborter.abort();
  releaseActive();
  assert.equal(await first, "first");
  await assert.rejects(second, (error) => error.type === "local_model_unavailable");
  assert.equal(queuedReadinessFetches, 0);
  assert.equal(queuedGeneration, false);

  const third = await dispatchFlashNext(async () => "third", { fetchImpl: readyFetch });
  assert.equal(third, "third", "the lane remained usable after the aborted waiter");
});
