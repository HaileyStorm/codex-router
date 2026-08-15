import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { toolResultAgingTotals } from "./usage-events.mjs";

export const TOOL_RESULT_AGING_STATE_PATH =
  process.env.MODEL_ROUTER_TOOL_RESULT_AGING_STATE ||
  path.join(STATE_DIR, "tool-result-aging.json");

// Routed external models default on; native OpenAI traffic remains separately
// off. An absent file means nobody has answered and receives the current
// routed default. A stored value is the operator's explicit answer and is kept
// verbatim, so a saved off choice is never re-defaulted by a later release.
function defaultSettings() {
  return { version: 1, enabled: true, nativeEnabled: false, defaulted: true };
}

function disabledSettings() {
  return { version: 1, enabled: false, nativeEnabled: false };
}

export function readToolResultAgingSettings() {
  if (!existsSync(TOOL_RESULT_AGING_STATE_PATH)) return defaultSettings();
  try {
    const parsed = JSON.parse(readFileSync(TOOL_RESULT_AGING_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && typeof parsed.enabled === "boolean") {
      return {
        version: 1,
        enabled: parsed.enabled,
        // Absent on files written before the native flag existed; absence is
        // the off default, never an error.
        nativeEnabled: parsed.nativeEnabled === true,
      };
    }
  } catch {
    // A malformed explicit choice must not silently change routed context.
  }
  return disabledSettings();
}

function writeSettings(settings) {
  writePrivateJson(TOOL_RESULT_AGING_STATE_PATH, settings, { directoryMode: 0o700 });
  return settings;
}

export function setToolResultAgingEnabled(enabled) {
  const current = readToolResultAgingSettings();
  return writeSettings({
    version: 1,
    enabled: enabled === true,
    nativeEnabled: current.nativeEnabled === true,
  });
}

export function setNativeToolResultAgingEnabled(enabled) {
  const current = readToolResultAgingSettings();
  return writeSettings({
    version: 1,
    enabled: current.enabled === true,
    nativeEnabled: enabled === true,
  });
}

export function toolResultAgingEnabled() {
  if (process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0") return false;
  return readToolResultAgingSettings().enabled;
}

// The environment kill switch silences both paths: it exists to stop the
// router rewriting request context at all, not one flavor of it.
export function nativeToolResultAgingEnabled() {
  if (process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0") return false;
  return readToolResultAgingSettings().nativeEnabled === true;
}

export function toolResultAgingSnapshot() {
  const settings = readToolResultAgingSettings();
  const environmentOverride = process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0";
  return {
    ...settings,
    enabled: environmentOverride ? false : settings.enabled,
    nativeEnabled: environmentOverride ? false : settings.nativeEnabled,
    configured: existsSync(TOOL_RESULT_AGING_STATE_PATH),
    environmentOverride,
    // Cumulative savings derived from recorded usage events, so every status
    // surface (CLI, desktop, tray) can show what the feature actually bought.
    stats: toolResultAgingTotals(),
  };
}
