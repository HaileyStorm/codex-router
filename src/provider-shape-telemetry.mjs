import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const PROVIDER_SHAPE_EVENTS_PATH = path.join(
  STATE_DIR,
  "provider-shape-events.jsonl",
);
export const PROVIDER_SHAPE_KEY_PATH = path.join(
  STATE_DIR,
  "provider-shape-telemetry.key",
);

const MAX_EVENTS_BYTES = 4 * 1024 * 1024;
const MAX_COUNT = 999;
const ALLOWED_OUTPUT_ITEM_TYPES = new Set([
  "function_call",
  "message",
  "reasoning",
  "web_search_call",
  "x_search_call",
  "computer_call",
  "image_generation_call",
]);
const ALLOWED_TERMINALS = new Set([
  "completed",
  "incomplete",
  "auth_error",
  "client_aborted",
  "connect_error",
  "upstream_error",
  "stream_error",
]);

let telemetryStatus = {
  enabled: process.env.MODEL_ROUTER_GROK_SHAPE_TELEMETRY !== "0",
  healthy: true,
};

function noteTelemetryStatus(healthy, reason) {
  telemetryStatus = {
    ...telemetryStatus,
    healthy,
    ...(reason ? { reason } : {}),
  };
  if (!reason) delete telemetryStatus.reason;
}

export function providerShapeTelemetryStatus() {
  return { ...telemetryStatus };
}

function safeText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 120);
}

function canonicalToolName(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "unknown";
  const type = safeText(tool.type, "unknown");
  if (type === "function") return `function:${safeText(tool.name, "missing")}`;
  return `type:${type}`;
}

export function providerToolShape(tools, key) {
  const names = (Array.isArray(tools) ? tools : [])
    .map(canonicalToolName)
    .sort();
  const hmacKey = Buffer.isBuffer(key) ? key : Buffer.from(String(key ?? ""), "utf8");
  if (!hmacKey.length) throw new Error("provider-shape telemetry key is required");
  return {
    toolCount: names.length,
    toolNameDigest: createHmac("sha256", hmacKey)
      .update(names.join("\0"), "utf8")
      .digest("hex"),
  };
}

function ensureTelemetryKey(keyPath = PROVIDER_SHAPE_KEY_PATH) {
  mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  if (!existsSync(keyPath)) {
    try {
      // Apply the exact Windows owner ACL before private bytes enter the file.
      writeFileSync(keyPath, "", { flag: "wx", mode: 0o600 });
      protectPrivateFile(keyPath);
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  protectPrivateFile(keyPath);
  const key = readFileSync(keyPath);
  if (key.length < 32) throw new Error("provider-shape telemetry key is invalid");
  return key;
}

function boundedIncrement(object, key) {
  object[key] = Math.min(MAX_COUNT, (object[key] || 0) + 1);
}

export class ProviderShapeTelemetry {
  #record;
  #seenOutputItemIds = new Set();
  #finished = false;

  constructor({ provider, model, tools, key, requestId = randomUUID(), at = Date.now() }) {
    const shape = providerToolShape(tools, key);
    this.#record = {
      schemaVersion: 1,
      startedAt: new Date(at).toISOString(),
      requestId: safeText(requestId, randomUUID()),
      provider: safeText(provider, "unknown"),
      model: safeText(model, "unknown"),
      upstreamAttempts: 0,
      ...shape,
      responseOutputItemTypeCounts: {},
      parserErrors: 0,
      responseCompleted: false,
    };
  }

  noteAttempt() {
    this.#record.upstreamAttempts = Math.min(
      MAX_COUNT,
      this.#record.upstreamAttempts + 1,
    );
  }

  noteParserError() {
    this.#record.parserErrors = Math.min(MAX_COUNT, this.#record.parserErrors + 1);
  }

  noteEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    if (event.type === "response.completed") this.#record.responseCompleted = true;
    if (
      event.type !== "response.output_item.added" &&
      event.type !== "response.output_item.done"
    ) {
      return;
    }
    const item = event.item;
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const rawType = typeof item.type === "string" ? item.type : "unknown";
    const type = ALLOWED_OUTPUT_ITEM_TYPES.has(rawType) ? rawType : "unknown";
    const identities = [item.id, item.call_id].filter(
      (value) => typeof value === "string" && value,
    );
    if (Number.isInteger(event.output_index) && event.output_index >= 0) {
      identities.push(`output_index:${event.output_index}`);
    }
    if (identities.some((identity) => this.#seenOutputItemIds.has(identity))) return;
    if (!identities.length && event.type !== "response.output_item.done") return;
    if (!identities.length) identities.push(`${type}:done:${this.#seenOutputItemIds.size}`);
    for (const identity of identities) this.#seenOutputItemIds.add(identity);
    boundedIncrement(this.#record.responseOutputItemTypeCounts, type);
  }

  finish({ status, terminal } = {}) {
    if (this.#finished) return undefined;
    this.#finished = true;
    const normalizedTerminal = ALLOWED_TERMINALS.has(terminal)
      ? terminal
      : this.#record.responseCompleted
        ? "completed"
        : "incomplete";
    const finishedAt = Date.now();
    return {
      ...this.#record,
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: Math.max(0, finishedAt - Date.parse(this.#record.startedAt)),
      status: Number.isInteger(status) ? status : 0,
      terminal: normalizedTerminal,
      responseOutputItemTypeCounts: Object.fromEntries(
        Object.entries(this.#record.responseOutputItemTypeCounts).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    };
  }
}

export function createProviderShapeTelemetry(options = {}) {
  const enabled = options.enabled ?? telemetryStatus.enabled;
  if (!enabled) {
    telemetryStatus = { enabled: false, healthy: true, reason: "disabled" };
    return undefined;
  }
  try {
    const telemetry = new ProviderShapeTelemetry({
      ...options,
      key: options.key ?? ensureTelemetryKey(options.keyPath),
    });
    return telemetry;
  } catch {
    noteTelemetryStatus(false, "key");
    return undefined;
  }
}

export function appendProviderShapeEvent(
  event,
  { eventsPath = PROVIDER_SHAPE_EVENTS_PATH } = {},
) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  try {
    mkdirSync(path.dirname(eventsPath), { recursive: true, mode: 0o700 });
    if (existsSync(eventsPath) && statSync(eventsPath).size >= MAX_EVENTS_BYTES) {
      noteTelemetryStatus(false, "capacity");
      return false;
    }
    if (!existsSync(eventsPath)) {
      try {
        writeFileSync(eventsPath, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    // On Windows, inherited ACLs are removed before the private record append.
    protectPrivateFile(eventsPath);
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    protectPrivateFile(eventsPath);
    noteTelemetryStatus(true);
    return true;
  } catch {
    noteTelemetryStatus(false, "storage");
    return false;
  }
}
