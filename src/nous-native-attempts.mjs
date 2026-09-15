import { createHmac } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { protectPrivateFile } from "./file-security.mjs";
import { nativeRouteRequestIdentity } from "./native-route-lease.mjs";
import { STATE_DIR } from "./paths.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_DATABASE = path.join(STATE_DIR, "nous-native-attempts", "attempts.sqlite");
// These fields select transport/cache representation, not the model operation.
const TRANSPORT_FIELDS = new Set(["stream", "client_metadata", "prompt_cache_key"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function nousNativeAttemptKey(headers, payload, lane, internalKey) {
  if (typeof internalKey !== "string" || !internalKey) throw new Error("Missing internal key");
  const identity = nativeRouteRequestIdentity(headers, payload);
  const explicit = headers?.["x-codex-nous-request-id"];
  if (explicit !== undefined && (typeof explicit !== "string" || !UUID.test(explicit))) {
    throw new Error("Invalid explicit request identity");
  }
  const fallbackThread = ["thread-id", "session-id", "session_id"]
    .map(name => headers?.[name]).find(value => typeof value === "string" && UUID.test(value));
  const scope = explicit
    ? { requestId: explicit.toLowerCase() }
    : { threadId: identity.threadId || fallbackThread?.toLowerCase() || null, turnId: identity.rootTurnId || null };
  const operation = Object.fromEntries(Object.entries(payload).filter(([key]) => !TRANSPORT_FIELDS.has(key)));
  return createHmac("sha256", internalKey)
    .update("codex-nous-native-attempt-v1\0")
    .update(JSON.stringify(canonical({ scope, lane, operation })))
    .digest("hex");
}

function rejection(type, message, attemptId) {
  return { ok: false, status: 400, error: { type, message }, ...(attemptId ? { attemptId } : {}) };
}

/**
 * Admit a native request once, before any network work. A durable, atomic
 * insert prevents a client retry (including after a lost response/restart)
 * from buying another provider attempt or repeating exposed tool calls.
 * Only an HMAC digest and timestamp are stored; no prompt, identity, or key.
 * Claims are never released, expired, or replayed as cached tool responses.
 */
export function claimNousNativeAttempt({ headers, payload, lane, internalKey, databasePath = DEFAULT_DATABASE }) {
  let key;
  try { key = nousNativeAttemptKey(headers, payload, lane, internalKey); }
  catch {
    return rejection("local_nous_attempt_identity_invalid", "Nous Direct could not identify this request safely. Use a fresh native turn or a valid unique x-codex-nous-request-id UUID; nothing was sent to Nous.");
  }
  let database;
  try {
    const directory = path.dirname(databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Invalid directory");
    if (process.platform === "win32") protectPrivateFile(directory);
    try {
      closeSync(openSync(databasePath, "wx", 0o600));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const fileInfo = lstatSync(databasePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("Invalid database");
    protectPrivateFile(databasePath);
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;");
    database.exec("CREATE TABLE IF NOT EXISTS attempts (digest TEXT PRIMARY KEY NOT NULL, admitted_at TEXT NOT NULL) WITHOUT ROWID;");
    const result = database.prepare("INSERT OR IGNORE INTO attempts (digest, admitted_at) VALUES (?, ?)")
      .run(key, new Date().toISOString());
    if (result.changes !== 1) {
      return rejection("local_nous_attempt_already_admitted", "This Nous request was already admitted and will not be replayed. Its earlier outcome may be complete or uncertain. Start a fresh turn/task for independent work; stateless clients must use a new x-codex-nous-request-id UUID.", key);
    }
    return { ok: true, attemptId: key };
  } catch {
    return rejection("local_nous_attempt_record_unavailable", "Nous Direct could not durably record this request, so nothing was sent to Nous. Check the router's writable local state and SQLite runtime before starting an independent request.", key);
  } finally {
    database?.close();
  }
}
