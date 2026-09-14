import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  buildDefaultNousHostGateCommand,
  buildNousHostGateSpawnOptions,
  createNousHostGateFetch,
  NOUS_HOST_GATE_LOCK_NAME,
  NOUS_HOST_GATE_MAX_RESPONSE_BYTES,
  NOUS_HOST_GATE_MAX_STDERR_BYTES,
  NOUS_HOST_GATE_MODEL,
  NOUS_HOST_GATE_PROVIDER,
  NOUS_HOST_GATE_PROVIDER_STOP_STATUS,
  NOUS_HOST_GATE_PROTOCOL,
} from "../src/nous-host-gate.mjs";

class LeaseFixture extends EventEmitter {
  constructor({
    ready = true,
    release = true,
    close = true,
    releasedStatus,
    onSpawn,
  } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdinBytes = "";
    this.completions = [];
    this.releaseCount = 0;
    this.killCount = 0;
    this.closed = false;
    this.releaseEnabled = release;
    this.closeEnabled = close;
    this.releasedStatus = releasedStatus;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.stdinBytes += Buffer.from(chunk).toString("utf8");
        let newline;
        while ((newline = this.stdinBytes.indexOf("\n")) !== -1) {
          const line = this.stdinBytes.slice(0, newline);
          this.stdinBytes = this.stdinBytes.slice(newline + 1);
          try {
            this.completions.push(JSON.parse(line));
          } catch {
            // The gate under test should reject malformed helper input before
            // a real helper could observe it; the assertion sees no release.
          }
        }
        callback();
      },
    });
    this.stdin.on("finish", () => {
      if (this.releaseEnabled) this.release();
    });
    queueMicrotask(() => {
      onSpawn?.(this);
      if (ready) this.ready();
    });
  }

  ready() {
    if (!this.closed) {
      this.stdout.write(JSON.stringify({
        schema: NOUS_HOST_GATE_PROTOCOL,
        event: "ready",
        provider: NOUS_HOST_GATE_PROVIDER,
        model: NOUS_HOST_GATE_MODEL,
        timeout_seconds: 300,
        lock: {
          name: NOUS_HOST_GATE_LOCK_NAME,
          path: "C:\\synthetic\\provider-attempt.lock",
          device: 1,
          inode: 2,
        },
      }) + "\n");
    }
  }

  release() {
    if (this.closed || this.releaseCount) return;
    this.releaseCount += 1;
    const status = this.releasedStatus === undefined
      ? this.completions.at(-1)?.status ?? null
      : this.releasedStatus;
    this.stdout.write(
      JSON.stringify({
        schema: NOUS_HOST_GATE_PROTOCOL,
        event: "released",
        status,
      }) + "\n",
    );
    if (this.closeEnabled) this.close(0, null);
  }

  close(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  unexpectedExit(code = 1, signal = null) {
    this.close(code, signal);
  }

  kill() {
    this.killCount += 1;
    this.stdout.destroy();
    this.stderr.destroy();
    this.stdin.destroy();
    this.close(null, "SIGTERM");
  }
}

function fixtureGate(fixture, fetchImpl, timeoutMs = 500) {
  const spawnCalls = [];
  const gate = createNousHostGateFetch({
    fetchImpl,
    timeoutMs,
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return fixture;
    },
  });
  gate.spawnCalls = spawnCalls;
  return gate;
}

test("default commands name only the canonical installed launcher or bridge", () => {
  const windows = buildDefaultNousHostGateCommand({
    platform: "win32",
    homeDirectory: "C:\\Users\\LeaseTest",
    systemRoot: "D:\\Windows",
    leaseTimeoutSeconds: 2,
  });
  assert.equal(
    windows.command,
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.deepEqual(windows.args, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "C:\\Users\\LeaseTest\\.codex\\tools\\launch-bridge.ps1",
    "-ProviderLease",
    "-ProviderLeaseTimeout",
    "2",
  ]);
  assert.equal(windows.options.shell, false);

  const unix = buildDefaultNousHostGateCommand({
    platform: "linux",
    homeDirectory: "/home/lease-test",
    leaseTimeoutSeconds: 2,
  });
  assert.equal(unix.command, "/home/lease-test/.codex/tools/nous_codex_bridge.py");
  assert.deepEqual(unix.args, [
    "--provider-lease",
    "--provider-lease-timeout",
    "2",
  ]);
  assert.equal(unix.options.shell, false);
});

test("spawn options preserve Windows launcher inheritance and strip Unix key env", () => {
  const inherited = { NOUS_API_KEY: "test-key", ROUTER_TEST_VALUE: "preserve" };
  const windows = buildNousHostGateSpawnOptions({
    platform: "win32",
    inheritedEnvironment: inherited,
  });
  assert.equal(windows.env, undefined);
  assert.deepEqual(windows.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(windows.shell, false);

  const unix = buildNousHostGateSpawnOptions({
    platform: "linux",
    inheritedEnvironment: inherited,
  });
  assert.notEqual(unix.env, inherited);
  assert.equal(unix.env.NOUS_API_KEY, undefined);
  assert.equal(unix.env.ROUTER_TEST_VALUE, "preserve");
  assert.deepEqual(unix.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(unix.shell, false);
});

test("ready, body completion, status completion, release, and clean close form one gate", async () => {
  const fixture = new LeaseFixture();
  let requestSignal;
  const gate = fixtureGate(fixture, async (_input, init) => {
    requestSignal = init.signal;
    return new Response("provider body", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });

  const response = await gate("https://example.test/provider");
  assert.equal(await response.text(), "provider body");
  assert.equal(requestSignal.aborted, false);
  assert.deepEqual(fixture.completions, [{ status: 200 }]);
  assert.equal(fixture.releaseCount, 1);
  assert.equal(fixture.killCount, 0);
  assert.equal(gate.spawnCalls.length, 1);
  assert.equal(gate.spawnCalls[0].options.shell, false);
  assert.deepEqual(gate.spawnCalls[0].options.stdio, ["pipe", "pipe", "pipe"]);
});

test("a 402 response is returned only after its status is acknowledged and released", async () => {
  const fixture = new LeaseFixture();
  const gate = fixtureGate(
    fixture,
    async () => new Response("payment required", { status: 402 }),
  );

  const response = await gate("https://example.test/provider");
  assert.equal(response.status, 402);
  const safeBody = await response.text();
  assert.equal(safeBody.includes("payment required"), false);
  assert.equal(safeBody.includes("nous_host_gate_provider_stop"), true);
  assert.deepEqual(fixture.completions, [{ status: 402 }]);
  assert.equal(fixture.releaseCount, 1);
});

test("a stalled 402 body is cancelled and still completes the 402 lease", async () => {
  const fixture = new LeaseFixture();
  let fetchCalls = 0;
  let cancelled = false;
  const gate = fixtureGate(
    fixture,
    async () => {
      fetchCalls += 1;
      return {
        status: NOUS_HOST_GATE_PROVIDER_STOP_STATUS,
        headers: new Headers({ "content-type": "application/json" }),
        body: {
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        },
      };
    },
    100,
  );

  const response = await gate("https://example.test/provider");
  const safeBody = await response.text();
  assert.equal(response.status, NOUS_HOST_GATE_PROVIDER_STOP_STATUS);
  assert.equal(fetchCalls, 1);
  assert.equal(cancelled, true);
  assert.deepEqual(fixture.completions, [{ status: NOUS_HOST_GATE_PROVIDER_STOP_STATUS }]);
  assert.equal(fixture.releaseCount, 1);
  assert.equal(safeBody.includes("provider body"), false);
});

test("an oversized 402 body is never drained or exposed before stop completion", async () => {
  const fixture = new LeaseFixture();
  const gate = fixtureGate(
    fixture,
    async () => new Response("private provider body", {
      status: NOUS_HOST_GATE_PROVIDER_STOP_STATUS,
      headers: {
        "content-length": String(NOUS_HOST_GATE_MAX_RESPONSE_BYTES + 1),
        "x-provider-secret": "must-not-escape",
      },
    }),
    100,
  );

  const response = await gate("https://example.test/provider");
  const safeBody = await response.text();
  assert.equal(response.status, NOUS_HOST_GATE_PROVIDER_STOP_STATUS);
  assert.deepEqual(fixture.completions, [{ status: NOUS_HOST_GATE_PROVIDER_STOP_STATUS }]);
  assert.equal(fixture.releaseCount, 1);
  assert.equal(safeBody.includes("private provider body"), false);
  assert.equal(response.headers.get("x-provider-secret"), null);
});

test("released status must match the one completion sent by the caller", async () => {
  const fixture = new LeaseFixture({ releasedStatus: 201 });
  const gate = fixtureGate(
    fixture,
    async () => new Response("body", { status: 200 }),
    100,
  );

  await assert.rejects(
    gate("https://example.test/provider"),
    (error) => {
      assert.equal(error.code, "nous_host_gate_reconcile_required");
      assert.equal(error.resend, false);
      return true;
    },
  );
  assert.deepEqual(fixture.completions, [{ status: 200 }]);
  assert.equal(fixture.releaseCount, 1);
});

test("malformed protocol fails closed before fetch and exposes no child text", async () => {
  const fixture = new LeaseFixture({
    ready: false,
    onSpawn: (child) => queueMicrotask(() => child.stdout.write(
      '{"schema":"codex-nous-provider-lease-v0","event":"ready"}\n',
    )),
  });
  let fetchCalls = 0;
  const gate = fixtureGate(fixture, async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  }, 100);

  await assert.rejects(
    gate("https://example.test/provider"),
    (error) => {
      assert.equal(error.code, "nous_host_gate_protocol_failed");
      assert.equal(error.reconcile, true);
      assert.equal(error.resend, false);
      assert.equal(error.message.includes("private"), false);
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
  assert.ok(fixture.killCount >= 1);
});

test("unexpected helper exit aborts an in-flight fetch", async () => {
  const fixture = new LeaseFixture();
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  let observedSignal;
  const gate = fixtureGate(fixture, (_input, init) => {
    observedSignal = init.signal;
    return new Promise((_resolve) => {
      init.signal.addEventListener("abort", () => undefined, {
        once: true,
      });
      started();
    });
  });

  const request = gate("https://example.test/provider");
  await startedPromise;
  fixture.unexpectedExit(1, null);
  await assert.rejects(
    request,
    (error) => {
      assert.equal(error.code, "nous_host_gate_protocol_failed");
      assert.equal(error.message.includes("secret"), false);
      assert.equal(error.resend, false);
      return true;
    },
  );
  assert.equal(observedSignal.aborted, true);
});

test("helper timeout after status completion requires reconciliation and never resends", async () => {
  const fixture = new LeaseFixture({ release: false });
  const gate = fixtureGate(
    fixture,
    async () => new Response("body", { status: 200 }),
    60,
  );

  await assert.rejects(
    gate("https://example.test/provider"),
    (error) => {
      assert.equal(error.code, "nous_host_gate_reconcile_required");
      assert.equal(error.resend, false);
      return true;
    },
  );
  assert.deepEqual(fixture.completions, [{ status: 200 }]);
  assert.ok(fixture.killCount >= 1);
});

test("caller abort sends one null completion and still waits for release", async () => {
  const fixture = new LeaseFixture();
  const controller = new AbortController();
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const gate = fixtureGate(fixture, (_input, init) => {
    started();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("private abort detail")), {
        once: true,
      });
    });
  });

  const request = gate("https://example.test/provider", { signal: controller.signal });
  await startedPromise;
  controller.abort();
  await assert.rejects(
    request,
    (error) => {
      assert.equal(error.code, "nous_host_gate_aborted");
      assert.equal(error.resend, false);
      assert.equal(error.message.includes("private"), false);
      return true;
    },
  );
  assert.deepEqual(fixture.completions, [{ status: null }]);
  assert.equal(fixture.releaseCount, 1);
});

test("stderr is bounded and cannot become a diagnostic side channel", async () => {
  const fixture = new LeaseFixture({
    onSpawn: (child) => child.stderr.write(
      Buffer.alloc(NOUS_HOST_GATE_MAX_STDERR_BYTES + 1, 0x58),
    ),
  });
  let fetchCalls = 0;
  const gate = fixtureGate(fixture, async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  }, 100);

  await assert.rejects(
    gate("https://example.test/provider"),
    (error) => {
      assert.equal(error.code, "nous_host_gate_protocol_failed");
      assert.equal(error.message.includes("X"), false);
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
});

const composedBridge = process.env.NOUS_BRIDGE_SOURCE;
const composedPython = process.env.NOUS_PYTHON;
const composedAvailable = Boolean(
  composedBridge &&
  composedPython &&
  existsSync(composedBridge) &&
  existsSync(composedPython),
);

test("composed provider-free gate accepts the reviewed bridge CLI contract", {
  skip: !composedAvailable,
}, async (t) => {
  const isolated = mkdtempSync(path.join(os.tmpdir(), "nous-host-gate-composed-"));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));

  const childEnvironment = { ...process.env };
  for (const name of [
    "NOUS_API_KEY",
    "DEEPSEEK_API_KEY",
    "CODEX_NOUS_ALLOW_USER_ENV_CREDENTIAL",
    "CODEX_NOUS_SERIALIZATION_PROOF",
  ]) {
    delete childEnvironment[name];
  }
  childEnvironment.HOME = isolated;
  childEnvironment.USERPROFILE = isolated;
  childEnvironment.LOCALAPPDATA = path.join(isolated, "LocalAppData");
  childEnvironment.XDG_CACHE_HOME = path.join(isolated, "Cache");

  const rawEvents = [];
  let commandRecord;
  const spawnImpl = (_command, _args, options) => {
    const args = [
      "-I",
      composedBridge,
      "--provider-lease",
      "--provider-lease-timeout",
      "5",
    ];
    commandRecord = { command: composedPython, args };
    const child = spawn(composedPython, args, {
      ...options,
      cwd: isolated,
      env: childEnvironment,
    });
    child.stdout.on("data", (chunk) => rawEvents.push(Buffer.from(chunk)));
    return child;
  };

  let fetchCalls = 0;
  let signalProvided = false;
  const gate = createNousHostGateFetch({
    timeoutMs: process.platform === "win32" ? 30_000 : 5_000,
    spawnImpl,
    fetchImpl: async (_input, init) => {
      fetchCalls += 1;
      signalProvided = Boolean(init?.signal);
      return new Response("provider-free", { status: 200 });
    },
  });

  const marker = path.join(
    os.userInfo().homedir,
    ".codex",
    "state",
    "nous_provider_stop.json",
  );
  const markerBefore = existsSync(marker) ? statSync(marker).mtimeMs : null;
  const response = await gate("https://example.invalid/provider");
  const body = await response.text();
  const markerAfter = existsSync(marker) ? statSync(marker).mtimeMs : null;
  const events = Buffer.concat(rawEvents)
    .toString("utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));

  assert.deepEqual(events.map((event) => event.event), ["ready", "released"]);
  assert.equal(events[0].schema, "codex-nous-provider-lease-v1");
  assert.equal(events[0].provider, "nous");
  assert.equal(events[0].model, "deepseek/deepseek-v4.1-flash");
  assert.equal(events[1].schema, events[0].schema);
  assert.equal(events[1].status, 200);
  assert.equal(response.status, 200);
  assert.equal(body, "provider-free");
  assert.equal(fetchCalls, 1);
  assert.equal(signalProvided, true);
  assert.equal(markerAfter, markerBefore);
  assert.deepEqual(commandRecord.args.slice(2), [
    "--provider-lease",
    "--provider-lease-timeout",
    "5",
  ]);
  assert.equal(
    Object.keys(childEnvironment).some((name) =>
      ["NOUS_API_KEY", "DEEPSEEK_API_KEY", "CODEX_NOUS_ALLOW_USER_ENV_CREDENTIAL"].includes(name)),
    false,
  );
  process.stdout.write("composed provider-free receipt " + JSON.stringify({
    schema: events[0].schema,
    events: events.map((event) => event.event),
    released_status: events[1].status,
    provider: events[0].provider,
    model: events[0].model,
    response_status: response.status,
    fetch_calls: fetchCalls,
    signal_provided: signalProvided,
    marker_unchanged: markerAfter === markerBefore,
    child_args: commandRecord.args.slice(2),
  }) + "\n");
});
