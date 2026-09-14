import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withServiceOperationLock } from "../src/service-operation-lock.mjs";

const root = path.resolve(".");

test("only a final service shutdown stops router-managed Ollama", () => {
  const source = readFileSync(path.join(root, "src", "service.mjs"), "utf8");
  assert.match(source, /shutdownCommands = new Set\(\["stop", "uninstall"\]\)/);
  assert.match(source, /shutdownCommands\.has\(command\).*stopManagedOllama\(\)/s);
  const declaration = source.match(/shutdownCommands = new Set\((\[[^\n]+\])\)/)?.[1];
  assert.equal(declaration, '["stop", "uninstall"]');
});

test("Windows service readiness covers the launcher and gateway startup budget", () => {
  const service = readFileSync(path.join(root, "src", "service.mjs"), "utf8");
  const waitHealth = readFileSync(path.join(root, "src", "wait-health.mjs"), "utf8");

  // The Windows chain adds VBS, CMD, PowerShell, forwarders, and frontend
  // startup around LiteLLM's 300-second cold-start allowance. Keep the shorter
  // existing budget on other hosts and preserve an explicit CLI override.
  assert.match(service, /const READINESS_TIMEOUT_MS = platform === "win32" \? 600_000 : 300_000;/);
  assert.match(waitHealth, /const defaultTimeoutMs = platform === "win32" \? 600_000 : 300_000;/);
  assert.match(waitHealth, /process\.argv\[3\] \|\| defaultTimeoutMs/);
});

test("service operation lock rejects overlap and releases afterward", { timeout: 5_000 }, async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-service-lock-"));
  let allowFirstToFinish;
  const firstCanFinish = new Promise((resolve) => {
    allowFirstToFinish = resolve;
  });
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });

  const first = withServiceOperationLock(async () => {
    markFirstEntered();
    await firstCanFinish;
    return "first";
  }, { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 });

  try {
    await firstEntered;
    await assert.rejects(
      withServiceOperationLock(
        async () => "overlap",
        { stateDir, waitMs: 50, retryMs: 10, staleMs: 5_000 },
      ),
      /Another background-service operation is still running/,
    );

    allowFirstToFinish();
    assert.equal(await first, "first");
    assert.equal(
      await withServiceOperationLock(
        async () => "second",
        { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 },
      ),
      "second",
    );
    await assert.rejects(
      withServiceOperationLock(
        async () => {
          throw new Error("operation failed");
        },
        { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 },
      ),
      /operation failed/,
    );
    assert.equal(
      await withServiceOperationLock(
        async () => "after failure",
        { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 },
      ),
      "after failure",
    );
  } finally {
    allowFirstToFinish();
    await first.catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});
