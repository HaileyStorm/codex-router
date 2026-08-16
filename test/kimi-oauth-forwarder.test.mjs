import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";
import { STARTUP_TIMEOUT_MS, stopChild } from "./process-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "test-kimi-internal-service-key-with-sufficient-length";

const STARTUP_FETCH_TIMEOUT_MS = 2_000;

test("Kimi OAuth forwarder returns an actionable 401 when login is required", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "kimi-oauth-forwarder-"));
  const devicePath = path.join(home, "device_id");
  writeFileSync(devicePath, "test-device-id\n", { mode: 0o600 });
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(root, "src", "oauth-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_OAUTH_PORT: String(port),
      KIMI_CODE_HOME: home,
      KIMI_CODE_BASE_URL: "http://127.0.0.1:1/v1",
      MODEL_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  let childError = null;
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.on("error", (error) => { childError ??= error; });
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: `Bearer ${internalKey}`,
    "Content-Type": "application/json",
  };

  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      if (childError) {
        throw new Error(`forwarder failed to start: ${childError.message}`, { cause: childError });
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const termination = child.exitCode !== null
          ? `exit ${child.exitCode}`
          : `signal ${child.signalCode}`;
        throw new Error(`forwarder terminated (${termination}): ${errors}`);
      }
      try {
        const health = await fetch(`${base}/health`, {
          headers,
          signal: AbortSignal.timeout(
            Math.min(STARTUP_FETCH_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
          ),
        });
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(ready, true, errors);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "k3", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.type, "authentication_error");
    assert.match(body.error.message, /kimi login/);
  } finally {
    await stopChild(child, { description: "Kimi OAuth forwarder test child" });
    unlinkSync(devicePath);
    rmdirSync(home);
  }
});
