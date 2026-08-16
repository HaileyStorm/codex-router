export function startupTimeoutMs(platform = process.platform) {
  return platform === "win32" ? 30_000 : 5_000;
}

export const STARTUP_TIMEOUT_MS = startupTimeoutMs();

function childTerminated(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForTermination(child, timeoutMs) {
  return new Promise((resolve) => {
    let timer;

    const finish = (result) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(result);
    };
    const onExit = (code, signal) => finish({ terminated: true, code, signal });
    const onError = (error) => finish({ terminated: false, error });

    // Register both terminal listeners before checking state or sending a
    // signal. A short-lived child can otherwise exit between kill() and once().
    child.once("exit", onExit);
    child.once("error", onError);

    if (childTerminated(child)) {
      finish({ terminated: true, code: child.exitCode, signal: child.signalCode });
      return;
    }

    timer = setTimeout(() => finish({ terminated: false }), Math.max(0, timeoutMs));
  });
}

function signalFailure(signal, error, delivered) {
  if (error) return `${signal} raised ${error.message || String(error)}`;
  if (delivered === false) return `${signal} was not delivered`;
  return null;
}

export async function stopChild(
  child,
  {
    gracefulTimeoutMs = 2_000,
    forceTimeoutMs = 2_000,
    description = "child process",
  } = {},
) {
  if (childTerminated(child)) return;

  const gracefulTermination = waitForTermination(child, gracefulTimeoutMs);
  let gracefulDelivered;
  let gracefulError;
  try {
    gracefulDelivered = child.kill("SIGTERM");
  } catch (error) {
    gracefulError = error;
  }
  const gracefulResult = await gracefulTermination;
  if (gracefulResult.terminated) return;

  // Escalate only the ChildProcess supplied by the test. Do not reach through
  // taskkill, process groups, or PID trees that may include unrelated work.
  const forcedTermination = waitForTermination(child, forceTimeoutMs);
  let forceDelivered;
  let forceError;
  try {
    forceDelivered = child.kill("SIGKILL");
  } catch (error) {
    forceError = error;
  }
  const forceResult = await forcedTermination;
  if (forceResult.terminated) return;

  const details = [
    signalFailure("SIGTERM", gracefulError || gracefulResult.error, gracefulDelivered),
    signalFailure("SIGKILL", forceError || forceResult.error, forceDelivered),
  ].filter(Boolean);
  const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
  throw new Error(
    `Failed to stop ${description}: it did not exit after SIGTERM within ${gracefulTimeoutMs}ms `
      + `or SIGKILL within ${forceTimeoutMs}ms${suffix}`,
  );
}
