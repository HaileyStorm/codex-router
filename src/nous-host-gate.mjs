import { spawn as nodeSpawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * The canonical installed bridge owns provider_attempt_lock, stop-marker
 * checks, and the provider lease. This module only supervises its narrow
 * stdin/stdout lease protocol around a caller-supplied fetch implementation.
 *
 * Protocol (one child per provider attempt):
 *   stdout: one schema-bound ready object with provider/model/lock metadata
 *   stdin:  {"status":200}\n (or {"status":null}\n on an incomplete attempt)
 *   stdout: one schema-bound released object with the matching status
 * A valid HTTP 402 header is completed as 402 immediately after best-effort
 * body cancellation, so a stalled or oversized provider error cannot suppress
 * the bridge's persistent stop marker. The caller receives a sanitized 402.
 *
 * No key or request body is read by this module. The response body is bounded
 * only to prove completion; response bytes, child diagnostics, and original
 * errors are never logged or attached. The installed launcher/bridge remains
 * responsible for credential handling and provider state.
 */

export const NOUS_HOST_GATE_PROTOCOL = "codex-nous-provider-lease-v1";
export const NOUS_HOST_GATE_READY_EVENT = "ready";
export const NOUS_HOST_GATE_RELEASED_EVENT = "released";
export const NOUS_HOST_GATE_COMPLETION_MAX_BYTES = 128;
export const NOUS_HOST_GATE_MAX_PROTOCOL_BYTES = 16 * 1024;
export const NOUS_HOST_GATE_MAX_STDERR_BYTES = 16 * 1024;
export const NOUS_HOST_GATE_MAX_RESPONSE_BYTES = 4_000_000;
export const NOUS_HOST_GATE_DEFAULT_TIMEOUT_MS = 360_000;
export const NOUS_HOST_GATE_MAX_TIMEOUT_MS = 360_000;
export const NOUS_HOST_GATE_WINDOWS_SWITCH = "-ProviderLease";
export const NOUS_HOST_GATE_WINDOWS_TIMEOUT_SWITCH = "-ProviderLeaseTimeout";
export const NOUS_HOST_GATE_UNIX_ARGUMENT = "--provider-lease";
export const NOUS_HOST_GATE_UNIX_TIMEOUT_ARGUMENT = "--provider-lease-timeout";
export const NOUS_HOST_GATE_PROVIDER = "nous";
export const NOUS_HOST_GATE_MODEL = "deepseek/deepseek-v4.1-flash";
export const NOUS_HOST_GATE_LOCK_NAME = "provider-attempt";
export const NOUS_HOST_GATE_MAX_LOCK_PATH_BYTES = 4_096;
export const NOUS_HOST_GATE_PROVIDER_STOP_STATUS = 402;

const ERROR_MESSAGES = Object.freeze({
  nous_host_gate_spawn_failed: "The Nous provider lease could not be started.",
  nous_host_gate_protocol_failed: "The Nous provider lease protocol failed closed.",
  nous_host_gate_timeout: "The Nous provider lease timed out.",
  nous_host_gate_reconcile_required: "The Nous provider lease requires reconciliation; no resend is authorized.",
  nous_host_gate_fetch_failed: "The Nous provider request failed under the host gate.",
  nous_host_gate_aborted: "The Nous provider request was aborted under the host gate.",
  nous_host_gate_response_invalid: "The Nous provider returned an invalid response under the host gate.",
  nous_host_gate_response_limit: "The Nous provider response exceeded the host gate limit.",
  nous_host_gate_completion_failed: "The Nous provider lease completion could not be delivered.",
  nous_host_gate_unsupported_platform: "The Nous provider lease is unsupported on this host.",
});

export class NousHostGateError extends Error {
  constructor(code = "nous_host_gate_reconcile_required") {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.nous_host_gate_reconcile_required);
    this.name = "NousHostGateError";
    this.code = code;
    this.reconcile = true;
    this.reconcileRequired = true;
    this.resend = false;
    this.noResend = true;
    this.retryable = false;
  }
}

function gateError(code) {
  return code instanceof NousHostGateError ? code : new NousHostGateError(code);
}

function freezeCommand(command, args, options) {
  return Object.freeze({
    command,
    args: Object.freeze([...args]),
    options: Object.freeze({ ...options }),
  });
}

function osKnownHomeDirectory() {
  try {
    return os.userInfo().homedir;
  } catch {
    return undefined;
  }
}

function absoluteHome(homeDirectory, platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (typeof homeDirectory !== "string" || !homeDirectory || !pathApi.isAbsolute(homeDirectory)) {
    throw gateError("nous_host_gate_spawn_failed");
  }
  return pathApi.normalize(homeDirectory);
}

function normalizeLeaseTimeout(value) {
  const numeric = value;
  if (
    typeof value !== "number" ||
    !Number.isFinite(numeric) ||
    numeric <= 0 ||
    numeric > NOUS_HOST_GATE_MAX_TIMEOUT_MS / 1_000
  ) {
    throw gateError("nous_host_gate_timeout");
  }
  return numeric;
}

/**
 * Build the only production command shape accepted by this module. The
 * homeDirectory and platform arguments are exposed for deterministic
 * command-shape tests; createNousHostGateFetch always uses the OS values.
 */
export function buildDefaultNousHostGateCommand({
  platform = process.platform,
  homeDirectory = osKnownHomeDirectory(),
  systemRoot = process.env.SystemRoot,
  leaseTimeoutSeconds = NOUS_HOST_GATE_DEFAULT_TIMEOUT_MS / 1_000,
} = {}) {
  const timeoutSeconds = normalizeLeaseTimeout(leaseTimeoutSeconds);
  const timeoutText = String(timeoutSeconds);
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const home = absoluteHome(homeDirectory, platform);
  if (platform === "win32") {
    const launcher = pathApi.join(home, ".codex", "tools", "launch-bridge.ps1");
    if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
      throw gateError("nous_host_gate_spawn_failed");
    }
    const powershellRoot = path.win32.normalize(systemRoot);
    const powershell = pathApi.join(
      powershellRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    return freezeCommand(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcher,
        NOUS_HOST_GATE_WINDOWS_SWITCH,
        NOUS_HOST_GATE_WINDOWS_TIMEOUT_SWITCH,
        timeoutText,
      ],
      { shell: false, windowsHide: true },
    );
  }
  if (platform === "linux" || platform === "darwin") {
    const bridge = pathApi.join(home, ".codex", "tools", "nous_codex_bridge.py");
    return freezeCommand(bridge, [
      NOUS_HOST_GATE_UNIX_ARGUMENT,
      NOUS_HOST_GATE_UNIX_TIMEOUT_ARGUMENT,
      timeoutText,
    ], {
      shell: false,
      windowsHide: true,
    });
  }
  throw gateError("nous_host_gate_unsupported_platform");
}

export function buildNousHostGateSpawnOptions({
  platform = process.platform,
  inheritedEnvironment = process.env,
} = {}) {
  const options = {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  };
  if (platform !== "win32") {
    const environment = { ...inheritedEnvironment };
    delete environment.NOUS_API_KEY;
    options.env = Object.freeze(environment);
  }
  return Object.freeze(options);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A failed phase can happen before its corresponding wait is reached.
  // Keep that internal rejection handled while preserving it for its waiter.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function bytesFromChunk(chunk) {
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return undefined;
}

function hasExactlyKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function validLockProof(lock) {
  return (
    hasExactlyKeys(lock, ["name", "path", "device", "inode"]) &&
    lock.name === NOUS_HOST_GATE_LOCK_NAME &&
    typeof lock.path === "string" &&
    lock.path.length > 0 &&
    Buffer.byteLength(lock.path, "utf8") <= NOUS_HOST_GATE_MAX_LOCK_PATH_BYTES &&
    typeof lock.device === "number" &&
    Number.isFinite(lock.device) &&
    Number.isInteger(lock.device) &&
    lock.device >= 0 &&
    typeof lock.inode === "number" &&
    Number.isFinite(lock.inode) &&
    Number.isInteger(lock.inode) &&
    lock.inode >= 0
  );
}

function validHttpStatus(status) {
  return status === null || (
    Number.isInteger(status) &&
    !Object.is(status, -0) &&
    status >= 100 &&
    status <= 599
  );
}

function strictProtocolEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (
    hasExactlyKeys(value, ["schema", "event", "provider", "model", "timeout_seconds", "lock"]) &&
    value.schema === NOUS_HOST_GATE_PROTOCOL &&
    value.event === NOUS_HOST_GATE_READY_EVENT &&
    value.provider === NOUS_HOST_GATE_PROVIDER &&
    value.model === NOUS_HOST_GATE_MODEL &&
    typeof value.timeout_seconds === "number" &&
    Number.isFinite(value.timeout_seconds) &&
    value.timeout_seconds > 0 &&
    value.timeout_seconds <= NOUS_HOST_GATE_MAX_TIMEOUT_MS / 1_000 &&
    validLockProof(value.lock)
  ) {
    return { event: NOUS_HOST_GATE_READY_EVENT };
  }
  if (
    hasExactlyKeys(value, ["schema", "event", "status"]) &&
    value.schema === NOUS_HOST_GATE_PROTOCOL &&
    value.event === NOUS_HOST_GATE_RELEASED_EVENT &&
    validHttpStatus(value.status)
  ) {
    return { event: NOUS_HOST_GATE_RELEASED_EVENT, status: value.status };
  }
  return undefined;
}

function normalizeCompletionStatus(status) {
  if (status === null) return null;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw gateError("nous_host_gate_completion_failed");
  }
  return status;
}

function safeKill(child) {
  try {
    if (child && typeof child.kill === "function") child.kill();
  } catch {
    // The process is already gone or the platform refused a second kill.
  }
}

class LeaseSession {
  #child;
  #onFailure;
  #readyDeferred = deferred();
  #releasedDeferred = deferred();
  #closedDeferred = deferred();
  #failureDeferred = deferred();
  #phase = "starting";
  #failure;
  #completionSent = false;
  #completionStatus;
  #terminated = false;
  #stdoutBuffer = Buffer.alloc(0);
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #sawExit = false;
  #exitCode;
  #exitSignal;
  #sawClose = false;
  #closeCode;
  #closeSignal;

  constructor(child, { onFailure } = {}) {
    this.#child = child;
    this.#onFailure = typeof onFailure === "function" ? onFailure : () => undefined;
    this.#attach();
  }

  get ready() {
    return this.#phase === "ready" || this.#phase === "completion-sent" || this.#phase === "released";
  }

  get completionSent() {
    return this.#completionSent;
  }

  get released() {
    return this.#phase === "released";
  }

  get failed() {
    return this.#failure;
  }

  waitReady() {
    return this.#readyDeferred.promise;
  }

  waitReleased() {
    return this.#releasedDeferred.promise;
  }

  waitClosed() {
    return this.#closedDeferred.promise;
  }

  waitFailure() {
    return this.#failureDeferred.promise;
  }

  fail(code) {
    const error = gateError(code);
    if (this.#failure) return this.#failure;
    this.#failure = error;
    this.#readyDeferred.reject(error);
    this.#releasedDeferred.reject(error);
    this.#closedDeferred.reject(error);
    this.#failureDeferred.resolve(error);
    try {
      this.#onFailure(error);
    } catch {
      // The gate error remains the only outward diagnostic.
    }
    return error;
  }

  terminate() {
    if (this.#terminated) return;
    this.#terminated = true;
    safeKill(this.#child);
  }

  sendCompletion(status) {
    if (this.#failure) throw this.#failure;
    if (!this.ready || this.#phase !== "ready" || this.#completionSent) {
      throw this.fail("nous_host_gate_completion_failed");
    }
    const normalized = normalizeCompletionStatus(status);
    const line = JSON.stringify({ status: normalized }) + "\n";
    if (Buffer.byteLength(line, "utf8") > NOUS_HOST_GATE_COMPLETION_MAX_BYTES) {
      throw this.fail("nous_host_gate_completion_failed");
    }
    const stdin = this.#child?.stdin;
    if (!stdin || typeof stdin.write !== "function" || typeof stdin.end !== "function") {
      throw this.fail("nous_host_gate_completion_failed");
    }
    // Mark the one completion before writing so a synchronously responding
    // fixture cannot make a second send appear valid.
    this.#completionSent = true;
    this.#completionStatus = normalized;
    this.#phase = "completion-sent";
    try {
      stdin.write(line);
      stdin.end();
    } catch {
      throw this.fail("nous_host_gate_completion_failed");
    }
  }

  #attach() {
    const stdout = this.#child?.stdout;
    const stderr = this.#child?.stderr;
    if (
      !stdout ||
      typeof stdout.on !== "function" ||
      !stderr ||
      typeof stderr.on !== "function" ||
      !this.#child ||
      (typeof this.#child.once !== "function" && typeof this.#child.on !== "function")
    ) {
      this.fail("nous_host_gate_spawn_failed");
      return;
    }
    stdout.on("data", (chunk) => this.#onStdout(chunk));
    stderr.on("data", (chunk) => this.#onStderr(chunk));
    const on = typeof this.#child.once === "function"
      ? this.#child.once.bind(this.#child)
      : this.#child.on.bind(this.#child);
    on("error", () => this.fail("nous_host_gate_spawn_failed"));
    on("exit", (code, signal) => this.#onExit(code, signal));
    on("close", (code, signal) => this.#onClose(code, signal));
    if (this.#child.stdin && typeof this.#child.stdin.on === "function") {
      this.#child.stdin.on("error", () => this.fail("nous_host_gate_completion_failed"));
    }
  }

  #onStdout(chunk) {
    if (this.#failure) return;
    const bytes = bytesFromChunk(chunk);
    if (!bytes || bytes.length > NOUS_HOST_GATE_MAX_PROTOCOL_BYTES - this.#stdoutBytes) {
      this.fail("nous_host_gate_protocol_failed");
      return;
    }
    this.#stdoutBytes += bytes.length;
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, bytes]);
    if (this.#stdoutBuffer.length > NOUS_HOST_GATE_MAX_PROTOCOL_BYTES) {
      this.fail("nous_host_gate_protocol_failed");
      return;
    }
    let newline;
    while ((newline = this.#stdoutBuffer.indexOf(0x0a)) !== -1) {
      const lineBytes = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (lineBytes.length === 0) {
        this.fail("nous_host_gate_protocol_failed");
        return;
      }
      let line;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
        line = decoded.endsWith("\r") ? decoded.slice(0, -1) : decoded;
      } catch {
        this.fail("nous_host_gate_protocol_failed");
        return;
      }
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        this.fail("nous_host_gate_protocol_failed");
        return;
      }
      const event = strictProtocolEvent(value);
      if (!event) {
        this.fail("nous_host_gate_protocol_failed");
        return;
      }
      if (this.#phase === "starting" && event?.event === NOUS_HOST_GATE_READY_EVENT) {
        this.#phase = "ready";
        this.#readyDeferred.resolve();
        continue;
      }
      if (
        this.#phase === "completion-sent" &&
        event?.event === NOUS_HOST_GATE_RELEASED_EVENT &&
        event.status === this.#completionStatus
      ) {
        this.#phase = "released";
        this.#releasedDeferred.resolve();
        this.#resolveClosedIfReady();
        continue;
      }
      this.fail("nous_host_gate_protocol_failed");
      return;
    }
  }

  #onStderr(chunk) {
    if (this.#failure) return;
    const bytes = bytesFromChunk(chunk);
    if (!bytes || bytes.length > NOUS_HOST_GATE_MAX_STDERR_BYTES - this.#stderrBytes) {
      this.fail("nous_host_gate_protocol_failed");
      return;
    }
    this.#stderrBytes += bytes.length;
  }

  #onExit(code, signal) {
    this.#sawExit = true;
    this.#exitCode = code;
    this.#exitSignal = signal;
    if (this.#phase !== "released") {
      this.fail("nous_host_gate_protocol_failed");
      return;
    }
    if (code !== 0 || signal !== null && signal !== undefined) {
      this.fail("nous_host_gate_protocol_failed");
      return;
    }
    this.#resolveClosedIfReady();
  }

  #onClose(code, signal) {
    this.#sawClose = true;
    this.#closeCode = code;
    this.#closeSignal = signal;
    if (this.#stdoutBuffer.length > 0 || this.#phase !== "released") {
      this.fail("nous_host_gate_protocol_failed");
      return;
    }
    const effectiveCode = code ?? this.#exitCode;
    const effectiveSignal = signal ?? this.#exitSignal;
    if (
      effectiveCode !== 0 ||
      effectiveSignal !== null && effectiveSignal !== undefined
    ) {
      this.fail("nous_host_gate_protocol_failed");
      return;
    }
    this.#resolveClosedIfReady();
  }

  #resolveClosedIfReady() {
    if (this.#sawClose || this.#sawExit && this.#closeCode !== undefined) {
      if (!this.#failure) this.#closedDeferred.resolve();
    }
  }
}

function validateTimeout(timeoutMs) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > NOUS_HOST_GATE_MAX_TIMEOUT_MS
  ) {
    throw gateError("nous_host_gate_timeout");
  }
  return timeoutMs;
}

function remaining(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function waitUntil(promise, deadline, onTimeout) {
  const ms = remaining(deadline);
  if (ms <= 0) {
    onTimeout();
    throw gateError("nous_host_gate_timeout");
  }
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(gateError("nous_host_gate_timeout"));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortErrorFor(signal) {
  return signal?.aborted
    ? gateError("nous_host_gate_aborted")
    : gateError("nous_host_gate_fetch_failed");
}

async function cancelBody(body) {
  try {
    if (body && typeof body.cancel === "function") await body.cancel();
  } catch {
    // The primary bounded gate error is retained.
  }
}

function discardProviderStopBody(response) {
  let body;
  try {
    body = response?.body;
  } catch {
    return;
  }
  if (!body) return;
  try {
    if (typeof body.cancel === "function") {
      const pending = body.cancel();
      if (pending && typeof pending.then === "function") {
        Promise.resolve(pending).catch(() => undefined);
      }
      return;
    }
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      const pending = typeof reader.cancel === "function" ? reader.cancel() : undefined;
      if (pending && typeof pending.then === "function") {
        Promise.resolve(pending).catch(() => undefined);
      }
      try {
        reader.releaseLock();
      } catch {
        // Cancellation is best effort; the lease status is authoritative.
      }
    }
  } catch {
    // A 402 status is still sent to the lease even when body cleanup fails.
  }
}

function sanitizedProviderStopResponse() {
  return new Response(
    JSON.stringify({
      error: {
        type: "nous_host_gate_provider_stop",
        provider: NOUS_HOST_GATE_PROVIDER,
        provider_contacted: true,
        provider_stop: true,
        retryable: false,
        no_resend: true,
        original_http_status: NOUS_HOST_GATE_PROVIDER_STOP_STATUS,
        message: "Nous provider access is stopped after HTTP 402; reconcile before resending.",
      },
    }),
    {
      status: NOUS_HOST_GATE_PROVIDER_STOP_STATUS,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    },
  );
}

function contentLengthLimit(response) {
  let value;
  try {
    value = response?.headers?.get?.("content-length");
  } catch {
    throw gateError("nous_host_gate_response_invalid");
  }
  if (value === null || value === undefined) return;
  if (!/^\d+$/u.test(value)) throw gateError("nous_host_gate_response_invalid");
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > NOUS_HOST_GATE_MAX_RESPONSE_BYTES) {
    throw gateError("nous_host_gate_response_limit");
  }
}

function abortableRead(readPromise, signal) {
  if (!signal) return readPromise;
  if (signal.aborted) return Promise.reject(abortErrorFor(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortErrorFor(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(readPromise).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(gateError("nous_host_gate_fetch_failed"));
      },
    );
  });
}

async function readBoundedBody(response, signal) {
  contentLengthLimit(response);
  const body = response?.body;
  if (!body) return;
  const chunks = [];
  let total = 0;
  const addChunk = (chunk) => {
    if (!(chunk instanceof Uint8Array)) throw gateError("nous_host_gate_response_invalid");
    if (chunk.byteLength > NOUS_HOST_GATE_MAX_RESPONSE_BYTES - total) {
      throw gateError("nous_host_gate_response_limit");
    }
    total += chunk.byteLength;
    chunks.push(Buffer.from(chunk));
  };
  try {
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      try {
        try {
          while (true) {
            const result = await abortableRead(reader.read(), signal);
            if (result?.done) break;
            addChunk(result?.value);
          }
        } catch (error) {
          try {
            await reader.cancel();
          } catch {
            // The bounded primary error is retained.
          }
          throw error;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // No raw stream detail leaves this module.
        }
      }
    } else if (typeof body[Symbol.asyncIterator] === "function") {
      const iterator = body[Symbol.asyncIterator]();
      try {
        while (true) {
          const result = await abortableRead(iterator.next(), signal);
          if (result?.done) break;
          addChunk(result?.value);
        }
      } finally {
        try {
          if (typeof iterator.return === "function") await iterator.return();
        } catch {
          // Preserve the bounded primary error.
        }
      }
    } else {
      throw gateError("nous_host_gate_response_invalid");
    }
  } catch (error) {
    await cancelBody(body);
    if (error instanceof NousHostGateError) throw error;
    throw gateError("nous_host_gate_fetch_failed");
  }
  return Buffer.concat(chunks, total);
}

function rebuildResponse(response, bytes) {
  try {
    const headers = new Headers(response?.headers);
    for (const name of ["content-encoding", "content-length", "transfer-encoding"]) {
      headers.delete(name);
    }
    return new Response(bytes, {
      status: response.status,
      statusText: typeof response.statusText === "string" ? response.statusText : "",
      headers,
    });
  } catch {
    throw gateError("nous_host_gate_response_invalid");
  }
}

async function completeResponse(response, signal) {
  if (
    !response ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599
  ) {
    throw gateError("nous_host_gate_response_invalid");
  }
  // Fetch's clone tees the stream. Consume the clone to prove body completion
  // while returning the original response with its normal metadata and body.
  if (typeof response.clone === "function") {
    try {
      const copy = response.clone();
      await readBoundedBody(copy, signal);
      return response;
    } catch (error) {
      await cancelBody(response?.body);
      if (error instanceof NousHostGateError) throw error;
      throw gateError("nous_host_gate_fetch_failed");
    }
  }
  try {
    const bytes = await readBoundedBody(response, signal);
    return rebuildResponse(response, bytes);
  } catch (error) {
    await cancelBody(response?.body);
    throw error instanceof NousHostGateError ? error : gateError("nous_host_gate_fetch_failed");
  }
}

async function sendStatusAndRelease(session, status, deadline) {
  try {
    session.sendCompletion(status);
    await waitUntil(
      session.waitReleased(),
      deadline,
      () => session.fail("nous_host_gate_reconcile_required"),
    );
    await waitUntil(
      session.waitClosed(),
      deadline,
      () => session.fail("nous_host_gate_reconcile_required"),
    );
  } catch {
    session.terminate();
    throw gateError("nous_host_gate_reconcile_required");
  }
}

async function sendNullAndRelease(session, deadline) {
  if (!session.ready || session.completionSent || session.failed) return;
  await sendStatusAndRelease(session, null, deadline);
}

/**
 * Return a fetch-compatible function that requires the canonical provider
 * lease for every call. spawnImpl is a test seam only; there is no command
 * or skip-gate option in the production API.
 */
export function createNousHostGateFetch({
  fetchImpl = fetch,
  spawnImpl = nodeSpawn,
  timeoutMs = NOUS_HOST_GATE_DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl must be a function.");
  const timeout = validateTimeout(timeoutMs);

  return async function nousHostGateFetch(input, init = undefined) {
    const callerSignal = init?.signal;
    if (callerSignal?.aborted) throw gateError("nous_host_gate_aborted");

    const controller = new AbortController();
    let session;
    let callerAborted = false;
    const onCallerAbort = () => {
      callerAborted = true;
      controller.abort();
      if (session && !session.ready) session.fail("nous_host_gate_aborted");
    };
    if (callerSignal && typeof callerSignal.addEventListener === "function") {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      if (callerSignal.aborted) onCallerAbort();
    }

    let child;
    let succeeded = false;
    const deadline = Date.now() + timeout;
    let deadlineTimer;
    try {
      const command = buildDefaultNousHostGateCommand({
        leaseTimeoutSeconds: timeout / 1_000,
      });
      try {
        child = spawnImpl(command.command, command.args, {
          ...command.options,
          ...buildNousHostGateSpawnOptions({ platform: process.platform }),
        });
      } catch {
        throw gateError("nous_host_gate_spawn_failed");
      }
      session = new LeaseSession(child, {
        onFailure: () => {
          if (!controller.signal.aborted) controller.abort();
        },
      });
      deadlineTimer = setTimeout(() => {
        session.fail("nous_host_gate_timeout");
        session.terminate();
      }, timeout);
      if (callerAborted) session.fail("nous_host_gate_aborted");

      await waitUntil(
        session.waitReady(),
        deadline,
        () => {
          session.fail("nous_host_gate_timeout");
          session.terminate();
        },
      );
      if (callerAborted || controller.signal.aborted) {
        throw gateError("nous_host_gate_aborted");
      }

      let upstream;
      try {
        const requestInit = init === undefined ? { signal: controller.signal } : {
          ...init,
          signal: controller.signal,
        };
        upstream = await Promise.race([
          Promise.resolve().then(() => fetchImpl(input, requestInit)),
          session.waitFailure().then((error) => Promise.reject(error)),
        ]);
      } catch {
        const primary = session.failed ||
          (callerAborted || controller.signal.aborted
          ? gateError("nous_host_gate_aborted")
          : gateError("nous_host_gate_fetch_failed"));
        try {
          await sendNullAndRelease(session, deadline);
        } catch {
          session.terminate();
          throw gateError("nous_host_gate_reconcile_required");
        }
        throw primary;
      }

      let upstreamStatus;
      try {
        upstreamStatus = upstream?.status;
      } catch {
        throw gateError("nous_host_gate_response_invalid");
      }
      if (upstreamStatus === NOUS_HOST_GATE_PROVIDER_STOP_STATUS) {
        // A 402 is the provider circuit-breaker signal. Do not wait for its
        // body: it may be stalled or oversized, and the bridge must receive
        // status 402 while the shared mutex is still held.
        discardProviderStopBody(upstream);
        await sendStatusAndRelease(session, NOUS_HOST_GATE_PROVIDER_STOP_STATUS, deadline);
        succeeded = true;
        return sanitizedProviderStopResponse();
      }

      let completed;
      try {
        completed = await completeResponse(upstream, controller.signal);
      } catch (error) {
        const primary = session.failed ||
          (error instanceof NousHostGateError
          ? error
          : callerAborted || controller.signal.aborted
            ? gateError("nous_host_gate_aborted")
            : gateError("nous_host_gate_fetch_failed"));
        try {
          await sendNullAndRelease(session, deadline);
        } catch {
          session.terminate();
          throw gateError("nous_host_gate_reconcile_required");
        }
        throw primary;
      }

      const status = callerAborted || controller.signal.aborted ? null : completed.status;
      await sendStatusAndRelease(session, status, deadline);
      if (callerAborted || controller.signal.aborted) {
        throw gateError("nous_host_gate_aborted");
      }
      succeeded = true;
      return completed;
    } catch (error) {
      let finalError = error instanceof NousHostGateError
        ? error
        : gateError("nous_host_gate_reconcile_required");
      if (session?.ready && !session.completionSent && !session.failed) {
        try {
          await sendNullAndRelease(session, deadline);
        } catch {
          session.terminate();
          finalError = gateError("nous_host_gate_reconcile_required");
        }
      }
      throw finalError;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (!succeeded && session) session.terminate();
      if (callerSignal && typeof callerSignal.removeEventListener === "function") {
        try {
          callerSignal.removeEventListener("abort", onCallerAbort);
        } catch {
          // A nonstandard test signal must not replace the gate result.
        }
      }
    }
  };
}
