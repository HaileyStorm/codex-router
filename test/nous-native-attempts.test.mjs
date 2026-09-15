import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { claimNousNativeAttempt, nousNativeAttemptKey } from "../src/nous-native-attempts.mjs";

const THREAD = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const KEY = "synthetic-internal-key-never-persisted";
const payload = { model: "nous/deepseek/deepseek-v4.1-flash", input: "SYNTHETIC_PRIVATE_PROMPT", stream: true };
const headers = { "thread-id": THREAD, "x-codex-turn-metadata": JSON.stringify({ turn: { thread_id: THREAD, root_turn_id: TURN } }) };
const common = { headers, payload, lane: "response", internalKey: KEY };

test("native attempt identity ignores transport metadata but preserves turn, input, and lane", () => {
  const first = nousNativeAttemptKey(headers, payload, "response", KEY);
  assert.equal(first, nousNativeAttemptKey(headers, { stream: false, input: payload.input, model: payload.model, client_metadata: { other: "changed" } }, "response", KEY));
  assert.equal(nousNativeAttemptKey({}, payload, "response", KEY), nousNativeAttemptKey({ "x-client-request-id": TURN }, { ...payload, prompt_cache_key: THREAD }, "response", KEY));
  assert.notEqual(first, nousNativeAttemptKey(headers, { ...payload, input: "new tool result" }, "response", KEY));
  assert.notEqual(first, nousNativeAttemptKey({ ...headers, "x-codex-turn-metadata": JSON.stringify({ turn: { root_turn_id: "33333333-3333-4333-8333-333333333333" } }) }, payload, "response", KEY));
  assert.notEqual(first, nousNativeAttemptKey(headers, payload, "compact", KEY));
  assert.notEqual(first, nousNativeAttemptKey({ "x-codex-nous-request-id": TURN }, payload, "response", KEY));
});

test("claims survive reopening, never cache tool replies, and retain no prompt or identity", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nous-native-claims-"));
  const databasePath = path.join(root, "private", "attempts.sqlite");
  try {
    assert.equal(claimNousNativeAttempt({ ...common, databasePath }).ok, true);
    const duplicate = claimNousNativeAttempt({ ...common, databasePath });
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.error.type, "local_nous_attempt_already_admitted");
    const database = new DatabaseSync(databasePath);
    assert.equal(database.prepare("SELECT count(*) AS n FROM attempts").get().n, 1);
    database.close();
    const contents = readFileSync(databasePath).toString("latin1");
    for (const value of [KEY, THREAD, TURN, payload.input]) assert.equal(contents.includes(value), false);
    if (process.platform !== "win32") assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("different independent turns and explicit stateless identities remain available", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nous-native-fresh-"));
  const databasePath = path.join(root, "attempts.sqlite");
  try {
    assert.equal(claimNousNativeAttempt({ ...common, headers: {}, databasePath }).ok, true);
    assert.equal(claimNousNativeAttempt({ ...common, headers: {}, databasePath }).ok, false);
    assert.equal(claimNousNativeAttempt({ ...common, headers: { "x-codex-nous-request-id": TURN }, databasePath }).ok, true);
    assert.equal(claimNousNativeAttempt({ ...common, headers: { "x-codex-nous-request-id": "33333333-3333-4333-8333-333333333333" }, databasePath }).ok, true);
    assert.equal(claimNousNativeAttempt({ ...common, headers: { "x-codex-nous-request-id": "invalid" }, databasePath }).error.type, "local_nous_attempt_identity_invalid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unavailable or linked claim storage refuses dispatch", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nous-native-bad-store-"));
  try {
    const bad = path.join(root, "not-a-database");
    writeFileSync(bad, "SYNTHETIC_FOREIGN_FILE");
    assert.equal(claimNousNativeAttempt({ ...common, databasePath: bad }).error.type, "local_nous_attempt_record_unavailable");
    assert.equal(readFileSync(bad, "utf8"), "SYNTHETIC_FOREIGN_FILE");
    if (process.platform !== "win32") {
      const linked = path.join(root, "linked.sqlite");
      symlinkSync(bad, linked);
      assert.equal(claimNousNativeAttempt({ ...common, databasePath: linked }).ok, false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("separate processes admit exactly one identical native request", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nous-native-concurrent-"));
  const databasePath = path.join(root, "attempts.sqlite");
  const moduleUrl = new URL("../src/nous-native-attempts.mjs", import.meta.url).href;
  const code = `import {claimNousNativeAttempt} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(claimNousNativeAttempt(${JSON.stringify({ ...common, databasePath })})));`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", exit => exit === 0 ? resolve(JSON.parse(output)) : reject(new Error(`child exit ${exit}`)));
  });
  try {
    const results = await Promise.all([run(), run(), run(), run()]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => result.error?.type === "local_nous_attempt_already_admitted").length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
