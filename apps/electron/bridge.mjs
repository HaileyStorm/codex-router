// Every backend call the companion makes is one shell-out to the router's own
// control CLI, exactly as the Tauri app's Rust side does it. Keeping the two
// bridges argument-for-argument identical is what lets both shells drive the
// same UI without a second copy of the behaviour.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const CONTROL_TIMEOUT_MS = 120_000;

export function sourceRoot(env = process.env, here = process.cwd()) {
  if (env.MODEL_ROUTER_SOURCE_ROOT) return env.MODEL_ROUTER_SOURCE_ROOT;
  // apps/electron -> repository root
  const guess = path.resolve(here, "..", "..");
  return existsSync(path.join(guess, "src", "control.mjs")) ? guess : undefined;
}

// A command that mutates and then re-reads: the UI always wants the fresh
// snapshot, so the read is part of the call rather than a second round trip
// the renderer has to remember to make.
export const COMMANDS = {
  control_snapshot: () => ({ args: ["--json"] }),
  account_usage: () => ({ args: ["account", "--json"] }),
  provider_usage: () => ({ args: ["provider-usage", "--json"] }),
  provider_setup: () => ({ args: ["providers", "--json"] }),
  local_models: () => ({ args: ["local-models", "list", "--json"] }),
  install_local_model: ({ tag }) => ({
    args: ["local-models", "install", requireTag(tag), "--yes", "--force"],
  }),
  uninstall_local_model: ({ tag }) => ({
    args: ["local-models", "uninstall", requireTag(tag), "--yes"],
  }),
  set_local_model_enabled: ({ tag, enabled }) => ({
    args: ["local-models", "set", requireTag(tag), enabled ? "on" : "off"],
  }),
  install_provider_cli: ({ provider }) => ({ args: ["install-cli", requireProvider(provider)] }),
  connect_oauth: ({ provider }) => ({
    args: ["login", requireProvider(provider)],
    then: ["providers", "--json"],
  }),
  save_api_key: ({ provider, apiKey }) => {
    if (!String(apiKey ?? "").trim()) throw new Error("Enter a credential first.");
    if (String(apiKey).length > 16 * 1024) throw new Error("The credential is too large.");
    return {
      args: ["credential", requireProvider(provider)],
      stdin: String(apiKey),
      select: [["set", requireProvider(provider), "on", "--targets", "codex"]],
      then: ["providers", "--json"],
    };
  },
  remove_api_key: ({ provider }) => ({
    args: ["credential", requireProvider(provider), "--remove"],
    then: ["providers", "--json"],
  }),
  set_provider_enabled: ({ provider, enabled }) => ({
    args: ["set", requireProvider(provider), enabled ? "on" : "off", "--targets", "codex"],
    then: ["--json"],
  }),
  set_login_free: ({ enabled }) => ({
    args: ["auth-mode", enabled ? "on" : "off"],
    then: ["--json"],
  }),
  set_subagent_mode: ({ mode }) => ({ args: ["subagents", "mode", String(mode)] }),
  set_subagent_model: ({ slug, enabled }) => ({
    args: ["subagents", "set", String(slug), enabled ? "on" : "off"],
  }),
  set_subagent_provider: ({ provider, enabled }) => ({
    args: ["subagents", "provider", requireProvider(provider), enabled ? "on" : "off"],
  }),
  set_subagent_selection: ({ selection }) => ({ args: ["subagents", String(selection)] }),
  set_picker_model: ({ slug, visible }) => ({
    args: ["picker", "set", String(slug), visible ? "show" : "hide"],
  }),
  set_picker_provider: ({ provider, visible }) => ({
    args: ["picker", "provider", requireProvider(provider), visible ? "show" : "hide"],
  }),
  set_picker_models: ({ showAll }) => ({ args: ["picker", "all", showAll ? "show" : "hide"] }),
  set_tool_result_aging: ({ mode }) => ({ args: ["tool-result-aging", String(mode)] }),
};

function requireProvider(provider) {
  const value = String(provider ?? "");
  // The renderer is local, but an id reaches a command line either way, so it
  // is constrained to the shape a provider id actually has.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error(`Unknown provider: ${provider}`);
  return value;
}

function requireTag(tag) {
  const value = String(tag ?? "");
  if (!/^[A-Za-z0-9][\w.:\/-]{0,127}$/.test(value)) throw new Error(`Unknown model tag: ${tag}`);
  return value;
}

// process.execPath is the Electron binary inside the main process, not Node,
// so using it launches a second Electron to run a Node script -- which fails
// with a sandbox error rather than anything that names the real cause. Prefer
// the system Node the router is tested against; fall back to Electron's own
// bundled Node, which is what ELECTRON_RUN_AS_NODE selects.
export function nodeRuntime({ env = process.env, execPath = process.execPath } = {}) {
  const onPath = which("node", env);
  if (onPath) return { command: onPath, env };
  if (process.versions.electron) {
    return { command: execPath, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { command: execPath, env };
}

function which(name, env) {
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of String(env.PATH || "").split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function runControl(root, args, { stdin, runtime = nodeRuntime() } = {}) {
  return new Promise((resolve, reject) => {
    if (!root) {
      reject(new Error("Model Router was not found. Set MODEL_ROUTER_SOURCE_ROOT."));
      return;
    }
    const child = execFile(
      runtime.command,
      [path.join(root, "src", "control.mjs"), ...args],
      {
        cwd: root,
        env: runtime.env,
        timeout: CONTROL_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message).trim() || "The router command failed."));
          return;
        }
        resolve(stdout);
      },
    );
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
  });
}

export function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("Model Router returned an unreadable response.");
  }
}
