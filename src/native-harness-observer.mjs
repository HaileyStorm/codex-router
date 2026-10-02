// Optional, metadata-only observation of the request already selected by Codex.
// This module never changes a model, effort, prompt, header, or provider route.
import { readFileSync, readdirSync } from "node:fs";
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

export function readObserverConfig(filename = path.join(CODEX_HOME, "harness-native-observer.json")) {
  try {
    const raw = readFileSync(filename);
    if (raw.length > 8192) return undefined;
    const value = JSON.parse(raw);
    if (value.schema_version !== 1 || value.enabled !== true ||
        ![value.python, value.client, value.state_directory].every((item) => typeof item === "string" && path.isAbsolute(item)) ||
        !SHA.test(value.python_sha256) || !SHA.test(value.client_sha256)) return undefined;
    // Missing runtime instances mean no subprocess and no inference overhead.
    if (!readdirSync(value.state_directory).some((name) => /^endpoint-[a-zA-Z0-9-]+\.json$/.test(name))) return undefined;
    if (digest(readFileSync(value.python)) !== value.python_sha256 ||
        digest(readFileSync(value.client)) !== value.client_sha256) return undefined;
    return value;
  } catch { return undefined; }
}

export function invokeObserver(config, operation, packet, launch = spawn) {
  return new Promise((resolve) => {
    let child;
    let size = 0;
    let output = "";
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    // The helper handles DPAPI in-process. Neither capability nor source text is
    // an argument, an environment change, or part of this metadata packet.
    const timer = setTimeout(() => {
      child?.kill(); // Only the helper process created by this invocation.
      finish({ status: "observerTimeout" });
    }, 2500);
    try {
      child = launch(config.python, ["-I", config.client, operation, config.state_directory],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, cwd: path.dirname(config.client) });
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8192) { child.kill(); finish({ status: "observerOutputLimit" }); return; }
        output += chunk.toString("utf8");
      });
      child.on("error", () => finish({ status: "observerUnavailable" }));
      child.stdin.on("error", () => finish({ status: "observerUnavailable" }));
      child.on("close", (code) => {
        if (code !== 0) { finish({ status: "observerUnavailable" }); return; }
        try {
          const result = JSON.parse(output);
          finish({ status: typeof result.status === "string" ? result.status : "unverified" });
        } catch { finish({ status: "observerUnavailable" }); }
      });
      child.stdin.end(JSON.stringify(packet));
    } catch { finish({ status: "observerUnavailable" }); }
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
