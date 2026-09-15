import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER = "synthetic-caller-key-for-nous-replay-test";
const INTERNAL = "synthetic-internal-key-for-nous-replay-test";

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { await exited; } finally { clearTimeout(timeout); }
}

test("a lost native response cannot contact the gateway again after router restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nous-router-replay-"));
  let gatewayCalls = 0;
  let firstContact;
  const contacted = new Promise(resolve => { firstContact = resolve; });
  const gateway = http.createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    for await (const chunk of request) { void chunk; }
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      firstContact();
      // The operation has reached its next hop, but the caller loses the
      // response before learning its result. Never replay this request.
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "synthetic-fresh", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "independent turn" }] }] }));
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayBase = `http://127.0.0.1:${gateway.address().port}`;
  const port = await openPort();
  const base = callerBaseUrl(port, CALLER);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "USER", "LANG", "TMPDIR", "SYSTEMROOT"].includes(key))),
    CODEX_HOME: path.join(root, "codex-home"),
    MODEL_ROUTER_STATE_DIR: path.join(root, "state"),
    CODEX_ROUTER_PORT: String(port),
    CODEX_ROUTER_GATEWAY_BASE_URL: `${gatewayBase}/v1`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `${gatewayBase}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `${gatewayBase}/health`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `${gatewayBase}/health`,
    CODEX_ROUTER_CALLER_KEY: CALLER,
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1",
    CODEX_ROUTER_QUIET: "1",
    NOUS_API_KEY: "SYNTHETIC_NOUS_KEY",
  };
  let child;
  const start = async () => {
    child = spawn(process.execPath, [path.join(ROOT, "src/router.mjs")], { cwd: ROOT, env, stdio: "ignore" });
    for (let n = 0; n < 200; n += 1) {
      if (child.exitCode !== null) throw new Error("test router exited");
      try { if ((await fetch(`${base}/models`)).ok) return; } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("test router did not start");
  };
  const thread = "11111111-1111-4111-8111-111111111111";
  const headers = turn => ({
    Authorization: "Bearer synthetic-native-session",
    "Content-Type": "application/json",
    "thread-id": thread,
    "x-codex-turn-metadata": JSON.stringify({ turn: { thread_id: thread, root_turn_id: turn } }),
  });
  const turn = "22222222-2222-4222-8222-222222222222";
  const body = JSON.stringify({ model: "nous/deepseek/deepseek-v4.1-flash", input: "synthetic replay test", stream: false });
  try {
    await start();
    const controller = new AbortController();
    const lost = fetch(`${base}/responses`, { method: "POST", headers: headers(turn), body, signal: controller.signal });
    const rejected = assert.rejects(lost, error => error.name === "AbortError");
    await Promise.race([contacted, new Promise((_, reject) => setTimeout(() => reject(new Error("no gateway contact")), 5000).unref())]);
    controller.abort();
    await rejected;
    await stop(child);
    await start();
    const duplicate = await fetch(`${base}/responses`, { method: "POST", headers: headers(turn), body });
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).error.type, "local_nous_attempt_already_admitted");
    assert.equal(gatewayCalls, 1);
    const fresh = await fetch(`${base}/responses`, { method: "POST", headers: headers("33333333-3333-4333-8333-333333333333"), body });
    assert.equal(fresh.status, 200);
    await fresh.text();
    assert.equal(gatewayCalls, 2);
  } finally {
    if (child) await stop(child);
    gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
