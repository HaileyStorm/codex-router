import { spawn as nodeSpawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NOUS_PROVIDER_ATTEMPT_LOCK_NAME = "provider-attempt";
export const NOUS_PROVIDER_ATTEMPT_LOCK_ACQUIRED_LINE =
  "NOUS_PROVIDER_ATTEMPT_LOCK_ACQUIRED";
export const NOUS_PROVIDER_ATTEMPT_LOCK_DEFAULT_TIMEOUT_MS = 600_000;
export const NOUS_PROVIDER_ATTEMPT_LOCK_HELPER = fileURLToPath(
  new URL("./nous-provider-lock.py", import.meta.url),
);

const LOCK_RUNTIME_ENV = [
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "PATH",
  "PYTHONHOME",
  "PYTHONIOENCODING",
  "PYTHONPATH",
  "PYTHONUTF8",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
];
const MAX_PROTOCOL_BYTES = 16 * 1024;

function lockError(message, code = "nous_provider_lock") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error("Nous provider-attempt lock acquisition was aborted.", {
    cause: reason,
  });
  error.name = "AbortError";
  error.code = "nous_provider_lock_aborted";
  return error;
}

function timeoutMsValue(value) {
  const timeoutMs = value === undefined
    ? NOUS_PROVIDER_ATTEMPT_LOCK_DEFAULT_TIMEOUT_MS
    : Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw lockError("Nous provider-attempt lock timeout must be a positive finite number.");
  }
  return timeoutMs;
}

function cacheRootValue(value) {
  const configured = value === undefined
    ? process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
    : value;
  if (typeof configured !== "string" || !configured || !path.isAbsolute(configured)) {
    throw lockError("Nous provider-attempt lock cache root must be an absolute path.");
  }
  return path.normalize(configured);
}

function pythonCommandValue(value) {
  const configured = value ?? process.env.CODEX_ROUTER_NOUS_LOCK_PYTHON;
  if (configured !== undefined) {
    if (typeof configured !== "string" || !configured.trim()) {
      throw lockError("CODEX_ROUTER_NOUS_LOCK_PYTHON must name a Python executable.");
    }
    return configured;
  }
  return process.platform === "win32" ? "python" : "python3";
}

function childEnvironment(cacheRoot) {
  const env = {};
  for (const name of LOCK_RUNTIME_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // The helper must never inherit NOUS_API_KEY, router credentials, or any
  // unrelated application setting. XDG_CACHE_HOME is the only lock path
  // input, and Python's runtime gets only the small path/runtime allowlist.
  env.XDG_CACHE_HOME = cacheRoot;
  env.PYTHONUNBUFFERED = "1";
  return env;
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The close/error event reports the final state to the waiter.
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited between the state check and kill.
      }
    }
  }, 250);
  forceTimer.unref?.();
}

function runtimeFailure(error) {
  if (error?.code === "ENOENT") {
    return lockError(
      "Nous provider-attempt lock Python runtime is unavailable; install Python 3 or set CODEX_ROUTER_NOUS_LOCK_PYTHON.",
      "nous_provider_lock_runtime_missing",
    );
  }
  return lockError(
    "Nous provider-attempt lock helper could not start.",
    "nous_provider_lock_runtime_error",
  );
}

function helperFailure(stderr, code, signal) {
  const detail = String(stderr || "").toLowerCase();
  if (detail.includes("timed out") || code === 124) {
    return lockError(
      "Nous provider-attempt lock timed out while waiting for the shared provider lock.",
      "nous_provider_lock_timeout",
    );
  }
  const state = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
  return lockError(
    `Nous provider-attempt lock helper exited before acquisition (${state}).`,
    "nous_provider_lock_helper_failed",
  );
}

function unexpectedExit(code, signal) {
  const state = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
  return lockError(
    `Nous provider-attempt lock helper exited unexpectedly while held (${state}).`,
    "nous_provider_lock_lost",
  );
}

/**
 * Acquire the cross-process provider-attempt lock used by the MCP bridge.
 * The returned async function closes stdin and waits for the helper to exit,
 * which releases the OS lock. A caller signal cancels only acquisition; once
 * acquired, the helper remains alive until the caller invokes release().
 */
export function acquireNousProviderAttemptLock({
  signal,
  timeoutMs,
  cacheRoot,
  pythonCommand,
  helperPath = NOUS_PROVIDER_ATTEMPT_LOCK_HELPER,
  spawnImpl = nodeSpawn,
} = {}) {
  const timeout = timeoutMsValue(timeoutMs);
  const root = cacheRootValue(cacheRoot);
  const python = pythonCommandValue(pythonCommand);
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (typeof helperPath !== "string" || !helperPath) {
    return Promise.reject(lockError("Nous provider-attempt lock helper path is invalid."));
  }
  if (typeof spawnImpl !== "function") {
    return Promise.reject(lockError("Nous provider-attempt lock spawn implementation is invalid."));
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(python, [helperPath, "--timeout-seconds", String(timeout / 1000)], {
        cwd: path.dirname(helperPath),
        env: childEnvironment(root),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(runtimeFailure(error));
      return;
    }

    let acquired = false;
    let settled = false;
    let releaseRequested = false;
    let childClosed = false;
    let releasePromise;
    let stdout = "";
    let stderr = "";
    let timer;
    let abortListener;
    let lostError;
    let closeResolve;
    let closeReject;
    const closePromise = new Promise((resolveClose, rejectClose) => {
      closeResolve = resolveClose;
      closeReject = rejectClose;
    });

    const cleanupAcquisition = () => {
      if (timer) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    };

    const failAcquire = (error) => {
      if (settled) return;
      settled = true;
      cleanupAcquisition();
      terminate(child);
      reject(error);
    };

    const release = async () => {
      if (releasePromise) return releasePromise;
      releaseRequested = true;
      releasePromise = (async () => {
        if (childClosed) {
          if (lostError) throw lostError;
          return;
        }
        try {
          child.stdin.end();
        } catch (error) {
          throw lockError("Nous provider-attempt lock helper stdin could not close.", "nous_provider_lock_release_error");
        }
        await closePromise;
        if (lostError) throw lostError;
      })();
      return releasePromise;
    };

    const onStdout = (chunk) => {
      if (settled && !acquired) return;
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, "utf8") > MAX_PROTOCOL_BYTES) {
        failAcquire(lockError("Nous provider-attempt lock helper protocol exceeded its local limit.", "nous_provider_lock_protocol"));
        return;
      }
      let newline;
      while ((newline = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newline).replace(/\r$/u, "");
        stdout = stdout.slice(newline + 1);
        if (!acquired && line === NOUS_PROVIDER_ATTEMPT_LOCK_ACQUIRED_LINE) {
          acquired = true;
          settled = true;
          cleanupAcquisition();
          resolve(release);
          continue;
        }
        if (!acquired && line) {
          failAcquire(lockError("Nous provider-attempt lock helper returned an invalid acquisition line.", "nous_provider_lock_protocol"));
          return;
        }
      }
    };

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr, "utf8") > MAX_PROTOCOL_BYTES) {
        stderr = stderr.slice(-MAX_PROTOCOL_BYTES);
      }
    });
    child.once("error", (error) => {
      if (!acquired) failAcquire(runtimeFailure(error));
      else if (!childClosed) lostError = runtimeFailure(error);
    });
    child.once("close", (code, signalName) => {
      childClosed = true;
      if (!acquired) {
        failAcquire(helperFailure(stderr, code, signalName));
        return;
      }
      if (!releaseRequested || code !== 0 || signalName) {
        lostError = unexpectedExit(code, signalName);
      }
      closeResolve();
    });

    abortListener = () => {
      if (!acquired) failAcquire(abortError(signal));
    };
    if (signal) signal.addEventListener("abort", abortListener, { once: true });
    timer = setTimeout(() => {
      if (!acquired) {
        failAcquire(lockError(
          `Nous provider-attempt lock timed out after ${Math.round(timeout)} ms.`,
          "nous_provider_lock_timeout",
        ));
      }
    }, timeout + 1_000);
    timer.unref?.();
  });
}

/** Run one operation while holding the shared provider-attempt lock. */
export async function withNousProviderAttemptLock(callback, options = {}) {
  if (typeof callback !== "function") {
    throw lockError("Nous provider-attempt lock callback must be a function.");
  }
  const release = await acquireNousProviderAttemptLock(options);
  let result;
  let callbackError;
  try {
    result = await callback();
  } catch (error) {
    callbackError = error;
  }
  try {
    await release();
  } catch (releaseError) {
    if (!callbackError) throw releaseError;
  }
  if (callbackError) throw callbackError;
  return result;
}
