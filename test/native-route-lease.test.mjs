import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  rmdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = mkdtempSync(path.join(os.tmpdir(), "native-route-lease-"));
const stateDir = path.join(testRoot, "state");
const workspace = path.join(testRoot, "workspace");
const home = path.join(testRoot, "home");
const tokenDir = path.join(home, ".threadspan", "secrets");
const tokenFile = path.join(tokenDir, "main.token");
mkdirSync(workspace, { recursive: true });
mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
writeFileSync(tokenFile, "test-threadspan-owner-token-123456\n", { mode: 0o600 });
process.env.HOME = home;
process.env.CODEX_HOME = path.join(home, ".codex");
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  claimNativeRouteLease, clearNativeRouteLease, nativeRouteLeaseStatus,
} = await import("../src/native-route-lease.mjs");
const {
  NATIVE_ROUTE_LEASE_LOCK_PATH, NATIVE_ROUTE_LEASE_PATH, PROVIDER_SELECTION_PATH,
} = await import("../src/paths.mjs");

const THREAD = "01a035a2-f151-77c1-8c62-28e2b719599b";
const SECOND_THREAD = "02a035a2-f151-77c1-8c62-28e2b719599b";
const ROOT_TURN = "11a035a2-f151-77c1-8c62-28e2b719599b";
const SECOND_ROOT = "12a035a2-f151-77c1-8c62-28e2b719599b";
const ATTEMPT = "21a035a2-f151-77c1-8c62-28e2b719599b";
const CONSULT = "consult/grok-build/grok-4.6";
const INTEGRATED = "integrated/nous/deepseek/deepseek-v4-flash-0731";

function reset() {
  for (const target of [NATIVE_ROUTE_LEASE_PATH, PROVIDER_SELECTION_PATH]) {
    if (existsSync(target)) unlinkSync(target);
  }
  if (existsSync(NATIVE_ROUTE_LEASE_LOCK_PATH)) rmSync(NATIVE_ROUTE_LEASE_LOCK_PATH, { recursive: true });
}

function request({
  threadId = THREAD, rootTurnId = ROOT_TURN, turnId = ATTEMPT,
  outputs = [], cwd = workspace, metadata,
} = {}) {
  return {
    headers: {
      "x-codex-turn-metadata": JSON.stringify({
        turn: { thread_id: threadId, root_turn_id: rootTurnId, turn_id: turnId },
        workspaces: { [cwd]: {} },
      }),
    },
    payload: {
      ...(metadata !== undefined ? { metadata } : {}),
      client_metadata: { thread_id: threadId, root_turn_id: rootTurnId, turn_id: turnId },
      input: outputs.map((call_id) => ({ type: "function_call_output", call_id, output: "ok" })),
    },
  };
}

function claim(route, value) {
  return claimNativeRouteLease(route, route, value.headers, value.payload);
}

test("native picker selection alone creates an exact one-request Consult lease", () => {
  reset();
  assert.deepEqual(nativeRouteLeaseStatus(), { configured: false, activeCount: 0, tombstoneCount: 0 });
  const first = claim(CONSULT, request());
  assert.equal(first.ok, true);
  assert.equal(first.lease.authority, "native-picker-selection");
  assert.equal(first.lease.threadId, THREAD);
  assert.equal(first.lease.boundTurnId, ROOT_TURN);
  assert.equal(first.lease.remainingRequests, 0);
  assert.equal(first.lease.exhausted, true);
  assert.equal(first.lease.tombstone, true);
  assert.equal(first.lease.expiresAt - first.lease.lastClaimAt, 30 * 60_000);
  const duplicate = claim(CONSULT, request());
  assert.equal(duplicate.error.type, "native_route_replay_blocked");
  const retained = nativeRouteLeaseStatus();
  assert.equal(retained.tombstoneCount, 1);
  assert.equal(retained.tombstone, true);
  assert.equal(
    clearNativeRouteLease(retained.leaseId, retained.generation).snapshot.tombstoneCount,
    0,
  );
});

test("Integrated picker lease reuses exact task/root and enforces 16 unique tool outputs", () => {
  reset();
  const first = claim(INTEGRATED, request({ outputs: ["historical"] }));
  assert.equal(first.ok, true);
  assert.equal(first.lease.remainingRequests, 16);
  const duplicate = claim(INTEGRATED, request({ outputs: ["historical"] }));
  assert.equal(duplicate.error.type, "native_route_tool_progress_required");
  assert.equal(nativeRouteLeaseStatus().remainingRequests, 16);
  const sixteen = Array.from({ length: 16 }, (_, index) => `new-${index}`);
  const second = claim(INTEGRATED, request({ turnId: "31a035a2-f151-77c1-8c62-28e2b719599b", outputs: ["historical", ...sixteen] }));
  assert.equal(second.ok, true);
  assert.equal(second.lease.integratedToolOutputs, 16);
  const before = nativeRouteLeaseStatus().remainingRequests;
  const over = claim(INTEGRATED, request({ turnId: "41a035a2-f151-77c1-8c62-28e2b719599b", outputs: [...sixteen, "new-17"] }));
  assert.equal(over.error.type, "native_route_tool_call_limit");
  assert.equal(nativeRouteLeaseStatus().remainingRequests, before);
  const otherRoot = claim(INTEGRATED, request({ rootTurnId: SECOND_ROOT }));
  assert.equal(otherRoot.ok, true, "a distinct explicitly selected root turn did not receive its own keyed lease");
  assert.equal(nativeRouteLeaseStatus().activeCount, 2);
});

test("picker leases are keyed per task and exact-generation clear preserves others", () => {
  reset();
  const first = claim(INTEGRATED, request());
  const second = claim(INTEGRATED, request({ threadId: SECOND_THREAD, rootTurnId: SECOND_ROOT }));
  assert.equal(first.ok && second.ok, true);
  assert.equal(nativeRouteLeaseStatus().activeCount, 2);
  const cleared = clearNativeRouteLease(second.lease.leaseId, second.lease.generation);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.snapshot.activeCount, 1);
  assert.equal(cleared.snapshot.leaseId, first.lease.leaseId);
  const repeated = clearNativeRouteLease(second.lease.leaseId, second.lease.generation);
  assert.equal(repeated.cleared, false);
  assert.equal(repeated.snapshot.leaseId, first.lease.leaseId);
});

test("expired lease becomes a durable tombstone and blocks replay after restart", () => {
  reset();
  const first = claim(INTEGRATED, request());
  assert.equal(first.ok, true);
  const ledger = JSON.parse(readFileSync(NATIVE_ROUTE_LEASE_PATH, "utf8"));
  ledger.leases[0].createdAt = Date.now() - 30 * 60_000 - 2_001;
  ledger.leases[0].boundAt = ledger.leases[0].createdAt;
  ledger.leases[0].lastClaimAt = ledger.leases[0].createdAt + 1_000;
  ledger.leases[0].expiresAt = ledger.leases[0].lastClaimAt + 30 * 60_000;
  writeFileSync(NATIVE_ROUTE_LEASE_PATH, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  assert.equal(claim(INTEGRATED, request()).error.type, "native_route_replay_blocked");
  const stored = JSON.parse(readFileSync(NATIVE_ROUTE_LEASE_PATH, "utf8"));
  assert.equal(stored.leases.length, 0);
  assert.equal(stored.tombstones.length, 1);
  assert.equal(stored.tombstones[0].reason, "expired");

  const script = `
    import { claimNativeRouteLease } from './src/native-route-lease.mjs';
    const headers = ${JSON.stringify(request().headers)};
    const payload = ${JSON.stringify(request().payload)};
    process.stdout.write(JSON.stringify(claimNativeRouteLease(${JSON.stringify(INTEGRATED)}, ${JSON.stringify(INTEGRATED)}, headers, payload)));
  `;
  const restarted = JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex"), MODEL_ROUTER_STATE_DIR: stateDir, CODEX_ROUTER_STATE_DIR: stateDir },
    },
  ));
  assert.equal(restarted.error.type, "native_route_replay_blocked");
});

test("cross-process lock is fail-closed and never stale-broken", () => {
  reset();
  const lease = claim(INTEGRATED, request()).lease;
  mkdirSync(NATIVE_ROUTE_LEASE_LOCK_PATH, { mode: 0o700 });
  const old = new Date(Date.now() - 86_400_000);
  utimesSync(NATIVE_ROUTE_LEASE_LOCK_PATH, old, old);
  assert.throws(() => nativeRouteLeaseStatus(), /busy/);
  assert.throws(() => clearNativeRouteLease(lease.leaseId, lease.generation), /busy/);
  assert.equal(claim(INTEGRATED, request()).error.type, "native_route_lease_locked");
  assert.ok(existsSync(NATIVE_ROUTE_LEASE_LOCK_PATH));
  rmdirSync(NATIVE_ROUTE_LEASE_LOCK_PATH);
});

test("selected/configured provider gates automatic lease creation", () => {
  reset();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(PROVIDER_SELECTION_PATH, '{"version":1,"providers":["deepseek"]}\n', { mode: 0o600 });
  assert.equal(claim(CONSULT, request()).error.type, "native_route_provider_not_selected");
  unlinkSync(PROVIDER_SELECTION_PATH);
  unlinkSync(tokenFile);
  assert.equal(claim(CONSULT, request()).error.type, "native_route_credential_missing");
  assert.equal(existsSync(NATIVE_ROUTE_LEASE_PATH), false);
  writeFileSync(tokenFile, "test-threadspan-owner-token-123456\n", { mode: 0o600 });
});

test("status and exact clear remain machine-readable recovery operations", () => {
  reset();
  const lease = claim(INTEGRATED, request()).lease;
  const env = { ...process.env, HOME: home, CODEX_ROUTER_STATE_DIR: stateDir, MODEL_ROUTER_STATE_DIR: stateDir };
  const command = path.join(root, "src", "control.mjs");
  const status = JSON.parse(execFileSync(process.execPath, [command, "native-lease", "status"], { cwd: root, encoding: "utf8", env }));
  assert.equal(status.authority, "native-picker-selection");
  const cleared = JSON.parse(execFileSync(process.execPath, [command, "native-lease", "clear", lease.leaseId, lease.generation], { cwd: root, encoding: "utf8", env }));
  assert.equal(cleared.cleared, true);
});

test("Threadspan credential remains strict read-only external state", { skip: process.platform === "win32" }, () => {
  reset();
  const probe = `import { credentialStatus } from './src/provider-credentials.mjs'; process.stdout.write(JSON.stringify(credentialStatus('threadspan',{persistent:true})));`;
  const run = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex"), MODEL_ROUTER_STATE_DIR: stateDir },
  }));
  assert.equal(run().configured, true);
  chmodSync(tokenFile, 0o644);
  assert.equal(run().configured, false);
  chmodSync(tokenFile, 0o600);
  unlinkSync(tokenFile);
  const real = path.join(tokenDir, "real.token");
  writeFileSync(real, "test-threadspan-owner-token-123456\n", { mode: 0o600 });
  symlinkSync(real, tokenFile);
  assert.equal(run().configured, false);
  unlinkSync(tokenFile);
  writeFileSync(tokenFile, "test-threadspan-owner-token-123456\n", { mode: 0o600 });
});

test.after(() => { if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true }); });
