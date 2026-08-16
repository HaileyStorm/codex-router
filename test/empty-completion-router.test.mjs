import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";
import { STARTUP_TIMEOUT_MS, stopChild } from "./process-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const STARTUP_FETCH_TIMEOUT_MS = 2_000;
const SERVER_CLOSE_TIMEOUT_MS = 2_000;
const ACQUISITION_TIMEOUT_MS = 2_000;
const CHILD_SPAWN_OUTCOME_TIMEOUT_MS = 2_000;

function deferred() {
  let resolve;
  const promise = new Promise((currentResolve) => {
    resolve = currentResolve;
  });
  return { promise, resolve };
}

async function boundedOutcome(promise, timeoutMs, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} did not settle within ${timeoutMs}ms`)),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function throwCollected(errors, message) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

async function preservePrimaryAndCleanup(body, cleanup) {
  const errors = [];
  let result;
  try {
    result = await body();
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
  throwCollected(errors, "empty-completion test and cleanup both failed");
  return result;
}

function createLifecycle() {
  let closing = false;
  let childReservation;
  let serverReservation;
  let cleanupPromise;
  const startCleanup = () => {
    if (!cleanupPromise) {
      closing = true;
      cleanupPromise = performLifecycleCleanup(childReservation, serverReservation);
    }
    return cleanupPromise;
  };
  return {
    reserveChild() {
      if (closing) throw new Error("test lifecycle is closing; router creation refused");
      if (childReservation) throw new Error("test lifecycle already reserved a router child");
      const reservation = { child: null };
      childReservation = reservation;
      return {
        activate(child) {
          reservation.child = child;
        },
      };
    },
    reserveServer() {
      if (closing) throw new Error("test lifecycle is closing; gateway creation refused");
      if (serverReservation) throw new Error("test lifecycle already reserved a gateway");
      const outcome = deferred();
      const reservation = { server: null, outcome: outcome.promise };
      serverReservation = reservation;
      return {
        track(server) {
          reservation.server = server;
        },
        ready() {
          outcome.resolve({ status: "ready" });
        },
        fail(error) {
          outcome.resolve({ status: "error", error });
        },
      };
    },
    cleanupEarly: () => startCleanup().catch(() => {}),
    finishCleanup: startCleanup,
  };
}

function test(name, body) {
  return nodeTest(name, async () => {
    const lifecycle = createLifecycle();
    return preservePrimaryAndCleanup(() => body(lifecycle), lifecycle.finishCleanup);
  });
}

// An attempt that never proves it was generating. The guard holds all of it, so
// the router can swap it for a retry the client never sees.
const EMPTY_SSE = [
  'event: response.created',
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-empty"}}',
  "",
  'event: response.in_progress',
  'data: {"type":"response.in_progress","sequence_number":1,"response":{"id":"r-empty"}}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","sequence_number":2,"response":{"id":"r-empty","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","sequence_number":3,"response":{"id":"r-empty"}}',
  "",
].join("\n");

// The same failure after the upstream proved it was generating. The reasoning
// delta releases the hold, so this attempt is already on the wire by the time
// it turns out to be empty and cannot be retried invisibly.
const REASONING_EMPTY_SSE = [
  'event: response.created',
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-empty"}}',
  "",
  'event: response.reasoning_text.delta',
  'data: {"type":"response.reasoning_text.delta","sequence_number":1,"delta":"thinking..."}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","sequence_number":2,"response":{"id":"r-empty","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","sequence_number":3,"response":{"id":"r-empty"}}',
  "",
].join("\n");

const CONTENT_SSE = [
  'event: response.created',
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-content"}}',
  "",
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","sequence_number":1,"delta":"Recovered"}',
  "",
  'event: response.output_text.done',
  'data: {"type":"response.output_text.done","sequence_number":2,"text":"Recovered"}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","sequence_number":3,"response":{"id":"r-content","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","sequence_number":4,"response":{"id":"r-content"}}',
  "",
].join("\n");

// Large enough to force the guard past its 1 MiB pre-content hold budget
// before any client-visible output arrives. Deliberately not a reasoning event:
// reasoning releases the hold on liveness long before the byte cap, so a
// reasoning prelude would exercise the wrong release path.
const BUDGET_RELEASE_REASONING_SSE = [
  "event: response.created",
  'data: {"type":"response.created","response":{"id":"r-budget"}}',
  "",
  "event: response.in_progress",
  `data: ${JSON.stringify({
    type: "response.in_progress",
    response: { id: "r-budget", status: "x".repeat(2 * 1024 * 1024) },
  })}`,
  "",
].join("\n");

const BUDGET_RELEASE_EMPTY_SSE = [
  BUDGET_RELEASE_REASONING_SSE,
  "event: response.completed",
  'data: {"type":"response.completed","response":{"id":"r-budget","output":[]}}',
  "",
  "event: response.done",
  'data: {"type":"response.done","response":{"id":"r-budget"}}',
  "",
].join("\n");

const CUSTOM_TOOL_CALL_SSE = [
  "event: response.created",
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-custom-tool"}}',
  "",
  "event: response.custom_tool_call_input.delta",
  'data: {"type":"response.custom_tool_call_input.delta","sequence_number":1,"item_id":"ctc_1","delta":"move pointer"}',
  "",
  "event: response.custom_tool_call_input.done",
  'data: {"type":"response.custom_tool_call_input.done","sequence_number":2,"item_id":"ctc_1","input":"move pointer"}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    sequence_number: 3,
    response: {
      id: "r-custom-tool",
      output: [
        {
          id: "ctc_1",
          type: "custom_tool_call",
          call_id: "call_custom_1",
          name: "computer",
          input: "move pointer",
        },
      ],
    },
  })}`,
  "",
  "event: response.done",
  'data: {"type":"response.done","sequence_number":4,"response":{"id":"r-custom-tool"}}',
  "",
].join("\n");

const REFUSAL_EVENT_SSE = [
  "event: response.created",
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-refusal-event"}}',
  "",
  "event: response.refusal.delta",
  'data: {"type":"response.refusal.delta","sequence_number":1,"delta":"I cannot help with that."}',
  "",
  "event: response.refusal.done",
  'data: {"type":"response.refusal.done","sequence_number":2,"refusal":"I cannot help with that."}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","sequence_number":3,"response":{"id":"r-refusal-event","output":[]}}',
  "",
  "event: response.done",
  'data: {"type":"response.done","sequence_number":4,"response":{"id":"r-refusal-event"}}',
  "",
].join("\n");

const REFUSAL_OUTPUT_SSE = [
  "event: response.created",
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-refusal-output"}}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    sequence_number: 1,
    response: {
      id: "r-refusal-output",
      output: [
        {
          type: "message",
          content: [{ type: "refusal", refusal: "I cannot help with that." }],
        },
      ],
    },
  })}`,
  "",
  "event: response.done",
  'data: {"type":"response.done","sequence_number":2,"response":{"id":"r-refusal-output"}}',
  "",
].join("\n");

const CHAT_REFUSAL_SSE = [
  `data: ${JSON.stringify({
    id: "chat-refusal",
    choices: [{ index: 0, delta: { refusal: "I cannot help with that." } }],
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

const HEADERLESS_PREFIX_TOOL_SSE = Buffer.from(
  [
    "\uFEFF: keepalive\r\n\r\n",
    "\n",
    "event: response.created\n",
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-prefix-tool"}}\n\n',
    "event: response.output_item.done\n",
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      sequence_number: 1,
      item: {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_prefix_tool",
        arguments: "{}",
      },
    })}\n\n`,
    "event: response.completed\n",
    `data: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "r-prefix-tool",
        output: [],
        usage: {
          input_tokens: 19,
          output_tokens: 2,
          total_tokens: 21,
          input_tokens_details: { cached_tokens: 7 },
        },
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""),
  "utf8",
);

// The same two turns with the provider's own token counts attached, so a test
// can check what a retried turn reports as spend.
const EMPTY_SSE_METERED = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r-empty"}}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "r-empty",
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 0,
        total_tokens: 100,
        input_tokens_details: { cached_tokens: 60 },
      },
    },
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

const CONTENT_SSE_METERED = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r-content"}}',
  "",
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"Recovered"}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "r-content",
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 105,
        input_tokens_details: { cached_tokens: 80 },
      },
    },
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

async function mockServer(handler, { lifecycleReservation } = {}) {
  const server = http.createServer(handler);
  lifecycleReservation?.track(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(env, { lifecycle, spawnProcess = spawn } = {}) {
  const lifecycleReservation = lifecycle?.reserveChild();
  let stateDir;
  try {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "empty-completion-router-state-"));
  } catch (error) {
    throw error;
  }
  let child;
  try {
    child = spawnProcess(process.execPath, [path.join(root, "src", "router.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_STATE_DIR: stateDir,
        CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
        CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
        KIMI_INTERNAL_KEY: INTERNAL_KEY,
        CODEX_ROUTER_SHOW_ALL_MODELS: "1",
        CODEX_ROUTER_QUIET: "1",
        ...env,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "empty-completion router spawn failed and state cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
  child.stderr.setEncoding("utf8");
  let errors = "";
  let childError = null;
  const spawnOutcome = deferred();
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.once("spawn", () => {
    spawnOutcome.resolve({ status: "spawn" });
  });
  child.on("error", (error) => {
    childError ??= error;
    spawnOutcome.resolve({ status: "error", error });
  });
  child.testErrors = () => errors;
  child.testChildError = () => childError;
  child.testSpawnOutcome = () => spawnOutcome.promise;
  child.stateDir = stateDir;
  lifecycleReservation?.activate(child);
  return child;
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForUsageEvents(stateDir, count, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = usageEvents(stateDir);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} usage events: ${child.testErrors()}`);
}

async function waitForLog(child, pattern) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pattern.test(child.testErrors())) return child.testErrors();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}: ${child.testErrors()}`);
}

async function waitFor(url, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const childError = child.testChildError?.();
    if (childError) {
      throw new Error(`Child failed to start: ${childError.message}`, { cause: childError });
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const termination = child.exitCode !== null
        ? `exit ${child.exitCode}`
        : `signal ${child.signalCode}`;
      throw new Error(`Child exited early (${termination}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(STARTUP_FETCH_TIMEOUT_MS, remainingMs)),
      });
      if (response.ok) return;
    } catch {
      // Not bound yet.
    }
    const sleepMs = Math.min(50, deadline - Date.now());
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function performLifecycleCleanup(childReservation, serverReservation) {
  const errors = [];
  let server;
  if (serverReservation) {
    try {
      const outcome = await boundedOutcome(
        serverReservation.outcome,
        ACQUISITION_TIMEOUT_MS,
        "gateway acquisition",
      );
      server = serverReservation.server;
      if (outcome.status === "error" && !server?.listening) server = null;
    } catch (error) {
      errors.push(error);
      server = serverReservation.server;
    }
  }

  try {
    await performRouterCleanup(childReservation?.child, server);
  } catch (error) {
    errors.push(error);
  }

  throwCollected(errors, "empty-completion lifecycle cleanup failed");
}

async function performRouterCleanup(
  child,
  server,
  {
    childGracefulTimeoutMs = 2_000,
    childForceTimeoutMs = 2_000,
    serverGracefulTimeoutMs = SERVER_CLOSE_TIMEOUT_MS,
    serverForceTimeoutMs = SERVER_CLOSE_TIMEOUT_MS,
  } = {},
) {
  const errors = [];
  let stopped = !child;
  if (child) {
    let spawnOutcome;
    try {
      spawnOutcome = await boundedOutcome(
        child.testSpawnOutcome?.() ?? Promise.resolve({
          status: child.pid == null ? "unknown" : "spawn",
        }),
        CHILD_SPAWN_OUTCOME_TIMEOUT_MS,
        "router child spawn outcome",
      );
    } catch (error) {
      if (child.pid == null) {
        errors.push(new Error(
          `router child spawn outcome is unknown; state retained at ${child.stateDir}`,
          { cause: error },
        ));
      } else {
        spawnOutcome = { status: "spawn" };
      }
    }

    const preSpawnFailure = spawnOutcome?.status === "error" && child.pid == null;
    if (preSpawnFailure) {
      // An asynchronous spawn failure with no PID proves there is no process
      // that could still be using the just-created state directory.
      stopped = true;
    } else if (spawnOutcome?.status === "spawn" || child.pid != null) {
      try {
        await stopChild(child, {
          gracefulTimeoutMs: childGracefulTimeoutMs,
          forceTimeoutMs: childForceTimeoutMs,
          description: "empty-completion test router",
        });
        stopped = true;
      } catch (error) {
        // Preserve the directory when the exact child could still be using it;
        // stopChild's bounded TERM/KILL diagnostic is the primary failure.
        errors.push(
          new Error(`empty-completion router did not stop; state retained at ${child.stateDir}`, {
            cause: error,
          }),
        );
      }
    } else if (errors.length === 0) {
      errors.push(new Error(
        `router child spawn outcome is unknown; state retained at ${child.stateDir}`,
      ));
    }
  }

  if (stopped && child?.stateDir) {
    try {
      rmSync(child.stateDir, { recursive: true, force: true });
    } catch (error) {
      errors.push(new Error(`failed to remove empty-completion state at ${child.stateDir}`, {
        cause: error,
      }));
    }
  }

  if (server) {
    try {
      await closeServer(server, {
        gracefulTimeoutMs: serverGracefulTimeoutMs,
        forceTimeoutMs: serverForceTimeoutMs,
      });
    } catch (error) {
      errors.push(new Error("failed to close empty-completion gateway", { cause: error }));
    }
  }

  throwCollected(errors, "empty-completion router cleanup failed");
}

async function closeServer(
  server,
  {
    gracefulTimeoutMs = SERVER_CLOSE_TIMEOUT_MS,
    forceTimeoutMs = SERVER_CLOSE_TIMEOUT_MS,
  } = {},
) {
  await new Promise((resolve, reject) => {
    let settled = false;
    let forceTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(gracefulTimer);
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    };
    const gracefulTimer = setTimeout(() => {
      forceTimer = setTimeout(
        () => finish(new Error("test server did not close after its connections were destroyed")),
        Math.max(0, forceTimeoutMs),
      );
      try {
        // This is scoped to connections accepted by this exact test server.
        server.closeAllConnections();
      } catch (error) {
        finish(error);
      }
    }, Math.max(0, gracefulTimeoutMs));

    try {
      server.close((error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

function readRouted(port, body) {
  const base = new URL(`${callerBaseUrl(port, CALLER_KEY)}/responses`);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: base.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer codex-caller-auth",
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        const done = () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: text,
            complete: response.complete,
          });
        response.once("end", done);
        response.once("close", done);
        response.once("error", done);
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function gateway(handler, { createServer = mockServer, lifecycle } = {}) {
  const lifecycleReservation = lifecycle?.reserveServer();
  try {
    const result = await createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
        });
        response.end(payload);
        return;
      }
      handler(request, response);
    }, { lifecycleReservation });
    lifecycleReservation?.ready();
    return result;
  } catch (error) {
    lifecycleReservation?.fail(error);
    throw error;
  }
}

function routerEnv(gatewayPort, routerPort) {
  return {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
  };
}

const TURN_BODY = {
  model: "deepseek/deepseek-v4-pro",
  input: "hello",
  stream: true,
};

test("router cleanup removes its run-owned state directory", async (lifecycle) => {
  const gw = await gateway((_request, response) => {
    response.writeHead(404);
    response.end();
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
  } finally {
    await lifecycle.cleanupEarly();
  }

  assert.equal(existsSync(router.stateDir), false);
});

nodeTest("an asynchronous spawn failure is surfaced and its unused state is removed", async () => {
  const lifecycle = createLifecycle();
  const spawnFailure = Object.assign(new Error("injected asynchronous spawn failure"), {
    code: "ENOENT",
  });
  const router = run({}, {
    lifecycle,
    spawnProcess() {
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.pid = undefined;
      child.kill = () => {
        throw new Error("a child that never spawned must not be signalled");
      };
      queueMicrotask(() => child.emit("error", spawnFailure));
      return child;
    },
  });
  const cleanup = lifecycle.finishCleanup();

  try {
    await assert.rejects(
      waitFor("http://127.0.0.1:1/models", router),
      (error) => {
        assert.equal(error.cause, spawnFailure);
        assert.match(error.message, /Child failed to start: injected asynchronous spawn failure/);
        return true;
      },
    );
  } finally {
    await cleanup;
  }

  assert.equal(existsSync(router.stateDir), false);
});

nodeTest("server close callback errors are propagated", async () => {
  const callbackError = new Error("injected server close callback failure");
  let destroyed = false;
  const server = {
    close(callback) {
      queueMicrotask(() => callback(callbackError));
    },
    closeAllConnections() {
      destroyed = true;
    },
  };

  await assert.rejects(closeServer(server), (error) => error === callbackError);
  assert.equal(destroyed, false);
});

nodeTest("a stubborn child retains state while an active owned socket is destroyed", async () => {
  let requestArrived;
  const arrived = new Promise((resolve) => {
    requestArrived = resolve;
  });
  let acceptedSocket;
  const upstream = await mockServer((_request, _response) => requestArrived());
  upstream.server.on("connection", (socket) => {
    acceptedSocket = socket;
  });
  const client = net.createConnection(upstream.port, "127.0.0.1");
  client.on("error", () => {});
  await new Promise((resolve) => client.once("connect", resolve));
  client.write("GET /stubborn HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await arrived;

  const stateDir = mkdtempSync(path.join(os.tmpdir(), "empty-completion-router-state-"));
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 42;
  child.stateDir = stateDir;
  child.testChildError = () => null;
  child.testSpawnOutcome = () => Promise.resolve({ status: "spawn" });
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return false;
  };

  try {
    await assert.rejects(
      performRouterCleanup(child, upstream.server, {
        childGracefulTimeoutMs: 0,
        childForceTimeoutMs: 0,
        serverGracefulTimeoutMs: 10,
        serverForceTimeoutMs: 100,
      }),
      (error) => {
        assert.match(error.message, /state retained/);
        assert.match(error.cause?.message || "", /SIGTERM.*SIGKILL/s);
        return true;
      },
    );
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(existsSync(stateDir), true);
    assert.equal(acceptedSocket.destroyed, true);
    assert.equal(upstream.server.listening, false);
  } finally {
    client.destroy();
    upstream.server.closeAllConnections();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

nodeTest("primary and cleanup failures are retained together", async () => {
  const primary = new Error("injected primary failure");
  const cleanup = new Error("injected cleanup failure");

  await assert.rejects(
    preservePrimaryAndCleanup(
      async () => {
        throw primary;
      },
      async () => {
        throw cleanup;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      return true;
    },
  );
});

nodeTest("duplicate and late acquisitions create no extra listener, process, or state", async () => {
  const lifecycle = createLifecycle();
  let spawnCalls = 0;
  let duplicateGatewayCalls = 0;
  let gatewayServer;
  let router;

  try {
    const gw = await gateway((_request, response) => {
      response.writeHead(404);
      response.end();
    }, { lifecycle });
    gatewayServer = gw.server;
    router = run({}, {
      lifecycle,
      spawnProcess() {
        spawnCalls += 1;
        const child = new EventEmitter();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.signalCode = null;
        child.pid = 4242;
        child.kill = (signal) => {
          child.signalCode = signal;
          child.emit("exit", null, signal);
          return true;
        };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });

    await assert.rejects(
      gateway(() => {}, {
        lifecycle,
        createServer() {
          duplicateGatewayCalls += 1;
        },
      }),
      /already reserved a gateway/,
    );
    assert.throws(
      () => run({}, { lifecycle, spawnProcess: () => { spawnCalls += 1; } }),
      /already reserved a router child/,
    );
  } finally {
    await lifecycle.finishCleanup();
  }

  assert.throws(
    () => run({}, { lifecycle, spawnProcess: () => { spawnCalls += 1; } }),
    /lifecycle is closing; router creation refused/,
  );
  await assert.rejects(
    gateway(() => {}, {
      lifecycle,
      createServer() {
        duplicateGatewayCalls += 1;
      },
    }),
    /lifecycle is closing; gateway creation refused/,
  );
  assert.equal(spawnCalls, 1);
  assert.equal(duplicateGatewayCalls, 0);
  assert.equal(gatewayServer.listening, false);
  assert.equal(existsSync(router.stateDir), false);
});

nodeTest("cleanup awaits an already-reserved gateway acquisition before closing it", async () => {
  const lifecycle = createLifecycle();
  const releaseAcquisition = deferred();
  let observedListen;
  let gatewayServer;

  const acquisition = gateway(() => {}, {
    lifecycle,
    async createServer(handler, { lifecycleReservation }) {
      const server = http.createServer(handler);
      gatewayServer = server;
      lifecycleReservation.track(server);
      const listening = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      observedListen = listening.then(
        () => ({ status: "listening" }),
        (error) => ({ status: "error", error }),
      );
      await listening;
      await releaseAcquisition.promise;
      return { server, port: server.address().port };
    },
  });
  const observedAcquisition = acquisition.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );

  try {
    const listening = await boundedOutcome(
      observedListen,
      ACQUISITION_TIMEOUT_MS,
      "gateway listen outcome",
    );
    if (listening.status === "error") throw listening.error;
    const cleanup = lifecycle.finishCleanup();
    releaseAcquisition.resolve();
    const acquired = await boundedOutcome(
      observedAcquisition,
      ACQUISITION_TIMEOUT_MS,
      "gateway acquisition",
    );
    if (acquired.status === "rejected") throw acquired.error;
    await cleanup;
    assert.equal(gatewayServer.listening, false);
  } finally {
    releaseAcquisition.resolve();
    await Promise.allSettled([
      boundedOutcome(
        observedAcquisition,
        ACQUISITION_TIMEOUT_MS,
        "gateway acquisition settlement",
      ),
      lifecycle.finishCleanup(),
    ]);
  }
});

// An empty completion used to reach the client as a clean 200 the app
// recorded as a successful turn with no content. The router must retry the
// identical request once and only surface the retry's completion.
test("an empty completion is retried once and the retry's content reaches the client", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Upstream-Attempt": posts === 1 ? "first" : "retry",
    });
    response.write(posts === 1 ? EMPTY_SSE : CONTENT_SSE);
    response.end();
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    // The retry's content reached the client...
    assert.match(result.body, /Recovered/);
    assert.doesNotMatch(result.body, /r-empty|thinking/);
    assert.match(result.body, /r-content/);
    assert.equal(result.headers["x-upstream-attempt"], "retry");
    // ...and exactly one completed event did: the first attempt's terminal
    // events were suppressed.
    assert.equal((result.body.match(/event: response\.completed/g) || []).length, 1);
    assert.equal((result.body.match(/event: response\.done/g) || []).length, 1);
    // ...and so did exactly one prologue: the retry's duplicate
    // `response.created`, with its new id and restarted sequence numbers, must
    // not appear inside the response the client already opened.
    assert.equal((result.body.match(/event: response\.created/g) || []).length, 1);
    assert.deepEqual(
      [...result.body.matchAll(/"sequence_number":(\d+)/g)].map((match) => Number(match[1])),
      [0, 1, 2, 3, 4],
    );
    assert.equal(posts, 2, "the empty first attempt must be retried");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletionRetried, true);
    assert.equal(event.emptyCompletion, undefined);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

// The counterpart to the test above. Once the upstream streams reasoning, the
// hold is over and the attempt is on the wire, so the router cannot substitute
// a retry for it. It states the failure into the open stream instead. Holding
// the prologue for this case is what used to cost every reasoning turn seconds
// of dead air, and the silent rescue it bought landed on roughly one routed
// turn in a thousand.
test("a reasoning turn that ends empty is relayed and stated, never retried", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Upstream-Attempt": posts === 1 ? "first" : "retry",
    });
    response.end(posts === 1 ? REASONING_EMPTY_SSE : CONTENT_SSE);
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    // The reasoning the user watched arrive is still theirs...
    assert.match(result.body, /thinking/);
    assert.match(result.body, /r-empty/);
    // ...followed by a stated failure rather than a silent stop.
    assert.match(result.body, /event: error/);
    assert.match(result.body, /empty_completion/);
    // No second attempt: the response had already started.
    assert.equal(posts, 1, "a relayed attempt must not be retried");
    assert.doesNotMatch(result.body, /Recovered|r-content/);
    assert.equal(result.headers["x-upstream-attempt"], "first");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.emptyCompletion, true);
    assert.equal(event.emptyCompletionUnrepairable, true);
    assert.equal(event.emptyCompletionRetried, undefined);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

// If the retry is also empty, the client must see a stated error instead of a
// second silent success, and the meter must call it a failure.
test("a double-empty completion surfaces an error and meters 502", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write(EMPTY_SSE);
    response.end();
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 502);
    assert.equal(result.complete, true);
    assert.match(result.body, /empty_completion/);
    assert.doesNotMatch(result.body, /event: response\.completed/);
    assert.equal(posts, 2, "the empty first attempt must be retried exactly once");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 502);
    assert.equal(event.emptyCompletion, true);
    assert.equal(event.emptyCompletionRetried, true);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`);
    assert.equal((await health.json()).activity.state, "error");
  } finally {
    await lifecycle.cleanupEarly();
  }
});

// The retry can fail outright. The first attempt is still fully buffered, so
// replace its staged head with one deterministic router error and never relay
// the upstream's internal body.
test("a retry that fails upstream states the failure instead of relaying its body", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end(EMPTY_SSE);
      return;
    }
    const body = JSON.stringify({ error: { message: "upstream exploded", type: "server_error" } });
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(body);
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 502);
    assert.equal(result.complete, true);
    assert.match(result.body, /empty_completion_retry_failed/);
    // The upstream's own error body never reaches the stream.
    assert.doesNotMatch(result.body, /upstream exploded/);
    assert.doesNotMatch(result.body, /event: response\.completed/);
    assert.equal(posts, 2);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 502);
    assert.equal(event.emptyCompletion, true);
    assert.equal(event.emptyCompletionRetried, true);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

// Both attempts were sent and both were billed. A meter that reports only the
// retry understates a retried turn by an entire prompt.
test("a retried turn meters the tokens of both attempts", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.end(posts === 1 ? EMPTY_SSE_METERED : CONTENT_SSE_METERED);
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /Recovered/);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.emptyCompletionRetried, true);
    assert.equal(event.inputTokens, 200, "both prompts were sent, so both are reported");
    assert.equal(event.cachedInputTokens, 140);
    assert.equal(event.outputTokens, 5);
    assert.equal(event.totalTokens, 205);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

test("a retry that crosses the guard byte budget records the release", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(posts === 1 ? EMPTY_SSE : BUDGET_RELEASE_EMPTY_SSE);
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.match(result.body, /r-budget/);
    assert.equal(posts, 2);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletionRetried, true);
    assert.equal(event.emptyCompletionGuardReleased, true);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

test("a retry tool call uses the normal namespace response transform", async (lifecycle) => {
  let posts = 0;
  const toolCall = [
    "event: response.created",
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-tool"}}',
    "",
    "event: response.output_item.added",
    'data: {"type":"response.output_item.added","sequence_number":1,"item":{"type":"function_call","name":"collaboration__spawn_agent","call_id":"call_1"}}',
    "",
    "event: response.output_item.done",
    'data: {"type":"response.output_item.done","sequence_number":2,"item":{"type":"function_call","name":"collaboration__spawn_agent","call_id":"call_1","arguments":"{}"}}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","sequence_number":3,"response":{"id":"r-tool","output":[]}}',
    "",
    "event: response.done",
    'data: {"type":"response.done","sequence_number":4,"response":{"id":"r-tool"}}',
    "",
  ].join("\n");
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(posts === 1 ? EMPTY_SSE : toolCall);
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, {
      ...TURN_BODY,
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "spawn_agent" }],
        },
      ],
    });

    assert.equal(result.status, 200);
    assert.match(result.body, /"name":"spawn_agent"/);
    assert.match(result.body, /"namespace":"collaboration"/);
    assert.doesNotMatch(result.body, /collaboration__spawn_agent|r-empty|thinking/);
    assert.equal(posts, 2);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

test("multiline SSE content on the retry is not misclassified as empty", async (lifecycle) => {
  let posts = 0;
  const multiline = [
    "event: response.created",
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-multiline"}}',
    "",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","sequence_number":1,',
    'data: "delta":"Multiline recovered"}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","sequence_number":2,"response":{"id":"r-multiline","output":[]}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(posts === 1 ? EMPTY_SSE : multiline);
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /Multiline recovered/);
    assert.doesNotMatch(result.body, /r-empty|thinking/);
    assert.equal(posts, 2);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

for (const retryKind of ["json", "bodyless"]) {
  test(`a successful ${retryKind} retry becomes a deterministic protocol error`, async (lifecycle) => {
    let posts = 0;
    const gw = await gateway((_request, response) => {
      posts += 1;
      if (posts === 1) {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "X-Upstream-Attempt": "first",
        });
        response.end(EMPTY_SSE);
        return;
      }
      if (retryKind === "bodyless") {
        response.writeHead(204, { "X-Upstream-Attempt": "retry" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json",
        "X-Upstream-Attempt": "retry",
      });
      response.end(JSON.stringify({ secret: "must not enter the client response" }));
    }, { lifecycle });
    const routerPort = await openPort();
    const router = run(routerEnv(gw.port, routerPort), { lifecycle });

    try {
      await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
      const result = await readRouted(routerPort, TURN_BODY);
      assert.equal(result.status, 502);
      assert.match(result.body, /empty_completion_retry_protocol_error/);
      assert.doesNotMatch(result.body, /must not enter|r-empty|thinking/);
      assert.equal(result.headers["content-type"], "application/json");
      assert.equal(result.headers["x-upstream-attempt"], undefined);
      assert.equal(posts, 2);
    } finally {
      await lifecycle.cleanupEarly();
    }
  });
}

test("an incompatible JSON retry still contributes its reported usage", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(EMPTY_SSE_METERED);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "incompatible-json-retry",
        output: [],
        usage: {
          input_tokens: 100,
          output_tokens: 3,
          total_tokens: 103,
          input_tokens_details: { cached_tokens: 80 },
        },
      }),
    );
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 502);
    assert.match(result.body, /empty_completion_retry_protocol_error/);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.inputTokens, 200);
    assert.equal(event.outputTokens, 3);
    assert.equal(event.totalTokens, 203);
    assert.equal(event.cachedInputTokens, 140);
    assert.equal(event.emptyCompletionRetried, true);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

test("a transport-failed retry keeps first-attempt usage, cache, and markers", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(EMPTY_SSE_METERED);
      return;
    }
    response.socket.destroy();
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 502);
    assert.match(result.body, /empty_completion_retry_failed/);
    assert.doesNotMatch(result.body, /r-empty|thinking/);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 502);
    assert.equal(event.inputTokens, 100);
    assert.equal(event.outputTokens, 0);
    assert.equal(event.totalTokens, 100);
    assert.equal(event.cachedInputTokens, 60);
    assert.equal(event.emptyCompletion, true);
    assert.equal(event.emptyCompletionRetried, true);
    assert.match(
      await waitForLog(router, /timing .*status=502 .*cached_tokens=60/),
      /timing .*status=502 .*cached_tokens=60/,
    );
  } finally {
    await lifecycle.cleanupEarly();
  }
});

for (const [name, body, expected] of [
  ["custom tool input", CUSTOM_TOOL_CALL_SSE, /move pointer/],
  ["refusal events", REFUSAL_EVENT_SSE, /response\.refusal\.delta/],
  ["completed refusal output", REFUSAL_OUTPUT_SSE, /I cannot help with that/],
  ["chat-completions refusal", CHAT_REFUSAL_SSE, /I cannot help with that/],
]) {
  test(`valid ${name} is content and is never retried`, async (lifecycle) => {
    let posts = 0;
    const gw = await gateway((_request, response) => {
      posts += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(body);
    }, { lifecycle });
    const routerPort = await openPort();
    const router = run(routerEnv(gw.port, routerPort), { lifecycle });

    try {
      await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
      const result = await readRouted(routerPort, TURN_BODY);
      assert.equal(result.status, 200);
      assert.match(result.body, expected);
      assert.equal(posts, 1, "valid Responses output must not trigger an empty retry");

      const [event] = await waitForUsageEvents(router.stateDir, 1, router);
      assert.equal(event.status, 200);
      assert.equal(event.emptyCompletion, undefined);
      assert.equal(event.emptyCompletionRetried, undefined);
    } finally {
      await lifecycle.cleanupEarly();
    }
  });
}

test("a headerless first attempt preserves guard, usage, and namespace transforms", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200);
    let offset = 0;
    const sizes = [1, 1, 1, 2, 3, 5, 1, 4, 7, 2, 11];
    const writeNext = () => {
      if (offset >= HEADERLESS_PREFIX_TOOL_SSE.length) {
        response.end();
        return;
      }
      const size = sizes.shift() || HEADERLESS_PREFIX_TOOL_SSE.length;
      const next = Math.min(HEADERLESS_PREFIX_TOOL_SSE.length, offset + size);
      response.write(HEADERLESS_PREFIX_TOOL_SSE.subarray(offset, next));
      offset = next;
      setImmediate(writeNext);
    };
    writeNext();
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, {
      ...TURN_BODY,
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "spawn_agent" }],
        },
      ],
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /"name":"spawn_agent"/);
    assert.match(result.body, /"namespace":"collaboration"/);
    assert.doesNotMatch(result.body, /collaboration__spawn_agent/);
    assert.equal(posts, 1);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.inputTokens, 19);
    assert.equal(event.outputTokens, 2);
    assert.equal(event.totalTokens, 21);
    assert.equal(event.cachedInputTokens, 7);
    assert.equal(event.emptyCompletionRetried, undefined);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

test("a client cancel during the retry meters and logs status zero", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (posts === 1) {
      response.end(EMPTY_SSE);
      return;
    }
    response.write(
      [
        "event: response.created",
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-retry-cancel"}}',
        "",
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","sequence_number":1,"delta":"started"}',
        "",
        "",
      ].join("\n"),
    );
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    await new Promise((resolve) => {
      const base = new URL(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`);
      const request = http.request(
        {
          host: "127.0.0.1",
          port: routerPort,
          path: base.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer codex-caller-auth",
          },
        },
        (response) => {
          response.once("data", () => {
            request.destroy();
            resolve();
          });
        },
      );
      request.once("error", resolve);
      request.end(JSON.stringify(TURN_BODY));
    });

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(posts, 2);
    assert.equal(event.status, 0);
    assert.equal(event.emptyCompletion, undefined);
    assert.equal(event.emptyCompletionRetried, true);
    assert.match(await waitForLog(router, /timing .*status=0 /), /timing .*status=0 /);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`).then((r) => r.json());
    assert.equal(health.activity.state, "idle");
  } finally {
    await lifecycle.cleanupEarly();
  }
});

test("a client cancel while an incompatible retry body stalls is not a protocol error", async (lifecycle) => {
  let posts = 0;
  let retryBodyStartedResolve;
  const retryBodyStarted = new Promise((resolve) => {
    retryBodyStartedResolve = resolve;
  });
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(EMPTY_SSE);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"id":"stalled-retry","usage":');
    retryBodyStartedResolve();
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    let responseStarted = false;
    const base = new URL(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`);
    const request = http.request(
      {
        host: "127.0.0.1",
        port: routerPort,
        path: base.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer codex-caller-auth",
        },
      },
      () => {
        responseStarted = true;
      },
    );
    request.on("error", () => {});
    request.end(JSON.stringify(TURN_BODY));

    await retryBodyStarted;
    request.destroy();

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(posts, 2);
    assert.equal(responseStarted, false, "the staged response head must remain hidden");
    assert.equal(event.status, 0);
    assert.equal(event.emptyCompletion, undefined);
    assert.equal(event.emptyCompletionRetried, true);
    assert.match(await waitForLog(router, /timing .*status=0 /), /timing .*status=0 /);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`).then((r) => r.json());
    assert.equal(health.activity.state, "idle");
  } finally {
    await lifecycle.cleanupEarly();
  }
});

test("a headerless SSE retry is relayed through the normal pipeline", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(EMPTY_SSE);
      return;
    }
    response.writeHead(200, { "X-Upstream-Attempt": "retry" });
    response.write(CONTENT_SSE.slice(0, 3));
    setImmediate(() => response.end(CONTENT_SSE.slice(3)));
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /Recovered/);
    assert.equal(result.headers["content-type"], undefined);
    assert.equal(result.headers["x-upstream-attempt"], "retry");
    assert.equal(posts, 2);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

test("a headerless non-SSE retry is still a deterministic protocol error", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(EMPTY_SSE);
      return;
    }
    response.writeHead(200);
    response.end(JSON.stringify({ secret: "headerless json must not be relayed" }));
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 502);
    assert.match(result.body, /empty_completion_retry_protocol_error/);
    assert.doesNotMatch(result.body, /headerless json must not be relayed/);
    assert.equal(posts, 2);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

// The retry re-sends the whole prompt. An operator who would rather pay once
// can turn the guard off, and the router must then behave exactly as it did
// before it existed: one attempt, terminal events relayed, no markers.
test("the guard can be turned off and the turn relays exactly as before", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.end(EMPTY_SSE);
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run({
    ...routerEnv(gw.port, routerPort),
    CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "0",
  }, { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.match(result.body, /event: response\.completed/);
    assert.match(result.body, /event: response\.done/);
    assert.doesNotMatch(result.body, /event: error/);
    assert.equal(posts, 1, "the guard is off, so nothing is retried");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletion, undefined);
    assert.equal(event.emptyCompletionRetried, undefined);
  } finally {
    await lifecycle.cleanupEarly();
  }
});

// A normal turn must be untouched: one upstream attempt, no retry, no markers.
test("a content turn is not retried and carries no empty-completion markers", async (lifecycle) => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write(CONTENT_SSE);
    response.end();
  }, { lifecycle });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort), { lifecycle });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.match(result.body, /Recovered/);
    assert.equal(posts, 1, "a content turn must not be retried");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletion, undefined);
    assert.equal(event.emptyCompletionRetried, undefined);
  } finally {
    await lifecycle.cleanupEarly();
  }
});
