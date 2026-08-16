import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { STARTUP_TIMEOUT_MS, startupTimeoutMs, stopChild } from "./process-helpers.mjs";

class FakeChild extends EventEmitter {
  constructor(onKill) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
    this.onKill = onKill;
  }

  kill(signal) {
    assert.ok(this.listenerCount("exit") > 0, `${signal} must follow the exit listener`);
    assert.ok(this.listenerCount("error") > 0, `${signal} must follow the error listener`);
    this.signals.push(signal);
    return this.onKill?.(signal, this) ?? true;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

test("startup timeout gives Windows extra process-launch time", () => {
  assert.equal(startupTimeoutMs("win32"), 30_000);
  assert.equal(startupTimeoutMs("linux"), 5_000);
  assert.equal(startupTimeoutMs("darwin"), 5_000);
  assert.equal(STARTUP_TIMEOUT_MS, startupTimeoutMs(process.platform));
});

test("stopChild observes a child that exits immediately after SIGTERM", async () => {
  const child = new FakeChild((signal, current) => {
    current.exit(null, signal);
    return true;
  });

  await stopChild(child, { gracefulTimeoutMs: 0, forceTimeoutMs: 0 });

  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("stopChild escalates an ignored SIGTERM and observes the forced exit", async () => {
  const child = new FakeChild((signal, current) => {
    if (signal === "SIGKILL") current.exit(null, signal);
    return true;
  });

  await stopChild(child, { gracefulTimeoutMs: 0, forceTimeoutMs: 0 });

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("stopChild fails explicitly when even SIGKILL does not stop the child", async () => {
  const child = new FakeChild(() => false);

  await assert.rejects(
    stopChild(child, {
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 0,
      description: "stuck test router",
    }),
    /Failed to stop stuck test router:.*SIGTERM.*SIGKILL.*not delivered/s,
  );
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
