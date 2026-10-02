import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { nativeObservation, readObserverConfig, invokeObserver,
  captureNativeRequest, completeNativeRequest } from "../src/native-harness-observer.mjs";

const thread = "11111111-1111-4111-8111-111111111111";
const turn = "22222222-2222-4222-8222-222222222222";
const root = "33333333-3333-4333-8333-333333333333";
const request = (turnFields = { thread_id: thread, turn_id: turn, root_turn_id: root }) =>
  ({ headers: { "x-codex-turn-metadata": JSON.stringify({ turn: turnFields }), "session_id": thread } });
const payload = { model: "gpt-6.1-sol", reasoning: { effort: "high" },
  instructions: "PRIVATE INSTRUCTIONS", input: [{ role: "user", content: "PRIVATE CONTENT" }] };

test("exact actual turn identity is required and root ID cannot substitute", () => {
  assert.equal(nativeObservation(request(), payload, "123", "request-1").turn_id, turn);
  assert.equal(nativeObservation(request({ thread_id: thread, root_turn_id: root }), payload, "123"), undefined);
  assert.equal(nativeObservation(request(), { ...payload, client_metadata: { turn_id: root } }, "123"), undefined);
  assert.equal(nativeObservation({ headers: { "x-codex-turn-metadata": "invalid" } }, payload, "123"), undefined);
  assert.equal(nativeObservation({ rawHeaders: ["session_id", thread, "session_id", root,
    "x-codex-turn-metadata", JSON.stringify({ turn: { thread_id: root, turn_id: turn } })] }, payload, "123"), undefined);
});

test("native observation preserves request bytes and sends metadata only", async () => {
  const before = JSON.stringify(payload);
  const sent = [];
  const observation = await captureNativeRequest(request(), payload, "987654321", {
    config: {}, invoke: async (...args) => { sent.push(args); return { status: "baselineCaptured" }; },
  });
  assert.equal(JSON.stringify(payload), before);
  assert.equal(observation.packet.observed_at_monotonic_ns, "987654321");
  assert.equal(sent[0][1], "capture-auto");
  assert.deepEqual(Object.keys(sent[0][2]).sort(), ["effort", "model", "observed_at_monotonic_ns", "request_id", "thread_id", "turn_id"]);
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE/);
});

test("completion counters keep missing distinct from explicit zero", async () => {
  const sent = [];
  const observation = { config: {}, packet: nativeObservation(request(), payload, "1", "request-1") };
  const invoke = async (...args) => { sent.push(args); return {}; };
  await completeNativeRequest(observation, { inputTokens: 10, outputTokens: 2 }, { invoke });
  assert.deepEqual(sent[0][2].usage, { input_tokens: 10, output_tokens: 2 });
  await completeNativeRequest(observation, { cachedInputTokens: 0, cacheWriteInputTokens: NaN }, { invoke });
  assert.deepEqual(sent[1][2].usage, { cached_input_tokens: 0 });
  assert.equal(sent[1][2].request_id, "request-1");
});

test("observer stays disabled without exact opted-in runtime and code hashes", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "harness-observer-"));
  try {
    const script = path.join(directory, "client.py");
    const python = path.join(directory, "python.fixture");
    const config = path.join(directory, "observer.json");
    writeFileSync(script, "source"); writeFileSync(python, "python");
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    const value = { schema_version: 1, enabled: true, client: script, python,
      state_directory: directory, client_sha256: hash("source"), python_sha256: hash("python") };
    writeFileSync(config, JSON.stringify(value));
    assert.equal(readObserverConfig(config), undefined);
    writeFileSync(path.join(directory, "endpoint-fixture.json"), "{}");
    assert.deepEqual(readObserverConfig(config), value);
    writeFileSync(script, "changed");
    assert.equal(readObserverConfig(config), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("helper uses isolated Python, quiet argv launch, bounded metadata stdin", async () => {
  const config = { python: path.resolve("python.exe"), client: path.resolve("relay.py"), state_directory: path.resolve("state") };
  const packet = nativeObservation(request(), payload, "123", "request-1");
  let actual;
  const launch = (exe, args, options) => {
    actual = { exe, args, options, stdin: "" };
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on("data", (chunk) => { actual.stdin += chunk; });
    child.stdin.on("finish", () => { child.stdout.write('{"status":"captured"}'); child.emit("close", 0); });
    return child;
  };
  assert.deepEqual(await invokeObserver(config, "capture-auto", packet, launch), { status: "captured" });
  assert.equal(actual.options.windowsHide, true);
  assert.deepEqual(actual.args, ["-I", config.client, "capture-auto", config.state_directory]);
  assert.deepEqual(JSON.parse(actual.stdin), packet);
  assert.doesNotMatch(actual.stdin, /PRIVATE/);
});
