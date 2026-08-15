import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

import { privateFileIsProtected, protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const TOOL_RESULT_RETENTION_DIR =
  process.env.MODEL_ROUTER_TOOL_RESULT_RETENTION_DIR ||
  path.join(STATE_DIR, "retained-tool-results");
export const TOOL_RESULT_RETRIEVAL_DIR = path.join(STATE_DIR, "retrieved-tool-results");

const RETENTION_KEY_PATH = path.join(TOOL_RESULT_RETENTION_DIR, ".retention-key");
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 512;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RESULT_FILE_PATTERN = /^([A-Za-z0-9_-]{43})\.result$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const STAGE_FILE_PATTERN = /^\.(.+)\.stage\.([0-9a-f]{32})$/u;
const NO_FOLLOW = constants.O_NOFOLLOW || 0;
const RETENTION_REASONS = new Set(["capacity", "storage"]);
const LOCK_WAIT_WORD = new Int32Array(new SharedArrayBuffer(4));
const LOCK_WAIT_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 1_000;
const LOCK_WAIT_POLL_MS = process.platform === "win32" ? 25 : 10;

function retentionFailure(reason, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.retentionReason = RETENTION_REASONS.has(reason) ? reason : "storage";
  return error;
}

function wrappedRetentionFailure(error) {
  return retentionFailure(
    error?.retentionReason,
    "Could not retain the exact tool result safely.",
    error,
  );
}

function boundedLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

export const TOOL_RESULT_RETENTION_MAX_RESULT_BYTES = boundedLimit(
  "MODEL_ROUTER_TOOL_RESULT_RETENTION_MAX_RESULT_BYTES",
  DEFAULT_MAX_RESULT_BYTES,
);
export const TOOL_RESULT_RETENTION_MAX_FILES = boundedLimit(
  "MODEL_ROUTER_TOOL_RESULT_RETENTION_MAX_FILES",
  DEFAULT_MAX_FILES,
);
export const TOOL_RESULT_RETENTION_MAX_TOTAL_BYTES = boundedLimit(
  "MODEL_ROUTER_TOOL_RESULT_RETENTION_MAX_TOTAL_BYTES",
  DEFAULT_MAX_TOTAL_BYTES,
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedRealPath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// The canonical form of a path whose deepest components may not exist yet:
// resolve the longest existing prefix, then re-append what is still missing.
//
// Refusing every symlink between the filesystem root and the store treats the
// operating system's own layout as an attack. `/var` is a symlink to
// `/private/var` on stock macOS, so every path under `os.tmpdir()` traverses
// one; container bind mounts and symlinked home directories are equally
// ordinary. Canonicalizing first keeps the guarantee that actually matters --
// the directory written to is the directory that was validated, and we own it
// -- while the per-component walk below still refuses a link planted inside
// the store after canonicalization.
function canonicalExistingPath(directory) {
  const resolved = path.resolve(directory);
  const missing = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      // A root that does not resolve has nothing left to walk up to.
      if (parent === current) return resolved;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function ensureDirectoryPathWithoutLinks(directory) {
  const resolved = canonicalExistingPath(directory);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Retained-result storage path traverses a link.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
}

function assertPlainOwnedDirectory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Retained-result storage is not a plain directory.");
  }
  // Compared against the canonical form rather than the literal one: what has
  // to hold is that this path resolves where it resolved when it was checked,
  // not that the operating system placed it behind no symlink at all.
  if (
    normalizedRealPath(realpathSync.native(directory)) !==
    normalizedRealPath(canonicalExistingPath(directory))
  ) {
    throw new Error("Retained-result storage may not traverse a link.");
  }
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    if (stat.uid !== process.getuid()) {
      throw new Error("Retained-result storage has a different owner.");
    }
  }
}

function protectPrivateDirectory(directory) {
  chmodSync(directory, 0o700);
  if (process.platform === "win32") {
    protectPrivateFile(directory);
    chmodSync(directory, 0o700);
  }
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, constants.O_RDONLY | NO_FOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function lockRetentionDirectory() {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      return lockfile.lockSync(TOOL_RESULT_RETENTION_DIR, {
        realpath: true,
        retries: 0,
        stale: 30_000,
      });
    } catch (error) {
      const remaining = deadline - Date.now();
      if (error?.code !== "ELOCKED" || remaining <= 0) throw error;
      // proper-lockfile deliberately rejects retry configuration for its sync
      // API. Windows owner-only ACL verification invokes PowerShell several
      // times inside one repair, so its normal contention window is longer
      // than POSIX fsync-only publication. Both deadlines remain bounded.
      Atomics.wait(
        LOCK_WAIT_WORD,
        0,
        0,
        Math.min(LOCK_WAIT_POLL_MS, remaining),
      );
    }
  }
}

function ensurePrivateDirectory() {
  ensureDirectoryPathWithoutLinks(STATE_DIR);
  assertPlainOwnedDirectory(STATE_DIR);
  protectPrivateDirectory(STATE_DIR);
  if (path.dirname(path.resolve(TOOL_RESULT_RETENTION_DIR)) !== path.resolve(STATE_DIR)) {
    throw new Error("Retained-result storage must be a direct child of router state.");
  }
  ensureDirectoryPathWithoutLinks(TOOL_RESULT_RETENTION_DIR);
  assertPlainOwnedDirectory(TOOL_RESULT_RETENTION_DIR);
  protectPrivateDirectory(TOOL_RESULT_RETENTION_DIR);
}

function ensurePrivateRetrievalDirectory() {
  ensurePrivateDirectory();
  if (path.dirname(path.resolve(TOOL_RESULT_RETRIEVAL_DIR)) !== path.resolve(STATE_DIR)) {
    throw new Error("Retrieved-result storage must be a direct child of router state.");
  }
  ensureDirectoryPathWithoutLinks(TOOL_RESULT_RETRIEVAL_DIR);
  assertPlainOwnedDirectory(TOOL_RESULT_RETRIEVAL_DIR);
  protectPrivateDirectory(TOOL_RESULT_RETRIEVAL_DIR);
}

function assertRepairablePrivateFile(target) {
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("Torn private file is not safely repairable.");
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error("Torn private file has a different owner.");
  }
  if (!privateFileIsProtected(target)) {
    throw new Error("Torn private file is not owner-private.");
  }
  return stat;
}

function cleanupPublishedStages(target) {
  const directory = path.dirname(target);
  const expectedBase = path.basename(target);
  let changed = false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = STAGE_FILE_PATTERN.exec(entry.name);
    if (!match || match[1] !== expectedBase) continue;
    const stage = path.join(directory, entry.name);
    const stageStat = lstatSync(stage);
    if (
      !entry.isFile() ||
      !stageStat.isFile() ||
      stageStat.isSymbolicLink() ||
      ![1, 2].includes(stageStat.nlink)
    ) {
      throw new Error("Private staging path is unsafe.");
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stageStat.uid !== process.getuid()
    ) {
      throw new Error("Private staging path has a different owner.");
    }
    if (!privateFileIsProtected(stage)) {
      throw new Error("Private staging path is not owner-private.");
    }
    if (stageStat.nlink === 2) {
      const publishedStat = lstatSync(target);
      if (
        !publishedStat.isFile() ||
        publishedStat.isSymbolicLink() ||
        publishedStat.dev !== stageStat.dev ||
        publishedStat.ino !== stageStat.ino
      ) {
        throw new Error("Private staging hardlink has no matching publication.");
      }
      unlinkSync(stage);
      changed = true;
    }
  }
  if (changed) syncDirectory(directory);
}

function writePrivateStage(target, bytes) {
  const stage = path.join(
    path.dirname(target),
    `.${path.basename(target)}.stage.${randomBytes(16).toString("hex")}`,
  );
  let descriptor = openSync(
    stage,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
    0o600,
  );
  try {
    // Apply the Windows owner-only ACL while the exclusive file is empty.
    // POSIX received mode 0600 atomically in openSync.
    protectPrivateFile(stage);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Retained-result write made no progress.");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const verified = readProtectedFile(stage, bytes.length);
    if (!verified.equals(bytes)) throw new Error("Private staging read-back mismatch.");
    return stage;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try {
      if (existsSync(stage)) unlinkSync(stage);
      syncDirectory(path.dirname(stage));
    } catch {}
    throw error;
  }
}

function writeExclusivePrivateFile(target, bytes) {
  if (existsSync(target)) {
    const error = new Error("Private destination already exists.");
    error.code = "EEXIST";
    throw error;
  }
  const stage = writePrivateStage(target, bytes);
  try {
    // Hard-link publication is atomic and refuses an existing target. The
    // fully written/fsynced stage is never exposed under its final name early.
    linkSync(stage, target);
    try {
      unlinkSync(stage);
    } catch (error) {
      // A concurrent reader may have verified this exact hardlink and cleaned
      // its published staging name. The final target remains the same inode;
      // every caller still performs its own protected read-back.
      if (error?.code !== "ENOENT") throw error;
    }
    syncDirectory(path.dirname(target));
  } catch (error) {
    try {
      if (existsSync(stage)) unlinkSync(stage);
      syncDirectory(path.dirname(target));
    } catch {}
    throw error;
  }
}

function replaceTornPrivateFile(target, bytes) {
  assertRepairablePrivateFile(target);
  const stage = writePrivateStage(target, bytes);
  try {
    renameSync(stage, target);
    syncDirectory(path.dirname(target));
  } catch (error) {
    try {
      if (existsSync(stage)) unlinkSync(stage);
      syncDirectory(path.dirname(target));
    } catch {}
    throw error;
  }
}

function readProtectedFile(target, expectedLength) {
  const before = lstatSync(target);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size !== expectedLength
  ) {
    throw new Error("Retained result target is not a plain file.");
  }
  const descriptor = openSync(target, constants.O_RDONLY | NO_FOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedLength) {
      throw new Error("Retained result metadata mismatch.");
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stat.uid !== process.getuid()
    ) {
      throw new Error("Retained result has a different owner.");
    }
    const after = lstatSync(target);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.size !== expectedLength ||
      (before.dev !== 0 && stat.dev !== 0 && before.dev !== stat.dev) ||
      (before.ino !== 0 && stat.ino !== 0 && before.ino !== stat.ino) ||
      (after.dev !== 0 && stat.dev !== 0 && after.dev !== stat.dev) ||
      (after.ino !== 0 && stat.ino !== 0 && after.ino !== stat.ino)
    ) {
      throw new Error("Retained result target changed while it was opened.");
    }
    if (!privateFileIsProtected(target)) {
      throw new Error("Retained result is not owner-private.");
    }
    const bytes = readFileSync(descriptor);
    if (bytes.length !== expectedLength) throw new Error("Retained result length mismatch.");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function retentionKey() {
  ensurePrivateDirectory();
  const hasResults = () =>
    readdirSync(TOOL_RESULT_RETENTION_DIR, { withFileTypes: true })
      .some((entry) => entry.isFile() && RESULT_FILE_PATTERN.test(entry.name));

  const readExisting = () => {
    // A previous publication may have installed the final hardlink/rename but
    // failed both directory fsync attempts. Re-prove parent durability before
    // any process derives or accepts a receipt from that existing name.
    if (existsSync(RETENTION_KEY_PATH)) {
      syncDirectory(TOOL_RESULT_RETENTION_DIR);
      cleanupPublishedStages(RETENTION_KEY_PATH);
    }
    return readProtectedFile(RETENTION_KEY_PATH, 32);
  };

  try {
    return readExisting();
  } catch {}

  // A missing or torn key changes every deterministic result handle. Recheck
  // and repair it under the publication lock so concurrent processes cannot
  // derive receipts from different key generations.
  let release;
  try {
    release = lockRetentionDirectory();
    try {
      return readExisting();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // I/O and durability failures do not prove the key itself is torn.
        // Repair is limited to a readable, owner-private final file whose
        // protected metadata/content validation raised a local invariant error.
        if (typeof error?.code === "string") throw error;
        if (!existsSync(RETENTION_KEY_PATH) || hasResults()) throw error;
        replaceTornPrivateFile(RETENTION_KEY_PATH, randomBytes(32));
        return readExisting();
      }
      if (hasResults()) {
        throw new Error("Retained-result key is missing while retained results still exist.");
      }
      writeExclusivePrivateFile(RETENTION_KEY_PATH, randomBytes(32));
      return readExisting();
    }
  } finally {
    if (release) release();
  }
}

export function toolResultRetentionContext(kind, model) {
  if (
    !["routed", "native"].includes(kind) ||
    typeof model !== "string" ||
    model.length === 0 ||
    model.length > 512
  ) {
    throw new Error("Retained tool result has invalid route provenance.");
  }
  return sha256(Buffer.from(`v1\0${kind}\0${model}`, "utf8"));
}

function sourceBinding(callId, outputType, context) {
  if (
    typeof callId !== "string" ||
    callId.length === 0 ||
    callId.length > 512 ||
    !["function_call_output", "custom_tool_call_output"].includes(outputType) ||
    !DIGEST_PATTERN.test(context)
  ) {
    throw new Error("Retained tool result has invalid call provenance.");
  }
  return `${context}\0${outputType}\0${callId}`;
}

function retainedHandle(digest, byteLength, callId, outputType, context) {
  return createHmac("sha256", retentionKey())
    .update(`v1\0${digest}\0${byteLength}\0${sourceBinding(callId, outputType, context)}`)
    .digest("base64url");
}

function retainedPath(handle) {
  if (!HANDLE_PATTERN.test(handle)) throw new Error("Invalid retained-result capability.");
  return path.join(TOOL_RESULT_RETENTION_DIR, `${handle}.result`);
}

function readVerified(target, digest, byteLength) {
  const bytes = readProtectedFile(target, byteLength);
  if (sha256(bytes) !== digest) throw new Error("Retained result digest mismatch.");
  return bytes;
}

function storageUsage() {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(TOOL_RESULT_RETENTION_DIR, { withFileTypes: true })) {
    if (entry.name === path.basename(RETENTION_KEY_PATH)) continue;
    if (STAGE_FILE_PATTERN.test(entry.name)) {
      const stage = path.join(TOOL_RESULT_RETENTION_DIR, entry.name);
      const stat = lstatSync(stage);
      if (!stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink)) {
        throw new Error("Retained-result storage contains an unsafe stage.");
      }
      if (!privateFileIsProtected(stage)) {
        throw new Error("Retained-result storage contains an unprotected stage.");
      }
      if (
        process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        stat.uid !== process.getuid()
      ) {
        throw new Error("Retained-result storage contains a stage owned by another user.");
      }
      files += 1;
      bytes += stat.size;
      if (!Number.isSafeInteger(bytes)) throw new Error("Retained-result storage size overflow.");
      continue;
    }
    const match = RESULT_FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile()) {
      throw new Error("Retained-result storage contains an unexpected entry.");
    }
    const target = retainedPath(match[1]);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("Retained-result storage contains an unsafe entry.");
    }
    files += 1;
    bytes += stat.size;
    if (!Number.isSafeInteger(bytes)) throw new Error("Retained-result storage size overflow.");
  }
  return { files, bytes };
}

export function retainToolResult(
  value,
  { expectedDigest, callId, outputType, context } = {},
) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const digest = sha256(bytes);
  if (expectedDigest !== undefined && expectedDigest !== digest) {
    throw new Error("Tool-result digest changed before retention.");
  }
  if (bytes.length > TOOL_RESULT_RETENTION_MAX_RESULT_BYTES) {
    throw retentionFailure(
      "capacity",
      "Tool result exceeds the owner-private retention bound.",
    );
  }

  const handle = retainedHandle(digest, bytes.length, callId, outputType, context);
  const target = retainedPath(handle);
  if (existsSync(target)) {
    try {
      cleanupPublishedStages(target);
      syncDirectory(TOOL_RESULT_RETENTION_DIR);
    } catch (error) {
      throw wrappedRetentionFailure(error);
    }
    try {
      const verified = readVerified(target, digest, bytes.length);
      if (!verified.equals(bytes)) throw new Error("Retained result read-back mismatch.");
      return { handle, digest, byteLength: bytes.length };
    } catch (error) {
      try {
        replaceTornPrivateFile(target, bytes);
        const repaired = readVerified(target, digest, bytes.length);
        if (!repaired.equals(bytes)) throw new Error("Retained result repair mismatch.");
        return { handle, digest, byteLength: bytes.length, repaired: true };
      } catch (repairError) {
        throw wrappedRetentionFailure(repairError, error);
      }
    }
  }

  let release;
  try {
    release = lockRetentionDirectory();
    // A concurrent request may have completed the deterministic store while
    // this request waited for the capacity lock.
    if (!existsSync(target)) {
      const usage = storageUsage();
      if (
        usage.files >= TOOL_RESULT_RETENTION_MAX_FILES ||
        usage.bytes + bytes.length > TOOL_RESULT_RETENTION_MAX_TOTAL_BYTES
      ) {
        // Never evict a result referenced by an existing receipt. Reaching the
        // bound leaves this new result exact in the routed request instead.
        throw retentionFailure("capacity", "Owner-private tool-result retention is full.");
      }
      writeExclusivePrivateFile(target, bytes);
    }
  } catch (error) {
    throw wrappedRetentionFailure(error);
  } finally {
    if (release) release();
  }
  try {
    syncDirectory(TOOL_RESULT_RETENTION_DIR);
    const verified = readVerified(target, digest, bytes.length);
    if (!verified.equals(bytes)) throw new Error("Retained result read-back mismatch.");
  } catch (error) {
    throw wrappedRetentionFailure(error);
  }
  return { handle, digest, byteLength: bytes.length };
}

export function retrieveToolResult(
  handle,
  digest,
  byteLength,
  callId,
  outputType,
  context,
) {
  if (!HANDLE_PATTERN.test(handle) || !DIGEST_PATTERN.test(digest)) {
    throw new Error("Retained tool-result retrieval failed.");
  }
  const expectedLength = Number(byteLength);
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
    throw new Error("Retained tool-result retrieval failed.");
  }
  try {
    cleanupPublishedStages(retainedPath(handle));
    if (handle !== retainedHandle(digest, expectedLength, callId, outputType, context)) {
      throw new Error("Retained-result capability mismatch.");
    }
    return readVerified(retainedPath(handle), digest, expectedLength);
  } catch (error) {
    throw new Error("Retained tool-result retrieval failed.", { cause: error });
  }
}

export function retrieveToolResultByDigest(
  digest,
  byteLength,
  callId,
  outputType,
  context,
) {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error("Retained tool-result retrieval failed.");
  }
  const expectedLength = Number(byteLength);
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
    throw new Error("Retained tool-result retrieval failed.");
  }
  return retrieveToolResult(
    retainedHandle(digest, expectedLength, callId, outputType, context),
    digest,
    expectedLength,
    callId,
    outputType,
    context,
  );
}

export function saveRetrievedToolResult(
  digest,
  byteLength,
  callId,
  outputType,
  context,
  destination,
) {
  if (typeof destination !== "string" || !path.isAbsolute(destination)) {
    throw new Error("Retained tool-result retrieval requires an absolute destination.");
  }
  ensurePrivateRetrievalDirectory();
  const resolved = path.resolve(destination);
  if (path.dirname(resolved) !== path.resolve(TOOL_RESULT_RETRIEVAL_DIR)) {
    throw new Error("Retained tool-result destination is outside owner-private retrieval state.");
  }
  const bytes = retrieveToolResultByDigest(
    digest,
    byteLength,
    callId,
    outputType,
    context,
  );
  let created = false;
  try {
    writeExclusivePrivateFile(resolved, bytes);
    created = true;
    const verified = readProtectedFile(resolved, bytes.length);
    if (!verified.equals(bytes) || sha256(verified) !== digest) {
      throw new Error("Retrieved tool-result read-back mismatch.");
    }
  } catch (error) {
    try {
      if (created && existsSync(resolved)) unlinkSync(resolved);
      syncDirectory(TOOL_RESULT_RETRIEVAL_DIR);
    } catch {}
    throw new Error("Retained tool-result save failed.", { cause: error });
  }
  return { ok: true, byteLength: bytes.length };
}
