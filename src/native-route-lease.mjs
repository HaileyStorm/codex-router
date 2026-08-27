import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import { readProviderSelection } from "./provider-selection.mjs";
import {
  NATIVE_ROUTE_LEASE_LOCK_PATH,
  NATIVE_ROUTE_LEASE_PATH,
  STATE_DIR,
} from "./paths.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THREADSPAN_MODES = new Set(["consult", "delegate", "integrated"]);
const LEASE_LANES = new Set(["compact", "response"]);
const LEDGER_VERSION = 5;
const LEASE_INACTIVITY_MS = 30 * 60 * 1000;
const MAX_LEASES = 32;
const MAX_RESERVATIONS = 32;
const MAX_TOMBSTONES = 4_096;
const MAX_V4_LEGACY_TOMBSTONES = MAX_TOMBSTONES + MAX_LEASES;
const MAX_LEGACY_TOMBSTONES = 2 * (MAX_TOMBSTONES + MAX_LEASES);
const MAX_BASELINE_TOOL_OUTPUTS = 4_096;
const MAX_INTEGRATED_TOOL_OUTPUTS = 16;
const RESERVED_METADATA = Object.freeze({
  bridge_payload_classification: "owner_private",
  bridge_payload_disclosed: true,
  bridge_allow_web_search: false,
  bridge_no_plan: true,
  bridge_automatic_takeover: false,
  bridge_account_fallback: false,
});

function stateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function leaseMode(routeSlug) {
  const mode = String(routeSlug || "").split("/", 1)[0];
  return THREADSPAN_MODES.has(mode) ? mode : undefined;
}

function maxRequests(mode, lane) {
  return lane === "response" && mode === "integrated" ? 17 : 1;
}

function uuid(value) {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

function workspace(value, { mustExist = true } = {}) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
  try {
    const resolved = mustExist ? realpathSync(value) : path.resolve(value);
    if (mustExist && !statSync(resolved).isDirectory()) return undefined;
    const normalized = path.normalize(resolved);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  } catch {
    return undefined;
  }
}

function uniqueIds(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) return undefined;
  const ids = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length < 1 || item.length > 256) return undefined;
    ids.push(item);
  }
  return new Set(ids).size === ids.length ? ids : undefined;
}

function normalizeLease(value, now, { requireReservationId = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const leaseId = uuid(value.leaseId);
  const generation = uuid(value.generation);
  const mode = leaseMode(value.routeSlug);
  const lane = LEASE_LANES.has(value.lane) ? value.lane : undefined;
  const cwd = workspace(value.cwd, { mustExist: false });
  const threadId = uuid(value.threadId);
  const boundTurnId = uuid(value.boundTurnId);
  const lastReservationId = uuid(value.lastReservationId);
  const baselineToolOutputIds = uniqueIds(value.baselineToolOutputIds, MAX_BASELINE_TOOL_OUTPUTS);
  const seenToolOutputIds = uniqueIds(value.seenToolOutputIds, MAX_INTEGRATED_TOOL_OUTPUTS);
  const maximum = maxRequests(mode, lane);
  if (
    !leaseId || !generation || !mode || !lane || !cwd || value.cwd !== cwd || !threadId || !boundTurnId ||
    (requireReservationId && !lastReservationId) ||
    !baselineToolOutputIds || !seenToolOutputIds ||
    !Number.isInteger(value.remainingRequests) || value.remainingRequests < 0 ||
    value.remainingRequests > maximum || value.maxRequests !== maximum ||
    !Number.isInteger(value.createdAt) || !Number.isInteger(value.boundAt) ||
    !Number.isInteger(value.lastClaimAt) || !Number.isInteger(value.expiresAt) ||
    value.createdAt > value.boundAt || value.boundAt > value.lastClaimAt ||
    value.lastClaimAt > now + 1_000 || value.expiresAt !== value.lastClaimAt + LEASE_INACTIVITY_MS ||
    ((mode !== "integrated" || lane !== "response") &&
      (baselineToolOutputIds.length || seenToolOutputIds.length))
  ) return undefined;
  return {
    lease: {
      leaseId, generation, routeSlug: value.routeSlug, mode, lane, cwd, threadId, boundTurnId,
      ...(lastReservationId ? { lastReservationId } : {}),
      baselineToolOutputIds, seenToolOutputIds,
      remainingRequests: value.remainingRequests, maxRequests: maximum,
      createdAt: value.createdAt, boundAt: value.boundAt,
      lastClaimAt: value.lastClaimAt, expiresAt: value.expiresAt,
      authority: "native-picker-selection",
    },
    expired: now >= value.expiresAt,
  };
}

function normalizeReservation(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reservationId = uuid(value.reservationId);
  const leaseId = uuid(value.leaseId);
  const generation = uuid(value.generation);
  const mode = leaseMode(value.routeSlug);
  const lane = LEASE_LANES.has(value.lane) ? value.lane : undefined;
  const cwd = workspace(value.cwd, { mustExist: false });
  const threadId = uuid(value.threadId);
  const boundTurnId = uuid(value.boundTurnId);
  const baselineToolOutputIds = uniqueIds(value.baselineToolOutputIds, MAX_BASELINE_TOOL_OUTPUTS);
  const baseSeenToolOutputIds = uniqueIds(value.baseSeenToolOutputIds, MAX_INTEGRATED_TOOL_OUTPUTS);
  const seenToolOutputIds = uniqueIds(value.seenToolOutputIds, MAX_INTEGRATED_TOOL_OUTPUTS);
  const maximum = maxRequests(mode, lane);
  if (
    !reservationId || !leaseId || !generation || !mode || !lane || !cwd || value.cwd !== cwd ||
    !threadId || !boundTurnId || !baselineToolOutputIds || !baseSeenToolOutputIds ||
    !seenToolOutputIds || !Number.isInteger(value.baseRemainingRequests) ||
    value.baseRemainingRequests < 1 || value.baseRemainingRequests > maximum ||
    value.remainingRequests !== value.baseRemainingRequests - 1 || value.maxRequests !== maximum ||
    !Number.isInteger(value.createdAt) || !Number.isInteger(value.boundAt) ||
    !Number.isInteger(value.reservedAt) || !Number.isInteger(value.expiresAt) ||
    value.createdAt > value.boundAt || value.boundAt > value.reservedAt ||
    value.reservedAt > now + 1_000 || value.expiresAt !== value.reservedAt + LEASE_INACTIVITY_MS ||
    ((mode !== "integrated" || lane !== "response") &&
      (baselineToolOutputIds.length || baseSeenToolOutputIds.length || seenToolOutputIds.length)) ||
    !baseSeenToolOutputIds.every((id, index) => seenToolOutputIds[index] === id)
  ) return undefined;
  return {
    reservation: {
      reservationId, leaseId, generation, routeSlug: value.routeSlug, mode, lane, cwd,
      threadId, boundTurnId, baselineToolOutputIds, baseSeenToolOutputIds,
      seenToolOutputIds, baseRemainingRequests: value.baseRemainingRequests,
      remainingRequests: value.remainingRequests, maxRequests: maximum,
      createdAt: value.createdAt, boundAt: value.boundAt,
      reservedAt: value.reservedAt, expiresAt: value.expiresAt,
      authority: "native-picker-selection",
    },
    expired: now >= value.expiresAt,
  };
}

function normalizeTombstone(value, { requireReservationId = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const leaseId = uuid(value.leaseId);
  const generation = uuid(value.generation);
  const mode = leaseMode(value.routeSlug);
  const lane = LEASE_LANES.has(value.lane) ? value.lane : undefined;
  const cwd = workspace(value.cwd, { mustExist: false });
  const threadId = uuid(value.threadId);
  const boundTurnId = uuid(value.boundTurnId);
  const lastReservationId = uuid(value.lastReservationId);
  if (
    !leaseId || !generation || !mode || !lane || !cwd || value.cwd !== cwd || !threadId || !boundTurnId ||
    (requireReservationId && !lastReservationId) ||
    !["expired", "exhausted"].includes(value.reason) ||
    !Number.isInteger(value.createdAt) || !Number.isInteger(value.at) || value.createdAt > value.at
  ) return undefined;
  return {
    leaseId, generation, routeSlug: value.routeSlug, mode, lane, cwd, threadId, boundTurnId,
    ...(lastReservationId ? { lastReservationId } : {}),
    createdAt: value.createdAt, at: value.at, reason: value.reason,
  };
}

function tombstoneFor(lease, reason, at) {
  return {
    leaseId: lease.leaseId,
    generation: lease.generation,
    routeSlug: lease.routeSlug,
    mode: lease.mode,
    lane: lease.lane,
    cwd: lease.cwd,
    threadId: lease.threadId,
    boundTurnId: lease.boundTurnId,
    lastReservationId: lease.lastReservationId,
    createdAt: lease.createdAt,
    at,
    reason,
  };
}

function normalizeV3Lease(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const leaseId = uuid(value.leaseId);
  const generation = uuid(value.generation);
  const mode = leaseMode(value.routeSlug);
  const cwd = workspace(value.cwd, { mustExist: false });
  const threadId = uuid(value.threadId);
  const boundTurnId = uuid(value.boundTurnId);
  const baselineToolOutputIds = uniqueIds(value.baselineToolOutputIds, MAX_BASELINE_TOOL_OUTPUTS);
  const seenToolOutputIds = uniqueIds(value.seenToolOutputIds, MAX_INTEGRATED_TOOL_OUTPUTS);
  const maximum = maxRequests(mode, "response");
  if (
    !leaseId || !generation || !mode || !cwd || value.cwd !== cwd || !threadId || !boundTurnId ||
    !baselineToolOutputIds || !seenToolOutputIds ||
    !Number.isInteger(value.remainingRequests) || value.remainingRequests < 0 ||
    value.remainingRequests > maximum || value.maxRequests !== maximum ||
    !Number.isInteger(value.createdAt) || !Number.isInteger(value.boundAt) ||
    !Number.isInteger(value.lastClaimAt) || !Number.isInteger(value.expiresAt) ||
    value.createdAt > value.boundAt || value.boundAt > value.lastClaimAt ||
    value.lastClaimAt > now + 1_000 || value.expiresAt !== value.lastClaimAt + LEASE_INACTIVITY_MS ||
    (mode !== "integrated" && (baselineToolOutputIds.length || seenToolOutputIds.length))
  ) return undefined;
  return {
    leaseId, generation, routeSlug: value.routeSlug, mode, cwd, threadId, boundTurnId,
    createdAt: value.createdAt, at: Math.max(now, value.createdAt),
    reason: now >= value.expiresAt ? "expired" : "retained",
    source: "lease", legacyVersion: 3,
  };
}

function normalizeV3Tombstone(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const leaseId = uuid(value.leaseId);
  const generation = uuid(value.generation);
  const mode = leaseMode(value.routeSlug);
  const cwd = workspace(value.cwd, { mustExist: false });
  const threadId = uuid(value.threadId);
  const boundTurnId = uuid(value.boundTurnId);
  if (
    !leaseId || !generation || !mode || !cwd || value.cwd !== cwd || !threadId || !boundTurnId ||
    !["expired", "exhausted"].includes(value.reason) ||
    !Number.isInteger(value.createdAt) || !Number.isInteger(value.at) || value.createdAt > value.at
  ) return undefined;
  return {
    leaseId, generation, routeSlug: value.routeSlug, mode, cwd, threadId, boundTurnId,
    createdAt: value.createdAt, at: value.at, reason: value.reason,
    source: "tombstone", legacyVersion: 3,
  };
}

function legacyFromV4Lease(value, now) {
  const normalized = normalizeLease(value, now);
  if (!normalized) return undefined;
  const lease = normalized.lease;
  return {
    leaseId: lease.leaseId,
    generation: lease.generation,
    routeSlug: lease.routeSlug,
    mode: lease.mode,
    lane: lease.lane,
    cwd: lease.cwd,
    threadId: lease.threadId,
    boundTurnId: lease.boundTurnId,
    createdAt: lease.createdAt,
    at: Math.max(now, lease.createdAt),
    reason: normalized.expired ? "expired" : "retained",
    source: "lease",
    legacyVersion: 4,
  };
}

function legacyFromV4Tombstone(value) {
  const tombstone = normalizeTombstone(value);
  if (!tombstone) return undefined;
  return {
    ...tombstone,
    source: "tombstone",
    legacyVersion: 4,
  };
}

function normalizeLegacyTombstone(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const leaseId = uuid(value.leaseId);
  const generation = uuid(value.generation);
  const mode = leaseMode(value.routeSlug);
  const lane = LEASE_LANES.has(value.lane) ? value.lane : undefined;
  const cwd = workspace(value.cwd, { mustExist: false });
  const threadId = uuid(value.threadId);
  const boundTurnId = uuid(value.boundTurnId);
  if (
    !leaseId || !generation || !mode || !cwd || value.cwd !== cwd || !threadId || !boundTurnId ||
    ![3, 4].includes(value.legacyVersion) || !["lease", "tombstone"].includes(value.source) ||
    (value.legacyVersion === 3 && value.lane !== undefined) ||
    (value.legacyVersion === 4 && !lane) ||
    !["retained", "expired", "exhausted"].includes(value.reason) ||
    (value.source === "tombstone" && value.reason === "retained") ||
    !Number.isInteger(value.createdAt) || !Number.isInteger(value.at) || value.createdAt > value.at
  ) return undefined;
  return {
    leaseId, generation, routeSlug: value.routeSlug, mode,
    ...(lane ? { lane } : {}), cwd, threadId, boundTurnId,
    createdAt: value.createdAt, at: value.at, reason: value.reason,
    source: value.source, legacyVersion: value.legacyVersion,
  };
}

function readLedgerUnlocked(now = Date.now()) {
  if (!existsSync(NATIVE_ROUTE_LEASE_PATH)) {
    return { version: LEDGER_VERSION, reservations: [], leases: [], tombstones: [], legacyTombstones: [] };
  }
  let raw;
  try { raw = JSON.parse(readFileSync(NATIVE_ROUTE_LEASE_PATH, "utf8")); }
  catch { throw stateError("native_lease_state_invalid", "Native route lease state is unreadable."); }
  if (raw?.version === 3) {
    if (
      !Array.isArray(raw.leases) || raw.leases.length > MAX_LEASES ||
      !Array.isArray(raw.tombstones) || raw.tombstones.length > MAX_TOMBSTONES
    ) {
      throw stateError("native_lease_state_invalid", "Native route lease v3 ledger is invalid.");
    }
    const ids = new Set();
    const legacyTombstones = [];
    for (const value of raw.tombstones) {
      const entry = normalizeV3Tombstone(value);
      if (!entry || ids.has(entry.leaseId)) {
        throw stateError("native_lease_state_invalid", "Native route lease v3 ledger contains an invalid tombstone.");
      }
      ids.add(entry.leaseId);
      legacyTombstones.push(entry);
    }
    for (const value of raw.leases) {
      const entry = normalizeV3Lease(value, now);
      if (!entry || ids.has(entry.leaseId)) {
        throw stateError("native_lease_state_invalid", "Native route lease v3 ledger contains an invalid lease.");
      }
      ids.add(entry.leaseId);
      legacyTombstones.push(entry);
    }
    writeLedgerUnlocked([], [], [], legacyTombstones);
    return { version: LEDGER_VERSION, reservations: [], leases: [], tombstones: [], legacyTombstones };
  }
  if (raw?.version === 4) {
    if (
      !Array.isArray(raw.leases) || raw.leases.length > MAX_LEASES ||
      !Array.isArray(raw.tombstones) || raw.tombstones.length > MAX_TOMBSTONES ||
      !Array.isArray(raw.legacyTombstones) || raw.legacyTombstones.length > MAX_V4_LEGACY_TOMBSTONES
    ) {
      throw stateError("native_lease_state_invalid", "Native route lease v4 ledger is invalid.");
    }
    const ids = new Set();
    const legacyTombstones = [];
    for (const value of raw.legacyTombstones) {
      const entry = normalizeLegacyTombstone(value);
      if (!entry || ids.has(entry.leaseId)) {
        throw stateError("native_lease_state_invalid", "Native route lease v4 ledger contains invalid legacy provenance.");
      }
      ids.add(entry.leaseId);
      legacyTombstones.push(entry);
    }
    for (const value of raw.tombstones) {
      const entry = legacyFromV4Tombstone(value);
      if (!entry || ids.has(entry.leaseId)) {
        throw stateError("native_lease_state_invalid", "Native route lease v4 ledger contains an invalid tombstone.");
      }
      ids.add(entry.leaseId);
      legacyTombstones.push(entry);
    }
    for (const value of raw.leases) {
      const entry = legacyFromV4Lease(value, now);
      if (!entry || ids.has(entry.leaseId)) {
        throw stateError("native_lease_state_invalid", "Native route lease v4 ledger contains an invalid lease.");
      }
      ids.add(entry.leaseId);
      legacyTombstones.push(entry);
    }
    writeLedgerUnlocked([], [], [], legacyTombstones);
    return { version: LEDGER_VERSION, reservations: [], leases: [], tombstones: [], legacyTombstones };
  }
  if (
    raw?.version !== LEDGER_VERSION ||
    !Array.isArray(raw.reservations) || raw.reservations.length > MAX_RESERVATIONS ||
    !Array.isArray(raw.leases) || raw.leases.length > MAX_LEASES ||
    !Array.isArray(raw.tombstones) || raw.tombstones.length > MAX_TOMBSTONES ||
    !Array.isArray(raw.legacyTombstones) || raw.legacyTombstones.length > MAX_LEGACY_TOMBSTONES
  ) {
    throw stateError("native_lease_state_invalid", "Native route lease ledger is invalid.");
  }
  const leases = [];
  const reservations = [];
  const ids = new Set();
  const tombstones = [];
  const legacyTombstones = [];
  for (const rawLegacy of raw.legacyTombstones) {
    const legacy = normalizeLegacyTombstone(rawLegacy);
    if (!legacy || ids.has(legacy.leaseId)) {
      throw stateError("native_lease_state_invalid", "Native route lease ledger contains invalid legacy provenance.");
    }
    ids.add(legacy.leaseId);
    legacyTombstones.push(legacy);
  }
  for (const rawTombstone of raw.tombstones) {
    const tombstone = normalizeTombstone(rawTombstone, { requireReservationId: true });
    if (!tombstone || ids.has(tombstone.leaseId)) {
      throw stateError("native_lease_state_invalid", "Native route lease ledger contains an invalid tombstone.");
    }
    ids.add(tombstone.leaseId);
    tombstones.push(tombstone);
  }
  let converted = false;
  for (const rawLease of raw.leases) {
    const normalized = normalizeLease(rawLease, now, { requireReservationId: true });
    if (!normalized || ids.has(normalized.lease.leaseId)) {
      throw stateError("native_lease_state_invalid", "Native route lease ledger contains an invalid lease.");
    }
    ids.add(normalized.lease.leaseId);
    if (normalized.expired) {
      if (tombstones.length >= MAX_TOMBSTONES) {
        throw stateError("native_lease_tombstone_full", "Native route replay tombstone capacity is full.");
      }
      tombstones.push(tombstoneFor(normalized.lease, "expired", now));
      converted = true;
    } else leases.push(normalized.lease);
  }
  const reservationIds = new Set();
  const reservationLeaseIds = new Set();
  const reservationIdentities = new Set();
  for (const rawReservation of raw.reservations) {
    const normalized = normalizeReservation(rawReservation, now);
    const identity = normalized && [
      normalized.reservation.routeSlug,
      normalized.reservation.cwd,
      normalized.reservation.threadId,
      normalized.reservation.boundTurnId,
      normalized.reservation.lane,
    ].join("\u0000");
    if (
      !normalized || reservationIds.has(normalized.reservation.reservationId) ||
      reservationLeaseIds.has(normalized.reservation.leaseId) ||
      reservationLeaseIds.has(normalized.reservation.reservationId) ||
      reservationIdentities.has(identity) || ids.has(normalized.reservation.reservationId)
    ) {
      throw stateError("native_lease_state_invalid", "Native route lease ledger contains an invalid reservation.");
    }
    reservationIds.add(normalized.reservation.reservationId);
    reservationLeaseIds.add(normalized.reservation.leaseId);
    reservationIdentities.add(identity);
    if (normalized.expired) {
      converted = true;
      continue;
    }
    const active = leases.find((lease) => lease.leaseId === normalized.reservation.leaseId);
    if (active) {
      const reservation = normalized.reservation;
      if (
        active.generation !== reservation.generation || active.routeSlug !== reservation.routeSlug ||
        active.lane !== reservation.lane || active.cwd !== reservation.cwd ||
        active.threadId !== reservation.threadId || active.boundTurnId !== reservation.boundTurnId ||
        active.remainingRequests !== reservation.baseRemainingRequests ||
        JSON.stringify(active.baselineToolOutputIds) !== JSON.stringify(reservation.baselineToolOutputIds) ||
        JSON.stringify(active.seenToolOutputIds) !== JSON.stringify(reservation.baseSeenToolOutputIds)
      ) {
        throw stateError("native_lease_state_invalid", "Native route reservation does not match its committed lease.");
      }
    } else if (ids.has(normalized.reservation.leaseId)) {
      converted = true;
      continue;
    } else if (
      normalized.reservation.baseRemainingRequests !== normalized.reservation.maxRequests ||
      normalized.reservation.baseSeenToolOutputIds.length !== 0
    ) {
      throw stateError("native_lease_state_invalid", "Native route reservation has no matching committed lease.");
    }
    reservations.push(normalized.reservation);
  }
  if (converted) writeLedgerUnlocked(reservations, leases, tombstones, legacyTombstones);
  return { version: LEDGER_VERSION, reservations, leases, tombstones, legacyTombstones };
}

function writeLedgerUnlocked(reservations, leases, tombstones, legacyTombstones = []) {
  if (!reservations.length && !leases.length && !tombstones.length && !legacyTombstones.length) {
    if (existsSync(NATIVE_ROUTE_LEASE_PATH)) unlinkSync(NATIVE_ROUTE_LEASE_PATH);
    return;
  }
  writePrivateJson(
    NATIVE_ROUTE_LEASE_PATH,
    { version: LEDGER_VERSION, reservations, leases, tombstones, legacyTombstones },
    { directoryMode: 0o700 },
  );
}

function withLeaseLock(action) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  try { mkdirSync(NATIVE_ROUTE_LEASE_LOCK_PATH, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === "EEXIST") {
      throw stateError("native_lease_locked", "Native route lease state is busy; no external request was sent.");
    }
    throw error;
  }
  let result;
  let failure;
  try { result = action(); } catch (error) { failure = error; }
  try { rmdirSync(NATIVE_ROUTE_LEASE_LOCK_PATH); }
  catch { failure ||= stateError("native_lease_lock_release_failed", "Native route lease lock could not be released."); }
  if (failure) throw failure;
  return result;
}

function safeLease(lease) {
  return {
    leaseId: lease.leaseId,
    generation: lease.generation,
    routeSlug: lease.routeSlug,
    mode: lease.mode,
    lane: lease.lane,
    cwd: lease.cwd,
    threadId: lease.threadId,
    boundTurnId: lease.boundTurnId,
    remainingRequests: lease.remainingRequests,
    maxRequests: lease.maxRequests,
    integratedToolOutputs: lease.seenToolOutputIds.length,
    createdAt: lease.createdAt,
    boundAt: lease.boundAt,
    lastClaimAt: lease.lastClaimAt,
    expiresAt: lease.expiresAt,
    exhausted: lease.remainingRequests === 0,
    authority: lease.authority,
  };
}

function safeReservation(reservation) {
  return {
    reservationId: reservation.reservationId,
    leaseId: reservation.leaseId,
    generation: reservation.generation,
    routeSlug: reservation.routeSlug,
    mode: reservation.mode,
    lane: reservation.lane,
    cwd: reservation.cwd,
    threadId: reservation.threadId,
    boundTurnId: reservation.boundTurnId,
    remainingRequests: reservation.baseRemainingRequests,
    maxRequests: reservation.maxRequests,
    integratedToolOutputs: reservation.baseSeenToolOutputIds.length,
    createdAt: reservation.createdAt,
    boundAt: reservation.boundAt,
    reservedAt: reservation.reservedAt,
    expiresAt: reservation.expiresAt,
    exhausted: false,
    reserved: true,
    authority: reservation.authority,
  };
}

function ledgerSnapshot(ledger) {
  const latest = [...ledger.leases].sort(
    (a, b) => b.createdAt - a.createdAt || b.leaseId.localeCompare(a.leaseId),
  )[0];
  const latestTombstone = [...ledger.tombstones].sort(
    (a, b) => b.at - a.at || b.leaseId.localeCompare(a.leaseId),
  )[0];
  const latestLegacy = [...ledger.legacyTombstones].sort(
    (a, b) => b.at - a.at || b.leaseId.localeCompare(a.leaseId),
  )[0];
  const retained = !latestTombstone || (latestLegacy && latestLegacy.at > latestTombstone.at)
    ? latestLegacy
    : latestTombstone;
  const latestReservation = [...ledger.reservations].sort(
    (a, b) => b.reservedAt - a.reservedAt || b.reservationId.localeCompare(a.reservationId),
  )[0];
  const current = latestReservation && (!latest || latestReservation.reservedAt >= latest.lastClaimAt)
    ? safeReservation(latestReservation)
    : latest ? safeLease(latest) : undefined;
  return current
    ? {
        configured: true,
        activeCount: ledger.leases.length,
        reservationCount: ledger.reservations.length,
        tombstoneCount: ledger.tombstones.length + ledger.legacyTombstones.length,
        ...(ledger.legacyTombstones.length
          ? { legacyTombstoneCount: ledger.legacyTombstones.length }
          : {}),
        ...current,
      }
    : {
        configured: false,
        activeCount: 0,
        reservationCount: 0,
        tombstoneCount: ledger.tombstones.length + ledger.legacyTombstones.length,
        ...(ledger.legacyTombstones.length
          ? { legacyTombstoneCount: ledger.legacyTombstones.length }
          : {}),
        ...(retained
          ? {
              leaseId: retained.leaseId,
              generation: retained.generation,
              routeSlug: retained.routeSlug,
              ...(retained.lane ? { lane: retained.lane } : {}),
              threadId: retained.threadId,
              boundTurnId: retained.boundTurnId,
              tombstone: true,
              tombstoneReason: retained.reason,
              ...(retained.legacyVersion ? { legacyVersion: retained.legacyVersion } : {}),
            }
          : {}),
      };
}

export function nativeRouteLeaseStatus() {
  return withLeaseLock(() => ledgerSnapshot(readLedgerUnlocked()));
}

export function clearNativeRouteLease(leaseId, generation) {
  const target = uuid(leaseId);
  const targetGeneration = uuid(generation);
  if (!target || !targetGeneration) throw new Error("Native route clear requires exact lease and generation UUIDs.");
  return withLeaseLock(() => {
    const ledger = readLedgerUnlocked();
    const matchedReservation = ledger.reservations.some(
      (reservation) => reservation.leaseId === target && reservation.generation === targetGeneration,
    );
    const matchedLease = ledger.leases.some(
      (lease) => lease.leaseId === target && lease.generation === targetGeneration,
    );
    const matchedTombstone = ledger.tombstones.some(
      (entry) => entry.leaseId === target && entry.generation === targetGeneration,
    );
    const matchedLegacy = ledger.legacyTombstones.some(
      (entry) => entry.leaseId === target && entry.generation === targetGeneration,
    );
    const keptReservations = matchedReservation
      ? ledger.reservations.filter(
          (reservation) => !(reservation.leaseId === target && reservation.generation === targetGeneration),
        )
      : ledger.reservations;
    const kept = matchedLease
      ? ledger.leases.filter(
          (lease) => !(lease.leaseId === target && lease.generation === targetGeneration),
        )
      : ledger.leases;
    const keptTombstones = matchedTombstone
      ? ledger.tombstones.filter(
          (entry) => !(entry.leaseId === target && entry.generation === targetGeneration),
        )
      : ledger.tombstones;
    const keptLegacyTombstones = matchedLegacy
      ? ledger.legacyTombstones.filter(
          (entry) => !(entry.leaseId === target && entry.generation === targetGeneration),
        )
      : ledger.legacyTombstones;
    writeLedgerUnlocked(keptReservations, kept, keptTombstones, keptLegacyTombstones);
    return {
      cleared: matchedReservation || matchedLease || matchedTombstone || matchedLegacy,
      clearedLeaseId: target,
      generation: targetGeneration,
      snapshot: ledgerSnapshot({
        version: LEDGER_VERSION,
        reservations: keptReservations,
        leases: kept,
        tombstones: keptTombstones,
        legacyTombstones: keptLegacyTombstones,
      }),
    };
  });
}

function headerText(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : typeof value === "string" ? value : undefined;
}

function findUuid(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key)) {
      const found = uuid(item);
      if (found) return found;
    }
  }
  for (const item of Object.values(value)) {
    const found = findUuid(item, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findWorkspace(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (["cwd", "workingDirectory", "working_directory", "workspace"].includes(key)) {
      const found = workspace(item);
      if (found) return found;
    }
    if (["workspaces", "workspaceRoots", "workspace_roots"].includes(key) && item && typeof item === "object") {
      for (const candidate of Object.keys(item)) {
        const found = workspace(candidate);
        if (found) return found;
      }
    }
  }
  for (const item of Object.values(value)) {
    const found = findWorkspace(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function parsedMetadata(headers) {
  const raw = headerText(headers, "x-codex-turn-metadata");
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

export function nativeRouteRequestIdentity(headers, payload) {
  const headerMetadata = parsedMetadata(headers);
  const clientMetadata = payload?.client_metadata;
  const thread = new Set(["threadId", "thread_id"]);
  const conversation = new Set(["conversationId", "conversation_id"]);
  const session = new Set(["sessionId", "session_id"]);
  const parent = new Set(["parentThreadId", "parent_thread_id"]);
  const rootTurn = new Set(["rootTurnId", "root_turn_id"]);
  const turn = new Set(["turnId", "turn_id"]);
  const parentId = uuid(headerText(headers, "x-codex-parent-thread-id")) ||
    findUuid(clientMetadata, parent) || findUuid(headerMetadata, parent);
  return {
    threadId: uuid(headerText(headers, "thread-id")) ||
      findUuid(clientMetadata, thread) || findUuid(headerMetadata, thread) ||
      findUuid(clientMetadata, conversation) || findUuid(headerMetadata, conversation) ||
      findUuid(clientMetadata, session) || findUuid(headerMetadata, session),
    rootTurnId: findUuid(clientMetadata, rootTurn) || findUuid(headerMetadata, rootTurn) ||
      findUuid(clientMetadata, turn) || findUuid(headerMetadata, turn),
    cwd: findWorkspace(clientMetadata) || findWorkspace(headerMetadata),
    rootTurn: !parentId && !String(headerText(headers, "x-openai-subagent") || "").trim(),
  };
}

function toolOutputIds(payload) {
  const ids = [];
  for (const item of Array.isArray(payload?.input) ? payload.input : []) {
    if (item?.type !== "function_call_output") continue;
    const id = typeof item.call_id === "string" && item.call_id.length <= 256 ? item.call_id : undefined;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function rejection(type, message) {
  return { ok: false, status: 409, error: { type, message } };
}

export function reserveNativeRouteLease(routeSlug, requestedModel, headers, payload, lane = "response") {
  if (routeSlug !== requestedModel) {
    return rejection("native_route_lease_model_mismatch", "Threadspan routes must be selected explicitly in the native model picker.");
  }
  const route = MODEL_BY_SLUG.get(routeSlug);
  const mode = leaseMode(route?.slug);
  if (!route || !mode || route.provider !== mode) {
    return rejection("unknown_threadspan_picker_route", "The selected model is not a registered Threadspan picker route.");
  }
  if (!LEASE_LANES.has(lane)) {
    return rejection("native_route_lease_lane_invalid", "The Threadspan request lane is invalid.");
  }
  const identity = nativeRouteRequestIdentity(headers, payload);
  if (!identity.rootTurn) return rejection("native_route_lease_root_turn_required", "Threadspan picker routes accept only root task turns.");
  if (!identity.cwd) return rejection("native_route_lease_cwd_mismatch", "The request does not identify an existing workspace.");
  if (!identity.threadId) return rejection("native_route_lease_thread_mismatch", "The request does not identify a native task.");
  if (!identity.rootTurnId) return rejection("native_route_lease_turn_mismatch", "The request does not identify a stable root turn.");

  try {
    return withLeaseLock(() => {
      if (!readProviderSelection().includes(route.provider)) {
        return rejection("native_route_provider_not_selected", "The selected Threadspan provider is hidden.");
      }
      if (!credentialStatus(route.provider, { persistent: true }).configured) {
        return rejection("native_route_credential_missing", "Threadspan owner authentication is unavailable.");
      }
      const now = Date.now();
      const ledger = readLedgerUnlocked(now);
      const legacyReplay = ledger.legacyTombstones.some(
        (entry) => entry.routeSlug === routeSlug && entry.cwd === identity.cwd &&
          entry.threadId === identity.threadId && entry.boundTurnId === identity.rootTurnId &&
          (!entry.lane || entry.lane === lane),
      );
      if (legacyReplay) {
        return rejection(
          "native_route_legacy_replay_blocked",
          "A retained pre-v5 Threadspan dispatch may already have reached its provider and blocks redispatch until exact recovery.",
        );
      }
      const replay = ledger.tombstones.some(
        (entry) => entry.routeSlug === routeSlug && entry.cwd === identity.cwd &&
          entry.threadId === identity.threadId && entry.boundTurnId === identity.rootTurnId &&
          entry.lane === lane,
      );
      if (replay) {
        return rejection(
          "native_route_replay_blocked",
          "This exact Threadspan task turn and request lane were already dispatched and remain retained; redispatch was refused.",
        );
      }
      const pending = ledger.reservations.filter(
        (reservation) => reservation.routeSlug === routeSlug && reservation.cwd === identity.cwd &&
          reservation.threadId === identity.threadId && reservation.boundTurnId === identity.rootTurnId &&
          reservation.lane === lane,
      );
      if (pending.length > 1) {
        return rejection("native_route_reservation_ambiguous", "More than one reservation matches this exact task turn.");
      }
      if (pending.length === 1) {
        return rejection(
          "native_route_reserved",
          "This exact Threadspan task turn and request lane are reserved by concurrent local preparation; no provider request was sent.",
        );
      }
      const matching = ledger.leases.filter(
        (lease) => lease.routeSlug === routeSlug && lease.cwd === identity.cwd &&
          lease.threadId === identity.threadId && lease.boundTurnId === identity.rootTurnId &&
          lease.lane === lane,
      );
      if (matching.length > 1) return rejection("native_route_lease_ambiguous", "More than one lease matches this exact task turn.");
      let lease = matching[0];
      const outputs = toolOutputIds(payload);
      if (!lease) {
        const promisedLeases = ledger.reservations.filter(
          (reservation) => !ledger.leases.some((candidate) => candidate.leaseId === reservation.leaseId),
        ).length;
        if (ledger.leases.length + promisedLeases >= MAX_LEASES) {
          return rejection("native_route_ledger_full", "Too many Threadspan task leases are active or reserved.");
        }
        if (lane === "response" && mode === "integrated" && outputs.length > MAX_BASELINE_TOOL_OUTPUTS) {
          return rejection("native_route_tool_history_too_large", "The task tool history is too large to bind safely.");
        }
        lease = {
          leaseId: randomUUID(), generation: randomUUID(), routeSlug, mode, lane,
          cwd: identity.cwd, threadId: identity.threadId, boundTurnId: identity.rootTurnId,
          baselineToolOutputIds: lane === "response" && mode === "integrated" ? outputs : [],
          seenToolOutputIds: [],
          remainingRequests: maxRequests(mode, lane), maxRequests: maxRequests(mode, lane),
          createdAt: now, boundAt: now, lastClaimAt: now,
          expiresAt: now + LEASE_INACTIVITY_MS, authority: "native-picker-selection",
        };
      } else if (lease.remainingRequests === 0) {
        return rejection("native_route_request_limit", "This Threadspan request lane already dispatched its bounded provider allowance and remains retained.");
      }
      if (ledger.reservations.length >= MAX_RESERVATIONS) {
        return rejection("native_route_reservation_full", "Too many Threadspan dispatches are being prepared concurrently.");
      }
      const promisedTombstones = ledger.reservations.filter(
        (reservation) => reservation.remainingRequests === 0,
      ).length;
      if (
        lease.remainingRequests === 1 &&
        ledger.tombstones.length + promisedTombstones >= MAX_TOMBSTONES
      ) {
        return rejection("native_route_tombstone_full", "Native route replay tombstone capacity is full.");
      }

      let seenToolOutputIds = lease.seenToolOutputIds;
      if (lane === "response" && mode === "integrated" && matching.length) {
        const baseline = new Set(lease.baselineToolOutputIds);
        const seen = new Set(seenToolOutputIds);
        const additions = outputs.filter((id) => !baseline.has(id) && !seen.has(id));
        if (additions.length === 0) {
          return rejection(
            "native_route_tool_progress_required",
            "This Integrated request does not add a new tool result; no provider request was sent.",
          );
        }
        if (seen.size + additions.length > MAX_INTEGRATED_TOOL_OUTPUTS) {
          return rejection("native_route_tool_call_limit", "The Integrated turn reached its 16-tool-call ceiling.");
        }
        seenToolOutputIds = [...seenToolOutputIds, ...additions];
      }
      const reservation = {
        reservationId: randomUUID(),
        leaseId: lease.leaseId,
        generation: lease.generation,
        routeSlug: lease.routeSlug,
        mode: lease.mode,
        lane: lease.lane,
        cwd: lease.cwd,
        threadId: lease.threadId,
        boundTurnId: lease.boundTurnId,
        baselineToolOutputIds: lease.baselineToolOutputIds,
        baseSeenToolOutputIds: lease.seenToolOutputIds,
        seenToolOutputIds,
        baseRemainingRequests: lease.remainingRequests,
        remainingRequests: lease.remainingRequests - 1,
        maxRequests: lease.maxRequests,
        createdAt: lease.createdAt,
        boundAt: lease.boundAt,
        reservedAt: now,
        expiresAt: now + LEASE_INACTIVITY_MS,
        authority: "native-picker-selection",
      };
      const reservations = [...ledger.reservations, reservation];
      writeLedgerUnlocked(reservations, ledger.leases, ledger.tombstones, ledger.legacyTombstones);
      return {
        ok: true,
        reservation: {
          configured: true,
          activeCount: ledger.leases.length,
          reservationCount: reservations.length,
          tombstoneCount: ledger.tombstones.length + ledger.legacyTombstones.length,
          ...safeReservation(reservation),
        },
      };
    });
  } catch (error) {
    if (error?.code === "native_lease_locked") return rejection("native_route_lease_locked", error.message);
    return rejection("native_route_lease_state_invalid", "Native route lease state could not be validated; no provider request was sent.");
  }
}

function reservationReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reservationId = uuid(value.reservationId);
  const leaseId = uuid(value.leaseId);
  const generation = uuid(value.generation);
  return reservationId && leaseId && generation ? { reservationId, leaseId, generation } : undefined;
}

export function commitNativeRouteReservation(value) {
  const reference = reservationReference(value);
  if (!reference) return rejection("native_route_reservation_invalid", "The Threadspan dispatch reservation is invalid; no provider request was sent.");
  try {
    return withLeaseLock(() => {
      const ledger = readLedgerUnlocked();
      const reservation = ledger.reservations.find(
        (candidate) => candidate.reservationId === reference.reservationId &&
          candidate.leaseId === reference.leaseId && candidate.generation === reference.generation,
      );
      if (!reservation) {
        const retained = [...ledger.leases, ...ledger.tombstones].some(
          (candidate) => candidate.leaseId === reference.leaseId &&
            candidate.generation === reference.generation &&
            candidate.lastReservationId === reference.reservationId,
        );
        return retained
          ? rejection(
              "native_route_dispatch_retained",
              "This Threadspan dispatch was already committed and remains retained; no duplicate provider request was sent.",
            )
          : rejection(
              "native_route_reservation_missing",
              "The exact Threadspan dispatch reservation no longer exists; no provider request was sent.",
            );
      }
      const now = Date.now();
      const updated = {
        leaseId: reservation.leaseId,
        generation: reservation.generation,
        routeSlug: reservation.routeSlug,
        mode: reservation.mode,
        lane: reservation.lane,
        cwd: reservation.cwd,
        threadId: reservation.threadId,
        boundTurnId: reservation.boundTurnId,
        baselineToolOutputIds: reservation.baselineToolOutputIds,
        seenToolOutputIds: reservation.seenToolOutputIds,
        remainingRequests: reservation.remainingRequests,
        maxRequests: reservation.maxRequests,
        createdAt: reservation.createdAt,
        boundAt: reservation.boundAt,
        lastClaimAt: now,
        expiresAt: now + LEASE_INACTIVITY_MS,
        lastReservationId: reservation.reservationId,
        authority: "native-picker-selection",
      };
      const reservations = ledger.reservations.filter(
        (candidate) => candidate.reservationId !== reservation.reservationId,
      );
      const exhausted = updated.remainingRequests === 0;
      const hadLease = ledger.leases.some((candidate) => candidate.leaseId === updated.leaseId);
      if (!hadLease && !exhausted && ledger.leases.length >= MAX_LEASES) {
        return rejection("native_route_ledger_full", "Native route lease capacity changed before commit; no provider request was sent.");
      }
      if (exhausted && ledger.tombstones.length >= MAX_TOMBSTONES) {
        return rejection("native_route_tombstone_full", "Native route replay tombstone capacity changed before commit; no provider request was sent.");
      }
      const leases = exhausted
        ? ledger.leases.filter((candidate) => candidate.leaseId !== updated.leaseId)
        : hadLease
          ? ledger.leases.map((candidate) => candidate.leaseId === updated.leaseId ? updated : candidate)
          : [...ledger.leases, updated];
      const tombstones = exhausted
        ? [...ledger.tombstones, tombstoneFor(updated, "exhausted", now)]
        : ledger.tombstones;
      writeLedgerUnlocked(reservations, leases, tombstones, ledger.legacyTombstones);
      return {
        ok: true,
        lease: {
          configured: !exhausted,
          activeCount: leases.length,
          reservationCount: reservations.length,
          tombstoneCount: tombstones.length + ledger.legacyTombstones.length,
          ...safeLease(updated),
          ...(exhausted ? { tombstone: true, tombstoneReason: "exhausted" } : {}),
        },
      };
    });
  } catch (error) {
    if (error?.code === "native_lease_locked") return rejection("native_route_lease_locked", error.message);
    return rejection("native_route_lease_state_invalid", "Native route lease state could not be validated; no provider request was sent.");
  }
}

export function rollbackNativeRouteReservation(value) {
  const reference = reservationReference(value);
  if (!reference) throw new Error("Native route rollback requires an exact reservation, lease, and generation UUID.");
  return withLeaseLock(() => {
    const ledger = readLedgerUnlocked();
    const reservations = ledger.reservations.filter(
      (candidate) => !(
        candidate.reservationId === reference.reservationId &&
        candidate.leaseId === reference.leaseId && candidate.generation === reference.generation
      ),
    );
    const rolledBack = reservations.length !== ledger.reservations.length;
    if (rolledBack) {
      writeLedgerUnlocked(reservations, ledger.leases, ledger.tombstones, ledger.legacyTombstones);
    }
    return {
      rolledBack,
      reservationId: reference.reservationId,
      leaseId: reference.leaseId,
      generation: reference.generation,
      snapshot: ledgerSnapshot({ ...ledger, reservations }),
    };
  });
}

export function validateThreadspanMetadata(payload) {
  if (!payload.metadata || typeof payload.metadata !== "object" || Array.isArray(payload.metadata)) {
    if (payload.metadata !== undefined && payload.metadata !== null) {
      const error = new Error("Threadspan request metadata must be an object.");
      error.status = 400;
      throw error;
    }
  }
  return true;
}

export function injectThreadspanMetadata(payload, route, lease) {
  payload.metadata = {
    ...(payload.metadata || {}),
    cwd: lease.cwd,
    bridge_workspace: lease.cwd,
    bridge_thread_id: lease.threadId,
    ...RESERVED_METADATA,
    bridge_allow_subagents: leaseMode(route.slug) === "delegate",
    bridge_reasoning_effort: route.defaultEffort,
  };
  return payload;
}

export function isThreadspanRoute(route) {
  return Boolean(route && leaseMode(route.slug) && route.provider === leaseMode(route.slug));
}
