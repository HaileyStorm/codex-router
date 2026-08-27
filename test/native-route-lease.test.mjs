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
  clearNativeRouteLease, commitNativeRouteReservation, nativeRouteLeaseStatus,
  injectThreadspanMetadata, reserveNativeRouteLease, rollbackNativeRouteReservation,
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

function indexedUuid(index) {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

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

function reserve(route, value, lane = "response") {
  return reserveNativeRouteLease(route, route, value.headers, value.payload, lane);
}

function claim(route, value, lane = "response") {
  const reserved = reserve(route, value, lane);
  return reserved.ok ? commitNativeRouteReservation(reserved.reservation) : reserved;
}

test("native picker selection gives Consult separate retained compact and response lanes", () => {
  reset();
  assert.deepEqual(nativeRouteLeaseStatus(), {
    configured: false, activeCount: 0, reservationCount: 0, tombstoneCount: 0,
  });
  const compact = claim(CONSULT, request(), "compact");
  assert.equal(compact.ok, true);
  assert.equal(compact.lease.lane, "compact");
  assert.equal(compact.lease.remainingRequests, 0);
  const duplicateCompact = claim(CONSULT, request(), "compact");
  assert.equal(duplicateCompact.error.type, "native_route_replay_blocked");

  const first = claim(CONSULT, request());
  assert.equal(first.ok, true);
  assert.equal(first.lease.authority, "native-picker-selection");
  assert.equal(first.lease.lane, "response");
  assert.equal(first.lease.threadId, THREAD);
  assert.equal(first.lease.boundTurnId, ROOT_TURN);
  assert.equal(first.lease.remainingRequests, 0);
  assert.equal(first.lease.exhausted, true);
  assert.equal(first.lease.tombstone, true);
  assert.equal(first.lease.expiresAt - first.lease.lastClaimAt, 30 * 60_000);
  const duplicate = claim(CONSULT, request());
  assert.equal(duplicate.error.type, "native_route_replay_blocked");
  const retained = nativeRouteLeaseStatus();
  assert.equal(retained.tombstoneCount, 2);
  assert.equal(retained.tombstone, true);
  assert.equal(clearNativeRouteLease(compact.lease.leaseId, compact.lease.generation).snapshot.tombstoneCount, 1);
  assert.equal(clearNativeRouteLease(first.lease.leaseId, first.lease.generation).snapshot.tombstoneCount, 0);
});

test("reservation rollback preserves allowance and exact retry while commit consumes once", () => {
  reset();
  const pending = reserve(CONSULT, request());
  assert.equal(pending.ok, true);
  assert.equal(pending.reservation.reserved, true);
  assert.equal(pending.reservation.remainingRequests, 1);
  assert.equal(pending.reservation.exhausted, false);
  assert.equal(nativeRouteLeaseStatus().reservationCount, 1);
  assert.equal(nativeRouteLeaseStatus().tombstoneCount, 0);

  const concurrent = reserve(CONSULT, request());
  assert.equal(concurrent.error.type, "native_route_reserved");
  assert.match(concurrent.error.message, /no provider request was sent/i);
  assert.equal(clearNativeRouteLease(pending.reservation.leaseId, SECOND_ROOT).cleared, false);
  assert.equal(
    rollbackNativeRouteReservation({ ...pending.reservation, generation: SECOND_ROOT }).rolledBack,
    false,
  );
  assert.equal(nativeRouteLeaseStatus().reservationCount, 1);

  const rolledBack = rollbackNativeRouteReservation(pending.reservation);
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(rolledBack.snapshot.reservationCount, 0);
  assert.equal(rolledBack.snapshot.tombstoneCount, 0);
  const retry = reserve(CONSULT, request());
  assert.equal(retry.ok, true);
  assert.notEqual(retry.reservation.reservationId, pending.reservation.reservationId);

  const committed = commitNativeRouteReservation(retry.reservation);
  assert.equal(committed.ok, true);
  assert.equal(committed.lease.remainingRequests, 0);
  assert.equal(committed.lease.tombstone, true);
  const duplicateCommit = commitNativeRouteReservation(retry.reservation);
  assert.equal(duplicateCommit.error.type, "native_route_dispatch_retained");
  assert.match(duplicateCommit.error.message, /already committed.*retained/i);
  assert.equal(reserve(CONSULT, request()).error.type, "native_route_replay_blocked");
});

test("a crash-persisted reservation blocks concurrency until exact rollback", () => {
  reset();
  const value = request();
  const script = `
    import { reserveNativeRouteLease } from './src/native-route-lease.mjs';
    const headers = ${JSON.stringify(value.headers)};
    const payload = ${JSON.stringify(value.payload)};
    process.stdout.write(JSON.stringify(reserveNativeRouteLease(${JSON.stringify(CONSULT)}, ${JSON.stringify(CONSULT)}, headers, payload)));
  `;
  const crashed = JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, ".codex"),
        MODEL_ROUTER_STATE_DIR: stateDir,
        CODEX_ROUTER_STATE_DIR: stateDir,
      },
    },
  ));
  assert.equal(crashed.ok, true);
  assert.equal(reserve(CONSULT, value).error.type, "native_route_reserved");
  assert.equal(rollbackNativeRouteReservation(crashed.reservation).rolledBack, true);
  const retry = reserve(CONSULT, value);
  assert.equal(retry.ok, true);
  assert.equal(rollbackNativeRouteReservation(retry.reservation).rolledBack, true);
});

test("pending reservations cannot overbook committed lease capacity", () => {
  reset();
  const pending = [];
  for (let index = 0; index < 32; index += 1) {
    const reserved = reserve(INTEGRATED, request({
      threadId: indexedUuid(100 + index),
      rootTurnId: indexedUuid(1_000 + index),
    }));
    assert.equal(reserved.ok, true);
    pending.push(reserved.reservation);
  }
  const overflow = reserve(INTEGRATED, request({
    threadId: indexedUuid(200),
    rootTurnId: indexedUuid(2_000),
  }));
  assert.equal(overflow.error.type, "native_route_ledger_full");
  for (const reservation of pending) {
    assert.equal(commitNativeRouteReservation(reservation).ok, true);
  }
  const status = nativeRouteLeaseStatus();
  assert.equal(status.activeCount, 32);
  assert.equal(status.reservationCount, 0);
  assert.equal(clearNativeRouteLease(pending[0].leaseId, pending[0].generation).cleared, true);
  assert.equal(nativeRouteLeaseStatus().activeCount, 31);
});

test("pending exhaustion cannot overbook tombstone capacity", () => {
  reset();
  const templateCommit = claim(CONSULT, request());
  assert.equal(templateCommit.ok, true);
  const template = JSON.parse(readFileSync(NATIVE_ROUTE_LEASE_PATH, "utf8")).tombstones[0];
  const tombstones = Array.from({ length: 4_095 }, (_, index) => ({
    ...template,
    leaseId: indexedUuid(10_000 + index),
    generation: indexedUuid(20_000 + index),
    lastReservationId: indexedUuid(30_000 + index),
  }));
  writeFileSync(NATIVE_ROUTE_LEASE_PATH, `${JSON.stringify({
    version: 5,
    reservations: [],
    leases: [],
    tombstones,
    legacyTombstones: [],
  })}\n`, { mode: 0o600 });

  const finalSlot = reserve(CONSULT, request({
    threadId: SECOND_THREAD,
    rootTurnId: SECOND_ROOT,
  }));
  assert.equal(finalSlot.ok, true);
  const overflow = reserve(CONSULT, request({
    threadId: indexedUuid(50_000),
    rootTurnId: indexedUuid(50_001),
  }));
  assert.equal(overflow.error.type, "native_route_tombstone_full");
  const committed = commitNativeRouteReservation(finalSlot.reservation);
  assert.equal(committed.ok, true);
  assert.equal(nativeRouteLeaseStatus().tombstoneCount, 4_096);
  assert.equal(
    clearNativeRouteLease(committed.lease.leaseId, committed.lease.generation).snapshot.tombstoneCount,
    4_095,
  );
});

test("Integrated provisional tool progress is discarded on rollback", () => {
  reset();
  const first = claim(INTEGRATED, request({ outputs: ["historical"] }));
  assert.equal(first.ok, true);
  assert.equal(first.lease.remainingRequests, 16);
  const pending = reserve(INTEGRATED, request({ outputs: ["historical", "new-0"] }));
  assert.equal(pending.ok, true);
  assert.equal(pending.reservation.remainingRequests, 16);
  assert.equal(nativeRouteLeaseStatus().remainingRequests, 16);
  assert.equal(nativeRouteLeaseStatus().integratedToolOutputs, 0);
  assert.equal(rollbackNativeRouteReservation(pending.reservation).rolledBack, true);
  assert.equal(nativeRouteLeaseStatus().remainingRequests, 16);
  assert.equal(nativeRouteLeaseStatus().integratedToolOutputs, 0);
  const staleCommit = commitNativeRouteReservation(pending.reservation);
  assert.equal(staleCommit.error.type, "native_route_reservation_missing");
  assert.match(staleCommit.error.message, /no provider request was sent/i);
  const retried = reserve(INTEGRATED, request({ outputs: ["historical", "new-0"] }));
  const committed = commitNativeRouteReservation(retried.reservation);
  assert.equal(committed.lease.remainingRequests, 15);
  assert.equal(committed.lease.integratedToolOutputs, 1);
});

test("an expired Integrated follow-up receipt is not mislabeled as dispatched", () => {
  reset();
  assert.equal(claim(INTEGRATED, request({ outputs: ["historical"] })).ok, true);
  const pending = reserve(INTEGRATED, request({ outputs: ["historical", "new-0"] }));
  assert.equal(pending.ok, true);
  const ledger = JSON.parse(readFileSync(NATIVE_ROUTE_LEASE_PATH, "utf8"));
  const old = Date.now() - 30 * 60_000 - 2_000;
  Object.assign(ledger.leases[0], {
    createdAt: old,
    boundAt: old,
    lastClaimAt: old,
    expiresAt: old + 30 * 60_000,
  });
  Object.assign(ledger.reservations[0], {
    createdAt: old,
    boundAt: old,
    reservedAt: old,
    expiresAt: old + 30 * 60_000,
  });
  writeFileSync(NATIVE_ROUTE_LEASE_PATH, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  assert.equal(nativeRouteLeaseStatus().reservationCount, 0);
  const staleCommit = commitNativeRouteReservation(pending.reservation);
  assert.equal(staleCommit.error.type, "native_route_reservation_missing");
  assert.match(staleCommit.error.message, /no provider request was sent/i);
});

test("Threadspan metadata is owner-private and Delegate alone enables subagents", () => {
  const routes = [
    [CONSULT, false],
    ["delegate/grok-build/grok-4.6", true],
    [INTEGRATED, false],
  ];
  for (const [slug, allowSubagents] of routes) {
    const payload = {
      metadata: {
        keep: "caller-owned",
        bridge_payload_classification: "public",
        bridge_payload_disclosed: false,
        bridge_allow_subagents: !allowSubagents,
        bridge_allow_web_search: true,
      },
    };
    injectThreadspanMetadata(
      payload,
      { slug, defaultEffort: "high" },
      { cwd: workspace, threadId: THREAD },
    );
    assert.equal(payload.metadata.keep, "caller-owned");
    assert.equal(payload.metadata.bridge_payload_classification, "owner_private");
    assert.equal(payload.metadata.bridge_payload_disclosed, true);
    assert.equal(payload.metadata.bridge_allow_subagents, allowSubagents);
    assert.equal(payload.metadata.bridge_allow_web_search, false);
    assert.equal(payload.metadata.bridge_no_plan, true);
    assert.equal(payload.metadata.bridge_account_fallback, false);
  }
});

test("Integrated compact is separate from all 17 response dispatches and 16 tool outputs", () => {
  reset();
  const compact = claim(INTEGRATED, request({ outputs: ["historical"] }), "compact");
  assert.equal(compact.ok, true);
  assert.equal(compact.lease.maxRequests, 1);
  assert.equal(compact.lease.integratedToolOutputs, 0);
  assert.equal(claim(INTEGRATED, request({ outputs: ["historical"] }), "compact").error.type, "native_route_replay_blocked");
  const first = claim(INTEGRATED, request({ outputs: ["historical"] }));
  assert.equal(first.ok, true);
  assert.equal(first.lease.maxRequests, 17);
  assert.equal(first.lease.remainingRequests, 16);
  const duplicate = claim(INTEGRATED, request({ outputs: ["historical"] }));
  assert.equal(duplicate.error.type, "native_route_tool_progress_required");
  assert.equal(nativeRouteLeaseStatus().remainingRequests, 16);
  const sixteen = Array.from({ length: 16 }, (_, index) => `new-${index}`);
  let final;
  for (let index = 0; index < sixteen.length; index += 1) {
    final = claim(INTEGRATED, request({
      turnId: `${String(index + 31).padStart(2, "0")}a035a2-f151-77c1-8c62-28e2b719599b`,
      outputs: ["historical", ...sixteen.slice(0, index + 1)],
    }));
    assert.equal(final.ok, true);
    assert.equal(final.lease.remainingRequests, 15 - index);
  }
  assert.equal(final.lease.integratedToolOutputs, 16);
  assert.equal(final.lease.tombstone, true);
  assert.equal(claim(INTEGRATED, request({ outputs: ["historical", ...sixteen] })).error.type, "native_route_replay_blocked");

  const newRoot = claim(INTEGRATED, request({ rootTurnId: SECOND_ROOT, outputs: ["historical"] }));
  assert.equal(newRoot.ok, true, "a distinct explicitly selected root turn did not receive its own keyed lease");
  const before = nativeRouteLeaseStatus().remainingRequests;
  const over = claim(INTEGRATED, request({
    rootTurnId: SECOND_ROOT,
    turnId: "61a035a2-f151-77c1-8c62-28e2b719599b",
    outputs: ["historical", ...sixteen, "new-17"],
  }));
  assert.equal(over.error.type, "native_route_tool_call_limit");
  assert.equal(nativeRouteLeaseStatus().remainingRequests, before);
  assert.equal(nativeRouteLeaseStatus().activeCount, 1);
});

test("version-3 lease provenance migrates explicitly and blocks both new lanes", () => {
  reset();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const leaseId = "31a035a2-f151-77c1-8c62-28e2b719599b";
  const generation = "41a035a2-f151-77c1-8c62-28e2b719599b";
  writeFileSync(NATIVE_ROUTE_LEASE_PATH, `${JSON.stringify({
    version: 3,
    leases: [{
      leaseId,
      generation,
      routeSlug: INTEGRATED,
      mode: "integrated",
      cwd: workspace,
      threadId: THREAD,
      boundTurnId: ROOT_TURN,
      baselineToolOutputIds: [],
      seenToolOutputIds: [],
      remainingRequests: 16,
      maxRequests: 17,
      createdAt: now,
      boundAt: now,
      lastClaimAt: now,
      expiresAt: now + 30 * 60_000,
      authority: "native-picker-selection",
    }],
    tombstones: [],
  })}\n`, { mode: 0o600 });

  assert.equal(claim(INTEGRATED, request(), "compact").error.type, "native_route_legacy_replay_blocked");
  assert.equal(claim(INTEGRATED, request(), "response").error.type, "native_route_legacy_replay_blocked");
  const migrated = JSON.parse(readFileSync(NATIVE_ROUTE_LEASE_PATH, "utf8"));
  assert.equal(migrated.version, 5);
  assert.deepEqual(migrated.reservations, []);
  assert.equal(migrated.leases.length, 0);
  assert.equal(migrated.tombstones.length, 0);
  assert.equal(migrated.legacyTombstones.length, 1);
  assert.equal(migrated.legacyTombstones[0].legacyVersion, 3);
  assert.equal(migrated.legacyTombstones[0].source, "lease");
  assert.equal(clearNativeRouteLease(leaseId, generation).cleared, true);
});

test("version-4 dispatched provenance migrates conservatively after restart", () => {
  reset();
  const committed = claim(INTEGRATED, request({ outputs: ["historical"] }));
  assert.equal(committed.ok, true);
  const current = JSON.parse(readFileSync(NATIVE_ROUTE_LEASE_PATH, "utf8"));
  writeFileSync(NATIVE_ROUTE_LEASE_PATH, `${JSON.stringify({
    version: 4,
    leases: current.leases,
    tombstones: current.tombstones,
    legacyTombstones: current.legacyTombstones,
  })}\n`, { mode: 0o600 });

  const script = `
    import { nativeRouteLeaseStatus } from './src/native-route-lease.mjs';
    process.stdout.write(JSON.stringify(nativeRouteLeaseStatus()));
  `;
  const restarted = JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, ".codex"),
        MODEL_ROUTER_STATE_DIR: stateDir,
        CODEX_ROUTER_STATE_DIR: stateDir,
      },
    },
  ));
  assert.equal(restarted.legacyVersion, 4);
  assert.equal(restarted.lane, "response");
  const migrated = JSON.parse(readFileSync(NATIVE_ROUTE_LEASE_PATH, "utf8"));
  assert.equal(migrated.version, 5);
  assert.deepEqual(migrated.reservations, []);
  assert.deepEqual(migrated.leases, []);
  assert.equal(migrated.legacyTombstones[0].legacyVersion, 4);
  assert.equal(reserve(INTEGRATED, request(), "response").error.type, "native_route_legacy_replay_blocked");
  const compact = reserve(INTEGRATED, request(), "compact");
  assert.equal(compact.ok, true, "lane-aware v4 provenance blocked an unrelated compact lane");
  assert.equal(rollbackNativeRouteReservation(compact.reservation).rolledBack, true);
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
    import { reserveNativeRouteLease } from './src/native-route-lease.mjs';
    const headers = ${JSON.stringify(request().headers)};
    const payload = ${JSON.stringify(request().payload)};
    process.stdout.write(JSON.stringify(reserveNativeRouteLease(${JSON.stringify(INTEGRATED)}, ${JSON.stringify(INTEGRATED)}, headers, payload)));
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

test("version-5 tombstones with impossible timestamp provenance fail closed", () => {
  reset();
  assert.equal(claim(CONSULT, request(), "compact").ok, true);
  const ledger = JSON.parse(readFileSync(NATIVE_ROUTE_LEASE_PATH, "utf8"));
  ledger.tombstones[0].createdAt = ledger.tombstones[0].at + 1;
  writeFileSync(NATIVE_ROUTE_LEASE_PATH, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  const refused = claim(CONSULT, request(), "response");
  assert.equal(refused.error.type, "native_route_lease_state_invalid");
  assert.equal(
    JSON.parse(readFileSync(NATIVE_ROUTE_LEASE_PATH, "utf8")).tombstones[0].createdAt,
    ledger.tombstones[0].createdAt,
    "invalid retained provenance was rewritten instead of rejected",
  );
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
