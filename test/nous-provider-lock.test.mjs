import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acquireNousProviderAttemptLock,
  NOUS_PROVIDER_ATTEMPT_LOCK_ACQUIRED_LINE,
  NOUS_PROVIDER_ATTEMPT_LOCK_HELPER,
  withNousProviderAttemptLock,
} from "../src/nous-provider-lock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_MODULE = pathToFileURL(path.join(ROOT, "src", "nous-provider-lock.mjs")).href;

function holdWorker(cacheRoot, timeoutMs = 2_000) {
  const source = `
    import { acquireNousProviderAttemptLock } from ${JSON.stringify(LOCK_MODULE)};
    let release;
    try {
      release = await acquireNousProviderAttemptLock({ cacheRoot: ${JSON.stringify(cacheRoot)}, timeoutMs: ${timeoutMs} });
      process.stdout.write("acquired\\n");
      process.stdin.resume();
      process.stdin.on("end", async () => {
        try {
          await release();
          process.stdout.write("released\\n");
          process.exit(0);
        } catch (error) {
          process.stderr.write(String(error?.code || error?.message || error));
          process.exit(3);
        }
      });
    } catch (error) {
      process.stderr.write(String(error?.code || error?.message || error));
      process.exit(2);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.testStderr = () => stderr;
  return child;
}

function waitForLine(child, expected, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${expected}: ${child.testStderr?.() || ""}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line === expected) {
          cleanup();
          resolve(line);
          return;
        }
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`child exited before ${expected}: ${code ?? signal}`));
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for lock worker"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function cleanupRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

test("the Node helper uses the MCP lock path and serializes separate processes", { timeout: 10_000 }, async () => {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-nous-lock-serial-"));
  const first = holdWorker(cacheRoot, 2_000);
  let second;
  try {
    await waitForLine(first, "acquired");
    const lockDir = path.join(cacheRoot, "codex-nous");
    const lockFile = path.join(lockDir, "provider-attempt.lock");
    assert.equal(statSync(lockDir).mode & 0o777, 0o700);
    assert.equal(statSync(lockFile).mode & 0o777, 0o600);

    second = holdWorker(cacheRoot, 150);
    const secondExit = await waitForExit(second);
    assert.equal(secondExit.code, 2, second.testStderr());
    assert.match(second.testStderr(), /nous_provider_lock_timeout|timed out/i);

    first.stdin.end();
    const firstExit = await waitForExit(first);
    assert.equal(firstExit.code, 0, first.testStderr());

    const third = holdWorker(cacheRoot, 1_000);
    try {
      await waitForLine(third, "acquired");
      third.stdin.end();
      assert.equal((await waitForExit(third)).code, 0, third.testStderr());
    } finally {
      if (third.exitCode === null) third.kill("SIGKILL");
    }
  } finally {
    if (second && second.exitCode === null) second.kill("SIGKILL");
    if (first.exitCode === null) first.kill("SIGKILL");
    cleanupRoot(cacheRoot);
  }
});

test("the Node helper interoperates with a Python fcntl holder at the MCP path", { timeout: 10_000 }, async () => {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-nous-lock-python-interop-"));
  const holderPath = path.join(cacheRoot, "python-holder.py");
  const source = [
    "import fcntl, os, pathlib, sys",
    "root = pathlib.Path(os.environ[\"XDG_CACHE_HOME\"]) / \"codex-nous\"",
    "root.mkdir(mode=0o700, parents=True, exist_ok=True)",
    "target = root / \"provider-attempt.lock\"",
    "fd = os.open(target, os.O_CREAT | os.O_RDWR, 0o600)",
    "os.fchmod(fd, 0o600)",
    "fcntl.flock(fd, fcntl.LOCK_EX)",
    "print(\"python-acquired\", flush=True)",
    "sys.stdin.buffer.read()",
    "fcntl.flock(fd, fcntl.LOCK_UN)",
    "os.close(fd)",
  ].join("\n");
  writeFileSync(holderPath, source, { mode: 0o700 });
  chmodSync(holderPath, 0o700);
  const holder = spawn(process.env.CODEX_ROUTER_NOUS_LOCK_PYTHON || "python3", [holderPath], {
    cwd: ROOT,
    env: { XDG_CACHE_HOME: cacheRoot, PATH: process.env.PATH || "", PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  holder.stdout.setEncoding("utf8");
  try {
    await waitForLine(holder, "python-acquired");
    await assert.rejects(
      acquireNousProviderAttemptLock({ cacheRoot, timeoutMs: 120 }),
      (error) => error?.code === "nous_provider_lock_timeout",
    );
    holder.stdin.end();
    assert.equal((await waitForExit(holder)).code, 0);
    const release = await acquireNousProviderAttemptLock({ cacheRoot, timeoutMs: 1_000 });
    await release();
  } finally {
    if (holder.exitCode === null) holder.kill("SIGKILL");
    cleanupRoot(cacheRoot);
  }
});

test("with-lock releases after callback exceptions and aborts waiting acquisition", { timeout: 10_000 }, async () => {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-nous-lock-release-"));
  const first = holdWorker(cacheRoot, 2_000);
  try {
    await waitForLine(first, "acquired");
    const controller = new AbortController();
    const waiting = acquireNousProviderAttemptLock({ cacheRoot, timeoutMs: 2_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 75).unref?.();
    await assert.rejects(waiting, (error) => error?.name === "AbortError");

    first.stdin.end();
    assert.equal((await waitForExit(first)).code, 0, first.testStderr());
    await assert.rejects(
      withNousProviderAttemptLock(async () => {
        throw new Error("callback failed");
      }, { cacheRoot, timeoutMs: 1_000 }),
      /callback failed/,
    );
    const release = await acquireNousProviderAttemptLock({ cacheRoot, timeoutMs: 1_000 });
    await release();
  } finally {
    if (first.exitCode === null) first.kill("SIGKILL");
    cleanupRoot(cacheRoot);
  }
});

test("helper death fails closed instead of pretending the lock is held", { timeout: 10_000 }, async () => {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-nous-lock-death-"));
  const helperPath = path.join(cacheRoot, "exits-after-acquire.py");
  writeFileSync(
    helperPath,
    `import sys\nprint(${JSON.stringify(NOUS_PROVIDER_ATTEMPT_LOCK_ACQUIRED_LINE)}, flush=True)\nsys.exit(7)\n`,
    { mode: 0o700 },
  );
  chmodSync(helperPath, 0o700);
  try {
    const release = await acquireNousProviderAttemptLock({
      cacheRoot,
      timeoutMs: 1_000,
      helperPath,
      pythonCommand: process.env.CODEX_ROUTER_NOUS_LOCK_PYTHON || "python3",
    });
    await assert.rejects(release(), /exited unexpectedly while held/);
    const nextRelease = await acquireNousProviderAttemptLock({ cacheRoot, timeoutMs: 1_000 });
    await nextRelease();
  } finally {
    cleanupRoot(cacheRoot);
  }
});

test("missing Python runtime reports an actionable lock error", async () => {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-nous-lock-runtime-"));
  try {
    await assert.rejects(
      acquireNousProviderAttemptLock({ cacheRoot, pythonCommand: path.join(cacheRoot, "missing-python") }),
      (error) => error?.code === "nous_provider_lock_runtime_missing" && /install Python|CODEX_ROUTER_NOUS_LOCK_PYTHON/.test(error.message),
    );
  } finally {
    cleanupRoot(cacheRoot);
  }
});

test("the checked-in helper exposes the same fixed acquisition line", async () => {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-nous-lock-helper-"));
  const child = spawn(process.env.CODEX_ROUTER_NOUS_LOCK_PYTHON || "python3", [NOUS_PROVIDER_ATTEMPT_LOCK_HELPER, "--timeout-seconds", "1"], {
    cwd: ROOT,
    env: { XDG_CACHE_HOME: cacheRoot, PATH: process.env.PATH || "", PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdout.setEncoding("utf8");
  try {
    await waitForLine(child, NOUS_PROVIDER_ATTEMPT_LOCK_ACQUIRED_LINE);
    child.stdin.end();
    assert.equal((await waitForExit(child)).code, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    cleanupRoot(cacheRoot);
  }
});
