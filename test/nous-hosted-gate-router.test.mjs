import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { NOUS_MODEL_SLUG } from "../src/nous-direct.mjs";
import { openPort } from "./port-pool.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const IMAGE =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

function run(env) {
  const child = spawn(process.execPath, [path.join(ROOT, "src", "router.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("forced hosted search stops before routed normalization, vision, relay, or provider contact", async () => {
  const counts = {
    gateway: 0,
    provider: 0,
    vision: 0,
    relay: 0,
  };
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    counts.gateway += 1;
    json(response, 200, { id: "must-not-reach-gateway" });
  });
  const provider = await mockServer((_request, response) => {
    counts.provider += 1;
    json(response, 200, { id: "must-not-reach-provider" });
  });
  const vision = await mockServer((_request, response) => {
    counts.vision += 1;
    json(response, 200, { choices: [{ message: { role: "assistant", content: "must-not-read-image" } }] });
  });
  const relay = await mockServer((_request, response) => {
    counts.relay += 1;
    json(response, 200, { output: [] });
  });
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-nous-hosted-gate-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "vision-bridge.json"),
    `${JSON.stringify({
      version: 1,
      enabled: true,
      engine: "local",
      effort: null,
      local: {
        model: "mock-vision",
        baseUrl: `http://127.0.0.1:${vision.port}/vision/v1`,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${provider.port}/health`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${provider.port}/health`,
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${relay.port}`,
  });
  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    counts.gateway = 0;
    counts.provider = 0;
    counts.vision = 0;
    counts.relay = 0;

    const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer caller-session",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: NOUS_MODEL_SLUG,
        stream: false,
        tools: [
          { type: "custom", name: "exec", format: { type: "text" } },
          { type: "web_search", user_location: { city: "PRIVATE_LOCATION" } },
        ],
        tool_choice: { type: "web_search" },
        input: [{
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
            { type: "encrypted_content", encrypted_content: "gAAAAA-native-relay-fixture" },
            { type: "input_image", image_url: IMAGE },
          ],
        }],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 400, router.testErrors());
    assert.equal(body.error.type, "local_nous_tool_unavailable");
    assert.match(body.error.message, /not sent to Nous/);
    assert.deepEqual(counts, { gateway: 0, provider: 0, vision: 0, relay: 0 });
  } finally {
    await stopChild(router);
    await Promise.all([
      closeServer(gateway.server),
      closeServer(provider.server),
      closeServer(vision.server),
      closeServer(relay.server),
    ]);
    rmSync(testRoot, { recursive: true, force: true });
  }
});
