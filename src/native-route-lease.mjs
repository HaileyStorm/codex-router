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
const LEDGER_VERSION = 4;
const LEASE_INACTIVITY_MS = 30 * 60 * 1000;
const MAX_LEASES = 32;
const MAX_TOMBSTONES = 4_096;
const MAX_LEGACY_TOMBSTONES = MAX_TOMBSTONES + MAX_LEASES;
const MAX_BASELINE_TOOL_OUTPUTS = 4_096;
const MAX_INTEGRATED_TOOL_OUTPUTS = 16;
const RESERVED_METADATA = Object.freeze({
  bridge_allow_subagents: false,
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

function normalizeLease(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const leaseId = uuid(value.leaseId);
  const generation = uuid(value.generation);
  const mode = leaseMode(value.routeSlug);
  const lane = LEASE_LANES.has(value.lane) ? value.lane : undefined;
  const cwd = workspace(value.cwd, { mustExist: false });
  const threadId = uuid(value.threadId);
  const boundTurnId = uuid(value.boundTurnId);
  const baselineToolOutputIds = uniqueIds(value.baselineToolOutputIds, MAX_BASELINE_TOOL_OUTPUTS);
  const seenToolOutputIds = uniqueIds(value.seenToolOutputIds, MAX_INTEGRATED_TOOL_OUTPUTS);
  const maximum = maxRequests(mode, lane);
  if (
    !leaseId || !generation || !mode || !lane || !cwd || value.cwd !== cwd || !threadId || !boundTurnId ||
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
      baselineToolOutputIds, seenToolOutputIds,
      remainingRequests: value.remainingRequests, maxRequests: maximum,
      createdAt: value.createdAt, boundAt: value.boundAt,
      lastClaimAt: value.lastClaimAt, expiresAt: value.expiresAt,
      authority: "native-picker-selection",
    },
    expired: now >= value.expiresAt,
  };
}

function normalizeTombstone(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const leaseId = uuid(value.leaseId);
  const generation = uuid(value.generation);
  const mode = leaseMode(value.routeSlug);
  const lane = LEASE_LANES.has(value.lane) ? value.lane : undefined;
  const cwd = workspace(value.cwd, { mustExist: false });
  const threadId = uuid(value.threadId);
  const boundTurnId = uuid(value.boundTurnId);
  if (
    !leaseId || !generation || !mode || !lane || !cwd || value.cwd !== cwd || !threadId || !boundTurnId ||
    !["expired", "exhausted"].includes(value.reason) ||
    !Number.isInteger(value.createdAt) || !Number.isInteger(value.at) || value.createdAt > value.at
  ) return undefined;
  return {
    leaseId, generation, routeSlug: value.routeSlug, mode, lane, cwd, threadId, boundTurnId,
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

function normalizeLegacyTombstone(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const leaseId = uuid(value.leaseId);
  const generation = uuid(value.generation);
  const mode = leaseMode(value.routeSlug);
  const cwd = workspace(value.cwd, { mustExist: false });
  const threadId = uuid(value.threadId);
  const boundTurnId = uuid(value.boundTurnId);
  if (
    !leaseId || !generation || !mode || !cwd || value.cwd !== cwd || !threadId || !boundTurnId ||
    value.legacyVersion !== 3 || !["lease", "tombstone"].includes(value.source) ||
    !["retained", "expired", "exhausted"].includes(value.reason) ||
    (value.source === "tombstone" && value.reason === "retained") ||
    !Number.isInteger(value.createdAt) || !Number.isInteger(value.at) || value.createdAt > value.at
  ) return undefined;
  return {
    leaseId, generation, routeSlug: value.routeSlug, mode, cwd, threadId, boundTurnId,
    createdAt: value.createdAt, at: value.at, reason: value.reason,
    source: value.source, legacyVersion: 3,
  };
}

function readLedgerUnlocked(now = Date.now()) {
  if (!existsSync(NATIVE_ROUTE_LEASE_PATH)) {
    return { version: LEDGER_VERSION, leases: [], tombstones: [], legacyTombstones: [] };
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
    writeLedgerUnlocked([], [], legacyTombstones);
    return { version: LEDGER_VERSION, leases: [], tombstones: [], legacyTombstones };
  }
  if (
    raw?.version !== LEDGER_VERSION || !Array.isArray(raw.leases) || raw.leases.length > MAX_LEASES ||
    !Array.isArray(raw.tombstones) || raw.tombstones.length > MAX_TOMBSTONES ||
    !Array.isArray(raw.legacyTombstones) || raw.legacyTombstones.length > MAX_LEGACY_TOMBSTONES
  ) {
    throw stateError("native_lease_state_invalid", "Native route lease ledger is invalid.");
  }
  const leases = [];
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
    const tombstone = normalizeTombstone(rawTombstone);
    if (!tombstone || ids.has(tombstone.leaseId)) {
      throw stateError("native_lease_state_invalid", "Native route lease ledger contains an invalid tombstone.");
    }
    ids.add(tombstone.leaseId);
    tombstones.push(tombstone);
  }
  let converted = false;
  for (const rawLease of raw.leases) {
    const normalized = normalizeLease(rawLease, now);
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
  if (converted) writeLedgerUnlocked(leases, tombstones, legacyTombstones);
  return { version: LEDGER_VERSION, leases, tombstones, legacyTombstones };
}

function writeLedgerUnlocked(leases, tombstones, legacyTombstones = []) {
  if (!leases.length && !tombstones.length && !legacyTombstones.length) {
    if (existsSync(NATIVE_ROUTE_LEASE_PATH)) unlinkSync(NATIVE_ROUTE_LEASE_PATH);
    return;
  }
  writePrivateJson(
    NATIVE_ROUTE_LEASE_PATH,
    { version: LEDGER_VERSION, leases, tombstones, legacyTombstones },
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
  return latest
    ? {
        configured: true,
        activeCount: ledger.leases.length,
        tombstoneCount: ledger.tombstones.length + ledger.legacyTombstones.length,
        ...(ledger.legacyTombstones.length
          ? { legacyTombstoneCount: ledger.legacyTombstones.length }
          : {}),
        ...safeLease(latest),
      }
    : {
        configured: false,
        activeCount: 0,
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
    const matchedLease = ledger.leases.some(
      (lease) => lease.leaseId === target && lease.generation === targetGeneration,
    );
    const matchedTombstone = ledger.tombstones.some(
      (entry) => entry.leaseId === target && entry.generation === targetGeneration,
    );
    const matchedLegacy = ledger.legacyTombstones.some(
      (entry) => entry.leaseId === target && entry.generation === targetGeneration,
    );
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
    writeLedgerUnlocked(kept, keptTombstones, keptLegacyTombstones);
    return {
      cleared: matchedLease || matchedTombstone || matchedLegacy,
      clearedLeaseId: target,
      generation: targetGeneration,
      snapshot: ledgerSnapshot({
        version: LEDGER_VERSION,
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

export function claimNativeRouteLease(routeSlug, requestedModel, headers, payload, lane = "response") {
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
          entry.threadId === identity.threadId && entry.boundTurnId === identity.rootTurnId,
      );
      if (legacyReplay) {
        return rejection(
          "native_route_legacy_replay_blocked",
          "A retained v3 Threadspan task-turn claim predates request lanes and blocks redispatch until exact recovery.",
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
      const matching = ledger.leases.filter(
        (lease) => lease.routeSlug === routeSlug && lease.cwd === identity.cwd &&
          lease.threadId === identity.threadId && lease.boundTurnId === identity.rootTurnId &&
          lease.lane === lane,
      );
      if (matching.length > 1) return rejection("native_route_lease_ambiguous", "More than one lease matches this exact task turn.");
      let lease = matching[0];
      const outputs = toolOutputIds(payload);
      if (!lease) {
        if (ledger.leases.length >= MAX_LEASES) return rejection("native_route_ledger_full", "Too many Threadspan task leases are active.");
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
        return rejection("native_route_request_limit", "This Threadspan request lane already dispatched its bounded provider allowance.");
      }
      if (lease.remainingRequests === 1 && ledger.tombstones.length >= MAX_TOMBSTONES) {
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
            "This Integrated request does not add a new tool result; duplicate redispatch was refused.",
          );
        }
        if (seen.size + additions.length > MAX_INTEGRATED_TOOL_OUTPUTS) {
          return rejection("native_route_tool_call_limit", "The Integrated turn reached its 16-tool-call ceiling.");
        }
        seenToolOutputIds = [...seenToolOutputIds, ...additions];
      }
      const updated = {
        ...lease,
        seenToolOutputIds,
        remainingRequests: lease.remainingRequests - 1,
        lastClaimAt: now,
        expiresAt: now + LEASE_INACTIVITY_MS,
      };
      const exhausted = updated.remainingRequests === 0;
      const leases = exhausted
        ? ledger.leases.filter((candidate) => candidate.leaseId !== lease.leaseId)
        : matching.length
          ? ledger.leases.map((candidate) => candidate.leaseId === lease.leaseId ? updated : candidate)
          : [...ledger.leases, updated];
      const tombstones = exhausted
        ? [...ledger.tombstones, tombstoneFor(updated, "exhausted", now)]
        : ledger.tombstones;
      writeLedgerUnlocked(leases, tombstones, ledger.legacyTombstones);
      return {
        ok: true,
        lease: {
          configured: !exhausted,
          activeCount: leases.length,
          tombstoneCount: tombstones.length + ledger.legacyTombstones.length,
          ...safeLease(updated),
          ...(exhausted ? { tombstone: true, tombstoneReason: "exhausted" } : {}),
        },
      };
    });
  } catch (error) {
    if (error?.code === "native_lease_locked") return rejection("native_route_lease_locked", error.message);
    return rejection("native_route_lease_state_invalid", "Native route lease state could not be validated.");
  }
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
    bridge_reasoning_effort: route.defaultEffort,
  };
  return payload;
}

export function isThreadspanRoute(route) {
  return Boolean(route && leaseMode(route.slug) && route.provider === leaseMode(route.slug));
}
