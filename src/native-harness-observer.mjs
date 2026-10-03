// Optional, metadata-only observation of the request already selected by Codex.
// This module never changes a model, effort, prompt, header, or provider route.
import { readFileSync, readdirSync, openSync, closeSync, fstatSync, realpathSync, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { CODEX_HOME } from "./paths.mjs";
import { nativeProfile, isNativeProfileNamespace } from "./native-profiles.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function oneHeader(request, name) {
  if (Array.isArray(request?.rawHeaders)) {
    const values = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === name) values.push(request.rawHeaders[index + 1]);
    }
    return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
  }
  const value = request?.headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function exactUuid(values) {
  const present = values.filter((value) => value !== undefined && value !== null);
  if (!present.length || present.some((value) => typeof value !== "string" || !UUID.test(value))) return undefined;
  const distinct = new Set(present.map((value) => value.toLowerCase()));
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

export function nativeObservation(request, payload, receivedAt, requestId = randomUUID(), requestedModel) {
  if (Array.isArray(request?.rawHeaders)) {
    const names = request.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => String(name).toLowerCase());
    if (["x-codex-turn-metadata", "thread-id", "session-id", "session_id"].some((name) =>
      names.filter((item) => item === name).length > 1)) return undefined;
  }
  let header = {};
  try {
    const raw = oneHeader(request, "x-codex-turn-metadata");
    if (raw) {
      if (raw.length > 32768) return undefined;
      header = JSON.parse(raw);
    }
  } catch { return undefined; }
  const client = payload?.client_metadata;
  const threadId = exactUuid([header?.turn?.thread_id, client?.thread_id, client?.turn?.thread_id,
    oneHeader(request, "thread-id"), oneHeader(request, "session-id"), oneHeader(request, "session_id")]);
  // root_turn_id is deliberately excluded, even when no actual turn ID exists.
  const turnId = exactUuid([header?.turn?.turn_id, client?.turn_id, client?.turn?.turn_id]);
  const wireModel = payload?.model;
  const model = requestedModel === undefined ? wireModel : requestedModel;
  const effort = payload?.reasoning?.effort;
  if (!threadId || !turnId || typeof model !== "string" || model.length > 128 ||
      typeof wireModel !== "string" || wireModel.length > 128 ||
      typeof effort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort) ||
      !/^\d{1,22}$/.test(String(receivedAt))) return undefined;
  // The relay binds the exact model selected by the app. A router-owned profile
  // is eligible only when its forward mapping matches the actual wire model;
  // never infer a profile from a canonical model shared by several selections.
  const profile = nativeProfile(model);
  if (profile ? wireModel !== profile.nativeModel : isNativeProfileNamespace(model) || model !== wireModel) return undefined;
  return { thread_id: threadId, turn_id: turnId, model, wire_model: wireModel, effort, request_id: requestId,
    observed_at_monotonic_ns: String(receivedAt) };
}

const verifiedObservers = new WeakMap();
const MAX_CLIENT_BYTES = 512 * 1024;
const LINUX_BOOTSTRAP = [
  "import base64,hashlib,io,json,sys",
  "v=json.load(sys.stdin)",
  "source=base64.b64decode(v['source'],validate=True)",
  "assert hashlib.sha256(source).hexdigest()==v['sha256']",
  "filename,operation,state=sys.argv[1:]",
  "sys.argv=[filename,operation,state]",
  "sys.stdin=io.StringIO(json.dumps(v['packet']))",
  "exec(compile(source,filename,'exec'),{'__name__':'__main__','__file__':filename})",
].join("; ");

// Walk from an open root, binding every component without following symlinks.
// A root-owned sticky temporary parent is allowed, but never the private leaf.
function trustedOpen(filename, directory = false) {
  const parts = filename.split("/").filter(Boolean);
  if (!path.isAbsolute(filename) || parts.some((part) => part === "." || part === "..")) throw new Error("unsafe path");
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (let index = 0; index < parts.length; index++) {
      const isDirectory = index < parts.length - 1 || directory;
      const next = openSync(`/proc/self/fd/${fd}/${parts[index]}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | (isDirectory ? constants.O_DIRECTORY : constants.O_NONBLOCK));
      closeSync(fd); fd = next;
      const info = fstatSync(fd);
      if (![0, process.getuid()].includes(info.uid)) throw new Error("foreign owner");
      const stickyParent = isDirectory && index < parts.length - 1 && info.uid === 0 && (info.mode & 0o1000);
      if ((info.mode & 0o022) && !stickyParent) throw new Error("foreign writable path");
      if (isDirectory ? !info.isDirectory() : !info.isFile()) throw new Error("wrong path type");
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function trustedRead(filename, limit, { privateFile = false } = {}) {
  const fd = trustedOpen(filename);
  try {
    const info = fstatSync(fd);
    if (info.nlink !== 1 || info.size > limit || (privateFile &&
      (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600))) throw new Error("unsafe file");
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new Error("file limit");
    return bytes;
  } finally { closeSync(fd); }
}

function linuxRuntimeExists(directory) {
  const fd = trustedOpen(directory, true);
  try {
    const info = fstatSync(fd);
    if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) return false;
    return readdirSync(`/proc/self/fd/${fd}`).some((name) => {
      if (!/^endpoint-[a-zA-Z0-9-]+\.json$/.test(name)) return false;
      let endpoint;
      try {
        endpoint = openSync(`/proc/self/fd/${fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const entry = fstatSync(endpoint);
        return entry.isFile() && entry.uid === process.getuid() && entry.nlink === 1 &&
          (entry.mode & 0o777) === 0o600;
      } catch { return false; } finally { if (endpoint !== undefined) closeSync(endpoint); }
    });
  } finally { closeSync(fd); }
}

export function readObserverConfig(filename = path.join(CODEX_HOME, "harness-native-observer.json")) {
  try {
    const linux = process.platform === "linux";
    const raw = linux ? trustedRead(filename, 8192, { privateFile: true }) : readFileSync(filename);
    if (raw.length > 8192) return undefined;
    const value = JSON.parse(raw);
    if (value.schema_version !== 1 || value.enabled !== true ||
        ![value.python, value.client, value.state_directory].every((item) => typeof item === "string" && path.isAbsolute(item)) ||
        !SHA.test(value.python_sha256) || !SHA.test(value.client_sha256)) return undefined;
    if (linux ? !linuxRuntimeExists(value.state_directory) :
      !readdirSync(value.state_directory).some((name) => /^endpoint-[a-zA-Z0-9-]+\.json$/.test(name))) return undefined;
    const python = linux ? trustedRead(realpathSync(value.python), 32 * 1024 * 1024) : readFileSync(value.python);
    const source = linux ? trustedRead(value.client, MAX_CLIENT_BYTES) : readFileSync(value.client);
    if (digest(python) !== value.python_sha256 || digest(source) !== value.client_sha256) return undefined;
    Object.freeze(value);
    verifiedObservers.set(value, { source });
    return value;
  } catch { return undefined; }
}

export function invokeObserver(config, operation, packet, launch = spawn) {
  return new Promise((resolve) => {
    let child, interpreter;
    let size = 0, output = "", settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => {
      child?.kill(); // Only the helper process created by this invocation.
      finish({ status: "observerTimeout" });
    }, 2500);
    try {
      if (!["capture-auto", "completion-auto"].includes(operation)) throw new Error("invalid operation");
      let command = config.python, args = ["-I", config.client, operation, config.state_directory];
      let input = JSON.stringify(packet);
      const options = { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, cwd: path.dirname(config.client),
        // Credentials, proxies, Python loaders and inherited NODE_OPTIONS are excluded.
        env: process.platform === "linux" ? { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } : undefined };
      if (process.platform === "linux") {
        const verified = verifiedObservers.get(config);
        if (!verified || !linuxRuntimeExists(config.state_directory)) throw new Error("unverified observer");
        interpreter = trustedOpen(realpathSync(config.python));
        const info = fstatSync(interpreter);
        if (!(info.mode & 0o111) || info.size > 32 * 1024 * 1024 || digest(readFileSync(interpreter)) !== config.python_sha256) throw new Error("changed interpreter");
        // The executable fd stays pinned across exec; Python compiles the exact
        // source bytes already verified, never reopens the mutable client path.
        command = "/proc/self/fd/3";
        options.stdio.push(interpreter);
        args = ["-I", "-B", "-c", LINUX_BOOTSTRAP, config.client, operation, config.state_directory];
        input = JSON.stringify({ source: verified.source.toString("base64"), sha256: config.client_sha256, packet });
      }
      child = launch(command, args, options);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8192) { child.kill(); finish({ status: "observerOutputLimit" }); return; }
        output += chunk.toString("utf8");
      });
      child.on("error", () => finish({ status: "observerUnavailable" }));
      child.stdin.on("error", () => finish({ status: "observerUnavailable" }));
      child.on("close", (code) => {
        if (code !== 0) { finish({ status: "observerUnavailable" }); return; }
        try { const result = JSON.parse(output);
          finish({ status: typeof result.status === "string" && /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(result.status)
            ? result.status : "unverified" });
        } catch { finish({ status: "observerUnavailable" }); }
      });
      child.stdin.end(input);
    } catch { finish({ status: "observerUnavailable" }); }
    finally { if (interpreter !== undefined) closeSync(interpreter); }
  });
}

export async function captureNativeRequest(request, payload, receivedAt, options = {}) {
  const config = options.config ?? readObserverConfig();
  if (!config) return undefined;
  const packet = nativeObservation(request, payload, receivedAt, undefined, options.requestedModel);
  if (!packet) return undefined;
  const invoke = options.invoke ?? invokeObserver;
  const result = await invoke(config, "capture-auto", packet);
  return { config, packet, status: result.status };
}

export async function completeNativeRequest(observation, usage, options = {}) {
  if (!observation || !usage) return;
  const counters = {};
  for (const [from, to] of [["inputTokens", "input_tokens"], ["outputTokens", "output_tokens"],
    ["cachedInputTokens", "cached_input_tokens"], ["cacheWriteInputTokens", "cache_write_input_tokens"]]) {
    if (Number.isSafeInteger(usage[from]) && usage[from] >= 0) counters[to] = usage[from];
  }
  if (!Object.keys(counters).length) return;
  await (options.invoke ?? invokeObserver)(observation.config, "completion-auto", { ...observation.packet, usage: counters });
}
