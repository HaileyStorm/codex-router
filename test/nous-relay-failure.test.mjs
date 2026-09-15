import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function routerUrl(port) {
  return `${callerBaseUrl(port, CALLER_KEY)}/responses`;
}

function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function runRouter({ routerPort, stateDir, nativePort, gatewayPort }) {
  const child = spawn(process.execPath, [path.join(ROOT, "src", "router.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      NOUS_API_KEY: "SYNTHETIC_FAKE_PROVIDER_KEY",
      CODEX_HOME: path.join(stateDir, "codex-home"),
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      CODEX_ROUTER_PORT: String(routerPort),
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${nativePort}/backend-api/codex`,
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Router exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopRouter(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

function relayInput() {
  return [
    {
      type: "agent_message",
      author: "/root",
      recipient: "/root/child",
      content: [
        {
          type: "input_text",
          text: "Message Type: NEW_TASK\nTask name: /root/child\nSender: /root\nPayload:\n",
        },
        { type: "encrypted_content", encrypted_content: "gAAAAA-synthetic-relay-payload=" },
      ],
    },
  ];
}

function nousBody() {
  return {
    model: NOUS_MODEL_SLUG,
    stream: false,
    input: relayInput(),
    reasoning: { effort: "max" },
  };
}

async function postRouter(port, body, requestId = REQUEST_ID) {
  const response = await fetch(routerUrl(port), {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic-session-token",
      "Content-Type": "application/json",
      "X-Codex-Nous-Request-Id": requestId,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { response, body: parsed, text };
}

async function startFixture({ nativeHandler, gatewayHandler }) {
  const native = await listen(nativeHandler);
  const gateway = await listen(gatewayHandler);
  const routerPort = await openPort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "nous-relay-diagnostics-"));
  const router = runRouter({
    routerPort,
    stateDir,
    nativePort: native.port,
    gatewayPort: gateway.port,
  });
  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
  } catch (error) {
    await stopRouter(router);
    await closeServer(native.server);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }
  return {
    native,
    gateway,
    router,
    routerPort,
    stateDir,
    async close() {
      await stopRouter(router);
      await closeServer(native.server);
      await closeServer(gateway.server);
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test("Nous relay socket failures become terminal400s and duplicate admission does not replay", async () => {
  let nativeRequests = 0;
  let gatewayRequests = 0;
  const nativeHandler = async (_request, response) => {
    nativeRequests += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    setTimeout(() => response.destroy(), 15);
  };
  const gatewayHandler = async (_request, response) => {
    gatewayRequests += 1;
    writeJson(response, 200, { output: [] });
  };
  const fixture = await startFixture({ nativeHandler, gatewayHandler });

  try {
    const first = await postRouter(fixture.routerPort, nousBody());
    assert.equal(first.response.status, 400, `${first.text}\n${fixture.router.testErrors()}`);
    assert.equal(first.body.error.type, "local_nous_transport_failure");
    assert.equal(first.body.error.phase, "agent_relay_body");
    assert.equal(first.body.error.transport_code, "UND_ERR_SOCKET");
    assert.equal(first.body.error.provider_contact_possible, false);
    assert.match(first.body.error.attempt_id, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(first.text, /terminated|other side closed|synthetic-relay-payload/);
    assert.equal(nativeRequests, 1);
    assert.equal(gatewayRequests, 0);

    const duplicate = await postRouter(fixture.routerPort, nousBody());
    assert.equal(duplicate.response.status, 400, `${duplicate.text}\n${fixture.router.testErrors()}`);
    assert.equal(duplicate.body.error.type, "local_nous_attempt_already_admitted");
    assert.equal(nativeRequests, 1, "duplicate replay contacted the native relay");
    assert.equal(gatewayRequests, 0, "duplicate replay reached the gateway");
  } finally {
    await fixture.close();
  }
});

test("a successful relay over 4 MiB is canceled before the full body is consumed", async () => {
  const totalBytes = 8 * 1024 * 1024 + 64 * 1024;
  const chunk = Buffer.alloc(64 * 1024, 0x78);
  let nativeRequests = 0;
  let gatewayRequests = 0;
  let nativeBytesSent = 0;
  let timer;
  const nativeHandler = async (_request, response) => {
    nativeRequests += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = () => {
      if (response.destroyed || response.writableEnded) return;
      if (nativeBytesSent >= totalBytes) {
        response.end();
        return;
      }
      const size = Math.min(chunk.length, totalBytes - nativeBytesSent);
      nativeBytesSent += size;
      if (!response.write(chunk.subarray(0, size))) {
        response.once("drain", send);
      } else {
        timer = setTimeout(send, 10);
      }
    };
    response.once("close", () => clearTimeout(timer));
    send();
  };
  const gatewayHandler = async (_request, response) => {
    gatewayRequests += 1;
    writeJson(response, 200, { output: [] });
  };
  const fixture = await startFixture({ nativeHandler, gatewayHandler });

  try {
    const result = await postRouter(
      fixture.routerPort,
      nousBody(),
      "22222222-2222-4222-8222-222222222222",
    );
    assert.equal(result.response.status, 400, `${result.text}\n${fixture.router.testErrors()}`);
    assert.equal(result.body.error.type, "local_nous_transport_failure");
    assert.equal(result.body.error.transport_code, "ERR_NATIVE_RELAY_RESPONSE_TOO_LARGE");
    assert.equal(result.body.error.provider_contact_possible, false);
    assert.equal(nativeRequests, 1);
    assert.equal(gatewayRequests, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      nativeBytesSent < totalBytes,
      `relay consumed the complete oversized body (${nativeBytesSent} bytes) before rejecting`,
    );
  } finally {
    clearTimeout(timer);
    await fixture.close();
  }
});

test("a relay HTTP401 keeps the safe upstream status and phase", async () => {
  let nativeRequests = 0;
  let gatewayRequests = 0;
  const nativeHandler = async (_request, response) => {
    nativeRequests += 1;
    writeJson(response, 401, { error: { message: "private native body" } });
  };
  const gatewayHandler = async (_request, response) => {
    gatewayRequests += 1;
    writeJson(response, 200, { output: [] });
  };
  const fixture = await startFixture({ nativeHandler, gatewayHandler });

  try {
    const result = await postRouter(
      fixture.routerPort,
      nousBody(),
      "33333333-3333-4333-8333-333333333333",
    );
    assert.equal(result.response.status, 400, `${result.text}\n${fixture.router.testErrors()}`);
    assert.equal(result.body.error.type, "local_nous_transport_failure");
    assert.equal(result.body.error.phase, "agent_relay_status");
    assert.equal(result.body.error.upstream_status, 401);
    assert.equal(result.body.error.provider_contact_possible, false);
    assert.doesNotMatch(result.text, /private native body/);
    assert.equal(nativeRequests, 1);
    assert.equal(gatewayRequests, 0);
  } finally {
    await fixture.close();
  }
});

test("non-Nous routed gateway failures remain ordinary502 errors", async () => {
  let gatewayRequests = 0;
  const nativeHandler = async (_request, response) => {
    writeJson(response, 200, { output: [] });
  };
  const gatewayHandler = async (_request, response) => {
    gatewayRequests += 1;
    response.destroy();
  };
  const fixture = await startFixture({ nativeHandler, gatewayHandler });

  try {
    const result = await postRouter(fixture.routerPort, {
      model: "grok-oauth/grok-4.5",
      stream: false,
      input: "ordinary routed request",
    });
    assert.equal(result.response.status, 502, `${result.text}\n${fixture.router.testErrors()}`);
    assert.equal(result.body.error.type, "local_router_error");
    assert.notEqual(result.body.error.type, "local_nous_transport_failure");
    assert.equal(gatewayRequests, 1);
  } finally {
    await fixture.close();
  }
});
