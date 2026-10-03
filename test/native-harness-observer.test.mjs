import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, realpathSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";
import { PassThrough } from "node:stream";
import { nativeObservation, readObserverConfig, invokeObserver,
  captureNativeRequest, completeNativeRequest } from "../src/native-harness-observer.mjs";
import { nativeProfile } from "../src/native-profiles.mjs";

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
  assert.deepEqual(Object.keys(sent[0][2]).sort(), ["effort", "model", "observed_at_monotonic_ns", "request_id", "thread_id", "turn_id", "wire_model"]);
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE/);
});

test("selected profile binds capture and completion while canonical wire bytes stay unchanged", async () => {
  const selected = "native-profile/gpt-6-astra-1m";
  const profile = nativeProfile(selected);
  const native = { ...payload, model: profile.nativeModel, reasoning: { effort: "xhigh" } };
  const before = JSON.stringify(native), profileBefore = JSON.stringify(profile);
  const sent = [];
  const invoke = async (config, operation, packet) => {
    // The running relay's strict target check stays unchanged.
    assert.equal(packet.model, selected);
    assert.equal(packet.wire_model, "gpt-6-astra");
    sent.push({ operation, packet });
    return { status: operation === "capture-auto" ? "baselineCaptured" : "usageCaptured" };
  };
  const observation = await captureNativeRequest(request(), native, "987654321", {
    config: {}, requestedModel: selected, invoke,
  });
  assert.equal(observation.status, "baselineCaptured");
  await completeNativeRequest(observation, { inputTokens: 42, cachedInputTokens: 0 }, { invoke });
  assert.deepEqual(sent.map((x) => x.operation), ["capture-auto", "completion-auto"]);
  assert.equal(sent[0].packet.request_id, sent[1].packet.request_id);
  assert.equal(JSON.stringify(native), before);
  assert.equal(JSON.stringify(profile), profileBefore);
  assert.equal(profile.contextWindow, 1_000_000);
  assert.equal(profile.autoCompact, 850_000);
});

test("base Astra stays base and only exact forward profile mappings qualify", () => {
  const native = { ...payload, model: "gpt-6-astra" };
  for (const selected of [undefined, "gpt-6-astra"]) {
    const packet = nativeObservation(request(), native, "1", "request-1", selected);
    assert.equal(packet.model, "gpt-6-astra");
    assert.equal(packet.wire_model, "gpt-6-astra");
  }
  for (const [selected, wire] of [
    ["native-profile/unknown", "gpt-6-astra"],
    ["native-profile/gpt-6-astra-1m", "gpt-6.1-sol"],
    ["native-profile/gpt-6-astra-1m", "native-profile/gpt-6-astra-1m"],
    ["gpt-6.1-sol", "gpt-6-astra"],
    [null, "gpt-6-astra"],
  ]) assert.equal(nativeObservation(request(), { ...native, model: wire }, "1", "request-1", selected), undefined);
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
    writeFileSync(script, "source", { mode: 0o600 }); writeFileSync(python, "python", { mode: 0o600 });
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    const value = { schema_version: 1, enabled: true, client: script, python,
      state_directory: directory, client_sha256: hash("source"), python_sha256: hash("python") };
    writeFileSync(config, JSON.stringify(value), { mode: 0o600 });
    assert.equal(readObserverConfig(config), undefined);
    writeFileSync(path.join(directory, "endpoint-fixture.json"), "{}", { mode: 0o600 });
    assert.deepEqual(readObserverConfig(config), value);
    writeFileSync(script, "changed");
    assert.equal(readObserverConfig(config), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function linuxFixture(t, source = "import json,sys; print(json.dumps({'status':'captured'}))") {
  const directory = mkdtempSync(path.join(tmpdir(), "harness-observer-linux-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = path.join(directory, "client.py"), filename = path.join(directory, "observer.json");
  const python = realpathSync("/usr/bin/python3");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  writeFileSync(client, source, { mode: 0o600 });
  writeFileSync(path.join(directory, "endpoint-fixture.json"), "{}", { mode: 0o600 });
  const value = { schema_version: 1, enabled: true, client, python, state_directory: directory,
    client_sha256: hash(source), python_sha256: hash(readFileSync(python)) };
  writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
  return { directory, client, filename, value, config: readObserverConfig(filename) };
}

test("Linux helper compiles verified bytes, pins interpreter and excludes inherited secrets", async (t) => {
  const fixture = linuxFixture(t);
  assert.ok(fixture.config);
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
  assert.deepEqual(await invokeObserver(fixture.config, "capture-auto", packet, launch), { status: "captured" });
  assert.equal(actual.exe, "/proc/self/fd/3");
  assert.deepEqual(actual.args.slice(0, 3), ["-I", "-B", "-c"]);
  assert.deepEqual(actual.args.slice(-3), [fixture.client, "capture-auto", fixture.directory]);
  assert.deepEqual(JSON.parse(actual.stdin).packet, packet);
  assert.doesNotMatch(actual.stdin, /PRIVATE/);
  assert.deepEqual(Object.keys(actual.options.env).sort(), ["LANG", "PATH"]);
  assert.equal(actual.options.stdio.length, 4);
});

test("real Linux helper executes retained verified bytes after client path replacement", async (t) => {
  const fixture = linuxFixture(t, "import json,os,sys; p=json.load(sys.stdin); assert os.getenv('NOUS_API_KEY') is None; assert p['model']=='gpt-6.1-sol'; print(json.dumps({'status':'captured'}))");
  assert.ok(fixture.config);
  writeFileSync(fixture.client, "raise RuntimeError('changed unpinned bytes must never execute')");
  const packet = nativeObservation(request(), payload, "123", "request-1");
  assert.deepEqual(await invokeObserver(fixture.config, "capture-auto", packet), { status: "captured" });
  assert.equal(readObserverConfig(fixture.filename), undefined);
});

test("Linux config rejects unprotected, linked and foreign-writable paths before launch", (t) => {
  const fixture = linuxFixture(t);
  chmodSync(fixture.filename, 0o644);
  assert.equal(readObserverConfig(fixture.filename), undefined);
  chmodSync(fixture.filename, 0o600);
  linkSync(fixture.client, path.join(fixture.directory, "hardlink.py"));
  assert.equal(readObserverConfig(fixture.filename), undefined);
  rmSync(path.join(fixture.directory, "hardlink.py"));
  const link = fixture.directory + "-link";
  symlinkSync(fixture.directory, link); t.after(() => rmSync(link));
  assert.equal(readObserverConfig(path.join(link, "observer.json")), undefined);
  chmodSync(fixture.directory, 0o770);
  assert.equal(readObserverConfig(fixture.filename), undefined);
});


test("actual router forwards selected Astra profile and exact wire usage to verified Linux helper", async (t) => {
  const source = [
    "import json,os,sys",
    "from pathlib import Path",
    "packet=json.load(sys.stdin)",
    "assert not any(k.endswith('_KEY') or 'TOKEN' in k or k.lower().endswith('_proxy') for k in os.environ)",
    "Path(sys.argv[2],sys.argv[1]+'.json').write_text(json.dumps(packet))",
    "print(json.dumps({'status':'baselineCaptured' if sys.argv[1]=='capture-auto' else 'usageCaptured'}))",
  ].join("\n");
  const fixture = linuxFixture(t, source);
  const configFile = path.join(fixture.directory, "harness-native-observer.json");
  writeFileSync(configFile, JSON.stringify(fixture.value), { mode: 0o600 });
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let bytes = ""; req.on("data", (chunk) => { bytes += chunk; });
    req.on("end", () => {
      seen.push(JSON.parse(bytes));
      const body = JSON.stringify({ id: "fixture-response", object: "response", status: "completed", output: [],
        usage: { input_tokens: 42, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(body);
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const routerPort = await openPort(), capability = "synthetic-observer-router-caller-capability";
  const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const router = spawn(process.execPath, [path.join(rootDirectory, "src/router.mjs")], {
    cwd: rootDirectory, stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH, HOME: fixture.directory, CODEX_HOME: fixture.directory,
      MODEL_ROUTER_STATE_DIR: path.join(fixture.directory, "router-state"), CODEX_ROUTER_CALLER_KEY: capability,
      CODEX_ROUTER_INTERNAL_KEY: "synthetic-observer-internal-capability", CODEX_ROUTER_PORT: String(routerPort),
      CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0",
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${upstream.address().port}` },
  });
  let errors = ""; router.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    const base = callerBaseUrl(routerPort, capability);
    const deadline = Date.now() + 5000;
    while (true) {
      if (router.exitCode !== null) assert.fail(`fixture router exited: ${errors}`);
      try { if ((await fetch(base+"/models")).ok) break; } catch {}
      if (Date.now() >= deadline) assert.fail("router startup deadline");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const selected = "native-profile/gpt-6-astra-1m";
    const input = { model: selected, reasoning: { effort: "xhigh" }, input: "PRIVATE prompt stays on native wire" };
    const response = await fetch(base+"/responses", { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: "Bearer synthetic-native-session",
      "x-codex-turn-metadata": JSON.stringify({ turn: { thread_id: thread, turn_id: turn } }),
    }, body: JSON.stringify(input) });
    assert.equal(response.status, 200, errors); await response.text();
    const completedPath = path.join(fixture.directory, "completion-auto.json");
    while (true) {
      try { readFileSync(completedPath); break; } catch {}
      if (Date.now() >= deadline) assert.fail(`completion deadline: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const captured = JSON.parse(readFileSync(path.join(fixture.directory, "capture-auto.json")));
    const completed = JSON.parse(readFileSync(completedPath));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, "gpt-6-astra"); assert.equal(seen[0].input, input.input);
    assert.equal(captured.model, selected); assert.equal(captured.wire_model, "gpt-6-astra");
    assert.equal(captured.effort, "xhigh"); assert.equal(captured.thread_id, thread); assert.equal(captured.turn_id, turn);
    assert.equal(completed.request_id, captured.request_id);
    assert.deepEqual(completed.usage, { input_tokens: 42, output_tokens: 3, cached_input_tokens: 0 });
    assert.doesNotMatch(JSON.stringify(captured), /PRIVATE/);
  } finally {
    if (router.exitCode === null && router.signalCode === null) {
      router.kill("SIGTERM"); await new Promise(resolve => router.once("exit", resolve));
    }
    await new Promise(resolve => upstream.close(resolve));
  }
});
