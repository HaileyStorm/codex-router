import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { privateFileIsProtected, protectPrivateFile } from "./file-security.mjs";
import {
  CODEX_HOME,
  DISCOVERY_MODE_PATH,
  LOG_PATH,
  PORTS,
  PROVIDER_SELECTION_PATH,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
} from "./paths.mjs";

const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const renderCommands = new Set([
  "render",
  "render-env-wrapper",
  "render-launcher",
  "render-task",
]);
const taskName = "Codex Router";
const wrapperPath = path.join(STATE_DIR, "start-codex-router.cmd");
const powerShellWrapperPath = path.join(STATE_DIR, "start-codex-router-env.ps1");
const launcherPath = path.join(STATE_DIR, "start-codex-router-hidden.vbs");
const supervisorPath = path.join(STATE_DIR, "start-codex-router-supervisor.exe");
const supervisorSourcePath = path.join(SOURCE_ROOT, "src", "windows-service-supervisor.cs");
let knownSystemDirectory;

function resolveKnownSystemDirectory() {
  if (knownSystemDirectory !== undefined) return knownSystemDirectory;
  // The .NET known-folder API is the source of truth for system paths. On a
  // non-Windows host the service tests set the effective platform to win32,
  // but must not need a Windows shell just to render a fixture.
  if (process.platform !== "win32") return (knownSystemDirectory = undefined);
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::SystemDirectory"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
    ).trim();
    if (!output || output.includes("\r") || output.includes("\n")) throw new Error("invalid system directory");
    if (!path.isAbsolute(output)) throw new Error("invalid system directory");
    assertOrdinaryPath(output, "the Windows system directory", { directory: true });
    return (knownSystemDirectory = output);
  } catch {
    throw new Error("Unable to resolve the Windows system directory through the OS known-folder API.");
  }
}

function powerShellExecutablePath() {
  if (process.platform !== "win32") return "powershell.exe";
  return assertOrdinaryPath(
    path.join(resolveKnownSystemDirectory(), "WindowsPowerShell", "v1.0", "powershell.exe"),
    "the Windows PowerShell executable",
  );
}

function supervisorCompilerExecutablePath() {
  if (process.platform !== "win32") return "csc.exe";
  return assertOrdinaryPath(
    path.join(
      path.dirname(resolveKnownSystemDirectory()),
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe",
    ),
    "the Windows C# compiler",
  );
}

if (effectivePlatform !== "win32" && !renderCommands.has(command)) {
  throw new Error("The Task Scheduler service manager runs on Windows only.");
}

function cmdEscape(value) {
  return String(value).replaceAll("%", "%%").replaceAll('"', '""');
}

function vbsEscape(value) {
  return String(value).replaceAll('"', '""');
}

function psEscape(value) {
  return String(value).replaceAll("'", "''");
}

function rejectPercentPath(value, label) {
  if (String(value).includes("%")) {
    throw new Error(`${label} contains '%' and cannot be used by the Windows service.`);
  }
}

function pathEquivalent(left, right) {
  const normalize = (value) => path.normalize(value).replace(/[\\/]+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function assertOrdinaryPath(target, label, { directory = false } = {}) {
  const resolved = path.resolve(target);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new Error(`${label} is missing or cannot be inspected.`);
  }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`${label} is not an ordinary ${directory ? "directory" : "file"}.`);
  }
  try {
    const real = realpathSync.native(resolved);
    if (!pathEquivalent(real, resolved)) {
      throw new Error(`${label} resolves through a link or reparse point.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes(label)) throw error;
    throw new Error(`${label} cannot be canonically verified.`);
  }
  let current = path.dirname(resolved);
  while (true) {
    let ancestor;
    try {
      ancestor = lstatSync(current);
    } catch {
      throw new Error(`${label} has an ancestor that cannot be inspected.`);
    }
    if (ancestor.isSymbolicLink() || !ancestor.isDirectory()) {
      throw new Error(`${label} has a non-ordinary ancestor.`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

function validateInstallPaths() {
  const pathValues = [
    [SOURCE_ROOT, "the router source path"],
    [supervisorSourcePath, "the supervisor source path"],
    [STATE_DIR, "the router service state path"],
    [wrapperPath, "the CMD wrapper path"],
    [powerShellWrapperPath, "the PowerShell wrapper path"],
    [supervisorPath, "the supervisor path"],
    [LOG_PATH, "the router log path"],
    [CODEX_HOME, "the Codex home path"],
  ];
  for (const [value, label] of pathValues) rejectPercentPath(value, label);
  if (process.env.KIMI_CODE_HOME) rejectPercentPath(process.env.KIMI_CODE_HOME, "the Kimi home path");
  assertOrdinaryPath(SOURCE_ROOT, "the router source path", { directory: true });
  assertOrdinaryPath(supervisorSourcePath, "the supervisor source path");
  assertOrdinaryPath(STATE_DIR, "the router service state path", { directory: true });
  for (const [value, label] of [
    [wrapperPath, "the CMD wrapper path"],
    [powerShellWrapperPath, "the PowerShell wrapper path"],
    [supervisorPath, "the supervisor path"],
    [launcherPath, "the legacy launcher path"],
  ]) {
    if (existsSync(value)) assertOrdinaryPath(value, label);
  }
}

function wrapper() {
  const start = path.join(SOURCE_ROOT, "src", "start.mjs");
  const powerShellPath = powerShellExecutablePath();
  const variables = {
    MODEL_ROUTER_TARGET: TARGET,
    MODEL_ROUTER_STATE_DIR: STATE_DIR,
    MODEL_ROUTER_QUIET: "1",
    MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    MODEL_ROUTER_PORT: String(PORTS.router),
    MODEL_ROUTER_API_PORT: String(PORTS.api),
    CODEX_HOME,
    CODEX_ROUTER_STATE_DIR: STATE_DIR,
    CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    CODEX_ROUTER_PORT: String(PORTS.router),
    CODEX_ROUTER_API_PORT: String(PORTS.api),
    ...(process.env.CODEX_ROUTER_LEGACY_SUBAGENT_CLEANUP === "1"
      ? { CODEX_ROUTER_LEGACY_SUBAGENT_CLEANUP: "1" }
      : {}),
    // The LiteLLM gateway is a Python process. Force UTF-8 output so its
    // startup banner and logs do not crash on Windows systems whose default
    // ANSI/OEM code page is not UTF-8 (e.g. Russian cp1251), where Python
    // would otherwise encode stdout as the legacy code page.
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...(process.env.KIMI_CODE_HOME ? { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME } : {}),
  };
  return `@echo off\r\n${Object.entries(variables)
    .map(([key, value]) => `set "${key}=${cmdEscape(value)}"`)
    .join("\r\n")}\r\n"${cmdEscape(powerShellPath)}" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${cmdEscape(powerShellWrapperPath)}" >> "${cmdEscape(LOG_PATH)}" 2>&1\r\n`;
}

function powerShellWrapper() {
  const start = path.join(SOURCE_ROOT, "src", "start.mjs");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$providerSelectionPath = '${psEscape(PROVIDER_SELECTION_PATH)}'`,
    `$discoveryModePath = '${psEscape(DISCOVERY_MODE_PATH)}'`,
    "$selectedNous = $false",
    "if (Test-Path -LiteralPath $providerSelectionPath -PathType Leaf) {",
    "  try {",
    "    $selection = Get-Content -LiteralPath $providerSelectionPath -Raw | ConvertFrom-Json",
    "    if ($selection.version -eq 1 -and $selection.providers -is [System.Array]) {",
    "      $selectedNous = @($selection.providers | ForEach-Object { [string]$_ }) -contains 'nous'",
    "    }",
    "  } catch {",
    "    $selectedNous = $false",
    "  }",
    "}",
    // Match discovery-mode.mjs: the process override wins in either direction;
    // only an absent/unknown override falls through to the persisted marker.
    "$discoveryOverride = $env:CODEX_ROUTER_NO_DISCOVERY",
    "$discoveryEnabled = $true",
    "if ($discoveryOverride -eq '1') {",
    "  $discoveryEnabled = $false",
    "} elseif ($discoveryOverride -eq '0') {",
    "  $discoveryEnabled = $true",
    "} elseif (Test-Path -LiteralPath $discoveryModePath -PathType Leaf) {",
    "  try {",
    "    $discovery = Get-Content -LiteralPath $discoveryModePath -Raw | ConvertFrom-Json",
    "    if ($discovery.version -eq 1 -and $discovery.discovery -eq 'disabled') {",
    "      $discoveryEnabled = $false",
    "    }",
    "  } catch {",
    "    $discoveryEnabled = $true",
    "  }",
    "}",
    "[Environment]::SetEnvironmentVariable('NOUS_API_KEY', $null, 'Process')",
    "if ($selectedNous) {",
    "  if (-not $discoveryEnabled) {",
    "    throw 'The selected Nous provider requires credential discovery to be enabled.'",
    "  }",
    "  $userKey = [Environment]::GetEnvironmentVariable('NOUS_API_KEY', 'User')",
    "  if ([string]::IsNullOrWhiteSpace($userKey)) {",
    "    throw 'The selected Nous provider requires NOUS_API_KEY in the persistent user environment.'",
    "  }",
    "  [Environment]::SetEnvironmentVariable('NOUS_API_KEY', $userKey, 'Process')",
    "  $userKey = $null",
    "}",
    `& '${psEscape(process.execPath)}' '${psEscape(start)}'`,
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");
}

// Legacy installs launched this script through `wscript.exe //B //NoLogo`,
// which is retained only long enough to stop and retire that old task action.
// The current scheduled task runs the native supervisor directly, so the
// supervisor can own the job that contains the CMD wrapper and its descendants.
//
// The `True` wait flag is what keeps Task Scheduler's restart settings alive:
// Run then blocks until the wrapper exits and returns its exit code, which the
// script re-raises through WScript.Quit. Quitting with a fixed 0 (or letting the
// script fall off the end) would report every crash as a clean exit and silently
// disable RestartCount/RestartInterval.
function launcher() {
  // A Windows path cannot contain a double quote, but escape it anyway so a
  // hand-edited state directory can never break out of the string literal.
  // Chr(34) supplies the quotes cmd.exe needs around the wrapper path, which
  // keeps this generated source free of stacked quote-doubling.
  return [
    "Option Explicit",
    "",
    "Dim quote, shell, status",
    "quote = Chr(34)",
    'Set shell = CreateObject("WScript.Shell")',
    "On Error Resume Next",
    `status = shell.Run("cmd.exe /D /C " & quote & quote & "${vbsEscape(wrapperPath)}" & quote & quote, 0, True)`,
    "If Err.Number <> 0 Then",
    "  WScript.Quit 1",
    "End If",
    "On Error Goto 0",
    "WScript.Quit status",
    "",
  ].join("\r\n");
}

function schtasks(args, options = {}) {
  const executable = process.platform === "win32"
    ? assertOrdinaryPath(
        path.join(resolveKnownSystemDirectory(), "schtasks.exe"),
        "the Windows Task Scheduler executable",
      )
    : "schtasks.exe";
  return execFileSync(executable, args, {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

function writeAtomic(target, contents, options = {}) {
  const temporary = `${target}.tmp.${process.pid}`;
  if (options.protected) {
    writeFileSync(temporary, contents, { mode: 0o600 });
  } else {
    writeFileSync(temporary, contents);
  }
  try {
    if (options.protected) protectPrivateFile(temporary);
    // renameSync replaces an existing destination on Windows, so reinstalling
    // over an older launcher pair is a plain overwrite rather than a conflict.
    renameSync(temporary, target);
    if (options.protected) protectPrivateFile(target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function compileSupervisor() {
  const temporary = `${supervisorPath}.tmp.${process.pid}`;
  try {
    execFileSync(
      supervisorCompilerExecutablePath(),
      [
        "/nologo",
        "/target:winexe",
        "/optimize+",
        "/platform:x64",
        `/out:${temporary}`,
        supervisorSourcePath,
      ],
      { stdio: "ignore" },
    );
    protectPrivateFile(temporary);
    if (!privateFileIsProtected(temporary)) throw new Error("supervisor protection verification failed");
    return temporary;
  } catch {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw new Error("Unable to compile the Windows service supervisor.");
  }
}

function promoteSupervisor(temporary) {
  try {
    // The old task is stopped before this replacement, so the supervisor path
    // is no longer held by the scheduled action when the staged binary lands.
    renameSync(temporary, supervisorPath);
    protectPrivateFile(supervisorPath);
    if (!privateFileIsProtected(supervisorPath)) throw new Error("supervisor protection verification failed");
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function stageProtectedLauncher(target, contents) {
  const temporary = `${target}.stage.${process.pid}`;
  writeAtomic(temporary, contents, { protected: true });
  if (!privateFileIsProtected(temporary)) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw new Error(`staged launcher protection verification failed for ${path.basename(target)}`);
  }
  return temporary;
}

function promoteProtectedLauncher(temporary, target) {
  renameSync(temporary, target);
  protectPrivateFile(target);
  if (!privateFileIsProtected(target)) {
    throw new Error(`launcher protection verification failed for ${path.basename(target)}`);
  }
}

function promoteLaunchers(staged) {
  promoteProtectedLauncher(staged.powerShell, powerShellWrapperPath);
  promoteProtectedLauncher(staged.wrapper, wrapperPath);
  promoteSupervisor(staged.supervisor);
}

function removeStagedLaunchers(staged) {
  for (const target of [staged?.powerShell, staged?.wrapper, staged?.supervisor]) {
    try {
      if (target && existsSync(target)) unlinkSync(target);
    } catch {
      // Retain only a specifically staged artifact if a sharing violation
      // prevents cleanup; never widen this to other service state.
    }
  }
}

function retireLegacyLauncher() {
  if (existsSync(launcherPath)) unlinkSync(launcherPath);
}

function writeLaunchers() {
  mkdirSync(STATE_DIR, { recursive: true });
  validateInstallPaths();
  // The PowerShell layer reads the persistent user-scoped Nous key at launch;
  // keep the generated source owner-protected even though it contains only
  // credential names and metadata paths.
  const stagedPowerShell = stageProtectedLauncher(
    powerShellWrapperPath,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(powerShellWrapper(), "utf8")]),
  );
  const stagedWrapper = stageProtectedLauncher(wrapperPath, Buffer.from(wrapper(), "utf8"));
  // Compile before stopping the current task. The staged binary is promoted
  // only after endTask() has returned, so an old VBS action never loses its
  // executable while it is still the registered task action.
  let stagedSupervisor;
  try {
    stagedSupervisor = compileSupervisor();
  } catch (error) {
    removeStagedLaunchers({ powerShell: stagedPowerShell, wrapper: stagedWrapper });
    throw error;
  }
  return { powerShell: stagedPowerShell, wrapper: stagedWrapper, supervisor: stagedSupervisor };
}

// Task Scheduler's first CIM-backed query can cold-start the service and take
// materially longer than a normal state poll; keep the preflight bounded while
// avoiding a false foreign/missing classification during that warm-up.
const TASK_METADATA_TIMEOUT_MS = 60_000;
const TASK_XML_MAX_BYTES = 1024 * 1024;

function taskMetadata() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $task = Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK -ErrorAction Stop",
    "  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "  $principalSid = ''",
    "  try { $principalSid = (New-Object Security.Principal.NTAccount([string]$task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { try { $principalSid = (New-Object Security.Principal.SecurityIdentifier([string]$task.Principal.UserId)).Value } catch { $principalSid = '' } }",
    "  $actions = @($task.Actions | ForEach-Object { [pscustomobject]@{ execute = [string]$_.Execute; argument = [string]$_.Arguments } })",
    "  $result = [pscustomobject]@{ kind = 'present'; principal = [string]$task.Principal.UserId; principalSid = [string]$principalSid; currentPrincipal = [string]$identity.Name; currentSid = [string]$identity.User.Value; actions = $actions }",
    "  [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 5))",
    "} catch {",
    "  $category = [string]$_.CategoryInfo.Category",
    "  if ($category -eq 'ObjectNotFound') { [Console]::Out.Write('{\"kind\":\"missing\"}'); exit 0 }",
    "  if ($category -eq 'PermissionDenied' -or $_.Exception -is [UnauthorizedAccessException]) { exit 5 }",
    "  exit 6",
    "}",
  ].join("; ");
  try {
    const output = execFileSync(
      powerShellExecutablePath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: TASK_METADATA_TIMEOUT_MS,
        env: { ...process.env, CODEX_ROUTER_TASK: taskName },
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!output) throw new Error("empty task metadata");
    const parsed = JSON.parse(output);
    if (parsed?.kind !== "present" && parsed?.kind !== "missing") {
      throw new Error("invalid task metadata");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT" && process.platform !== "win32") {
      return { kind: "missing" };
    }
    if (error?.status === 5) {
      throw new Error("Access to the existing Windows service task was denied.");
    }
    if (error instanceof SyntaxError || error?.message === "empty task metadata") {
      throw new Error("The existing Windows service task metadata was malformed.");
    }
    if (error?.message === "invalid task metadata") {
      throw new Error("The existing Windows service task metadata was malformed.");
    }
    throw new Error("Unable to inspect the existing Windows service task.");
  }
}

function taskXml() {
  let bytes;
  try {
    bytes = schtasks(["/Query", "/TN", taskName, "/XML"], {
      encoding: null,
      maxBuffer: TASK_XML_MAX_BYTES,
    });
  } catch {
    throw new Error("Unable to snapshot the existing Windows service task definition.");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > TASK_XML_MAX_BYTES) {
    throw new Error("The existing Windows service task definition was malformed.");
  }
  return bytes;
}

function stripOuterQuotes(value) {
  const text = String(value ?? "").trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1)
    : text;
}

function sameWindowsText(left, right) {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

function sameWindowsPath(left, right) {
  const a = stripOuterQuotes(left).replaceAll("/", "\\");
  const b = stripOuterQuotes(right).replaceAll("/", "\\");
  return sameWindowsText(path.win32.normalize(a), path.win32.normalize(b));
}

function systemExecutablePath(name) {
  if (process.platform !== "win32") return name;
  return assertOrdinaryPath(
    path.join(resolveKnownSystemDirectory(), name),
    `the Windows ${name} executable`,
  );
}

function legacyTaskArgument() {
  return `//B //NoLogo "${launcherPath}"`;
}

function isManagedTaskMetadata(metadata) {
  if (metadata?.kind !== "present") return false;
  if (!metadata.principalSid || !metadata.currentSid) return false;
  if (!sameWindowsText(metadata.principalSid, metadata.currentSid)) return false;
  const actions = Array.isArray(metadata.actions)
    ? metadata.actions
    : metadata.actions
      ? [metadata.actions]
      : [];
  if (actions.length !== 1) return false;
  const action = actions[0] || {};
  const execute = stripOuterQuotes(action.execute);
  const argument = String(action.argument ?? "");
  const native = sameWindowsPath(execute, supervisorPath) && argument === "";
  const legacy =
    (sameWindowsText(execute, "wscript.exe") || sameWindowsPath(execute, systemExecutablePath("wscript.exe"))) &&
    argument === legacyTaskArgument();
  return native || legacy;
}

function inspectTask({ includeState = false } = {}) {
  const metadata = taskMetadata();
  if (metadata.kind === "missing") return { exists: false, metadata };
  if (!isManagedTaskMetadata(metadata)) {
    throw new Error("The existing Windows service task is foreign or malformed; refusing to change it.");
  }
  const result = { exists: true, metadata, xml: taskXml() };
  if (includeState) result.state = taskState();
  return result;
}

function writeTaskSnapshot(bytes) {
  const snapshot = path.join(STATE_DIR, `task-definition-backup.${process.pid}.xml`);
  writeFileSync(snapshot, bytes, { mode: 0o600 });
  protectPrivateFile(snapshot);
  if (!privateFileIsProtected(snapshot)) {
    unlinkSync(snapshot);
    throw new Error("the Windows service task snapshot did not receive owner-only protection.");
  }
  return snapshot;
}

const managedFileSnapshotTargets = [
  ["wrapper", wrapperPath],
  ["powershell", powerShellWrapperPath],
  ["supervisor", supervisorPath],
  ["legacy-launcher", launcherPath],
];

function captureManagedFileSnapshot() {
  const directory = path.join(STATE_DIR, `service-rollback.${process.pid}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  protectPrivateFile(directory);
  if (!privateFileIsProtected(directory)) throw new Error("rollback directory protection verification failed");
  const entries = [];
  try {
    for (const [name, target] of managedFileSnapshotTargets) {
      const exists = existsSync(target);
      if (exists) assertOrdinaryPath(target, `the existing ${name} file`);
      const backup = path.join(directory, `${name}.bin`);
      if (exists) {
        writeFileSync(backup, readFileSync(target), { mode: 0o600 });
        protectPrivateFile(backup);
        if (!privateFileIsProtected(backup)) throw new Error(`rollback protection failed for ${name}`);
      }
      entries.push({ name, target, backup, exists });
    }
    const manifest = path.join(directory, "manifest.json");
    writeFileSync(manifest, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
    protectPrivateFile(manifest);
    if (!privateFileIsProtected(manifest)) throw new Error("rollback manifest protection verification failed");
    return { directory, manifest, entries };
  } catch (error) {
    removeManagedFileSnapshot({ directory, manifest: path.join(directory, "manifest.json"), entries });
    throw error;
  }
}

function restoreManagedFileSnapshot(snapshot) {
  for (const entry of snapshot?.entries || []) {
    if (entry.exists) {
      writeAtomic(entry.target, readFileSync(entry.backup), { protected: true });
      if (!privateFileIsProtected(entry.target)) {
        throw new Error(`rollback protection verification failed for ${entry.name}`);
      }
    } else if (existsSync(entry.target)) {
      assertOrdinaryPath(entry.target, `the generated ${entry.name} file`);
      unlinkSync(entry.target);
    }
  }
}

function removeManagedFileSnapshot(snapshot) {
  if (!snapshot) return;
  for (const entry of snapshot.entries || []) {
    try {
      if (existsSync(entry.backup)) unlinkSync(entry.backup);
    } catch {
      return;
    }
  }
  try {
    if (existsSync(snapshot.manifest)) unlinkSync(snapshot.manifest);
    if (existsSync(snapshot.directory)) rmdirSync(snapshot.directory);
  } catch {
    // Retain the exact rollback material when cleanup is blocked.
  }
}

function removeTaskSnapshot(snapshot) {
  if (!snapshot) return;
  try {
    if (existsSync(snapshot)) unlinkSync(snapshot);
  } catch {
    // The snapshot is private state owned by this invocation; a failed cleanup
    // must not mask the task result or prompt a broad filesystem deletion.
  }
}

function restoreTaskSnapshot(snapshot, { restart = false } = {}) {
  schtasks(["/Create", "/TN", taskName, "/XML", snapshot, "/F"], { quiet: true });
  const restored = inspectTask();
  if (!restored.exists) throw new Error("the previous Windows service task was not restored.");
  if (restart) {
    schtasks(["/Run", "/TN", taskName], { quiet: true });
    if (!inspectTask().exists) throw new Error("the previously running Windows service task was not restarted.");
  }
}

function deleteOwnedTask(taskInfo) {
  if (!taskInfo?.exists) return;
  schtasks(["/Delete", "/TN", taskName, "/F"], { quiet: true });
  if (inspectTask().exists) throw new Error("the Windows service task was not deleted.");
}

function rollbackInstall(previous, taskSnapshot, fileSnapshot, taskMutationStarted) {
  let current;
  if (taskMutationStarted) {
    current = inspectTask();
    if (current.exists) endTask(current);
  }
  restoreManagedFileSnapshot(fileSnapshot);
  if (!taskMutationStarted) return;
  if (previous?.exists) {
    if (previous.state === undefined) {
      throw new Error("the previous Windows service task state was unknown; refusing an unverified rollback.");
    }
    restoreTaskSnapshot(taskSnapshot, { restart: previous.state === "running" });
  } else if (current.exists) {
    deleteOwnedTask(current);
  }
}

// The supervisor is compiled as a WinExe, so Task Scheduler can launch it
// directly without a console host or external arguments.
function taskAction() {
  return {
    execute: supervisorPath,
    // The supervisor accepts no external arguments: it resolves the CMD
    // wrapper beside its own ordinary executable path.
    argument: "",
  };
}

function installTask() {
  const { execute, argument } = taskAction();
  const taskCommand = argument ? `${execute} ${argument}` : `"${execute}"`;
  const script = [
    // The action strings travel through the environment so that the quotes
    // around the launcher path never pass through powershell.exe's -Command
    // reparse or the schtasks argument escaper.
    "$action = if ([string]::IsNullOrEmpty($env:CODEX_ROUTER_TASK_ARGUMENT)) { New-ScheduledTaskAction -Execute $env:CODEX_ROUTER_TASK_EXECUTE } else { New-ScheduledTaskAction -Execute $env:CODEX_ROUTER_TASK_EXECUTE -Argument $env:CODEX_ROUTER_TASK_ARGUMENT }",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew",
    "$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null",
  ].join("; ");
  try {
    execFileSync(
      powerShellExecutablePath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...process.env,
          CODEX_ROUTER_TASK: taskName,
          CODEX_ROUTER_TASK_EXECUTE: execute,
          CODEX_ROUTER_TASK_ARGUMENT: argument,
        },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
  } catch {
    schtasks(
      [
        "/Create",
        "/TN",
        taskName,
        "/SC",
        "ONLOGON",
        "/TR",
        taskCommand,
        "/RL",
        "LIMITED",
        "/F",
      ],
      { quiet: true },
    );
  }
}

// `schtasks /End` returns once Task Scheduler has accepted the request, not
// once the instance is gone, and `MultipleInstances IgnoreNew` silently drops a
// `/Run` issued while the old one is still winding down -- which leaves the
// router stopped until the next logon, and turns the installer's readiness wait
// into a five-minute stall followed by a rollback. Polling the real state beats
// retrying `/Run`: it continues as soon as the instance has actually gone
// instead of guessing how long that takes, and it gives up on a fixed deadline
// instead of hoping one extra attempt is enough.
const TASK_STOP_TIMEOUT_MS = 10_000;
const TASK_STOP_POLL_MS = 250;
// Every state query has to return for the deadline above to mean anything, so a
// wedged PowerShell is capped rather than allowed to hang the install outright.
const TASK_STATE_TIMEOUT_MS = 15_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForTaskToStop() {
  const deadline = Date.now() + TASK_STOP_TIMEOUT_MS;
  while (true) {
    const state = taskState();
    if (state === undefined) {
      throw new Error("Unable to verify that the Windows service task stopped.");
    }
    if (state !== "running") return;
    if (Date.now() >= deadline) {
      throw new Error("The Windows service task did not stop before the bounded deadline.");
    }
    sleep(TASK_STOP_POLL_MS);
  }
}

function endTask(taskInfo) {
  if (!taskInfo?.exists) return;
  try {
    schtasks(["/End", "/TN", taskName], { quiet: true });
  } catch {
    // A recognized task may already be idle. Re-inspect it so an access
    // failure or a foreign replacement cannot be mistaken for that case.
    const current = inspectTask();
    if (!current.exists) return;
    if (taskState() !== "running") return;
    throw new Error("Unable to end the recognized Windows service task.");
  }
  waitForTaskToStop();
}

function taskState() {
  const script =
    "try { [Console]::Out.Write((Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK).State.ToString()) } catch { exit 1 }";
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    try {
      const candidate = executable === "powershell.exe" ? powerShellExecutablePath() : executable;
      return execFileSync(
        candidate,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_TASK: taskName },
          stdio: ["ignore", "pipe", "ignore"],
          timeout: TASK_STATE_TIMEOUT_MS,
        },
      ).trim().toLowerCase();
    } catch {
      // Try Windows PowerShell after PowerShell Core, or fall back to schtasks.
    }
  }
  return undefined;
}

if (
  !new Set([
    "install",
    "uninstall",
    "start",
    "stop",
    "restart",
    "status",
    "render",
    "render-env-wrapper",
    "render-launcher",
    "render-task",
  ]).has(command)
) {
  console.error(
    "Usage: service-windows.mjs install|uninstall|start|stop|restart|status|render|render-env-wrapper|render-launcher|render-task",
  );
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(wrapper());
} else if (command === "render-env-wrapper") {
  process.stdout.write(powerShellWrapper());
} else if (command === "render-launcher") {
  process.stdout.write(launcher());
} else if (command === "render-task") {
  process.stdout.write(`${JSON.stringify(taskAction())}\n`);
} else if (command === "install") {
  // Compile before touching the current task. If the OS compiler or source is
  // unavailable, the old service remains running and the install fails without
  // replacing its action.
  let previous;
  let taskSnapshot;
  let fileSnapshot;
  let stagedLaunchers;
  let taskMutationStarted = false;
  try {
    // Inspect before writing or registering anything. A same-named task belongs
    // to this service only when its principal and sole action are exact matches
    // for the current native or recognized legacy definition.
    previous = inspectTask({ includeState: true });
    if (previous.exists && previous.state === undefined) {
      throw new Error("Unable to determine whether the existing Windows service task is running.");
    }
    mkdirSync(STATE_DIR, { recursive: true });
    validateInstallPaths();
    fileSnapshot = captureManagedFileSnapshot();
    if (previous.exists) taskSnapshot = writeTaskSnapshot(previous.xml);
    stagedLaunchers = writeLaunchers();
    taskMutationStarted = true;
    endTask(previous);
    promoteLaunchers(stagedLaunchers);
    installTask();
    schtasks(["/Run", "/TN", taskName], { quiet: true });
    const current = inspectTask();
    if (!current.exists) throw new Error("the new Windows service task was not registered.");
    // The old VBS file is removable only after the replacement task has been
    // registered and its first run was accepted by Task Scheduler.
    try {
      retireLegacyLauncher();
    } catch {
      console.error("The legacy Windows launcher remains because it could not be retired.");
    }
    removeTaskSnapshot(taskSnapshot);
    removeManagedFileSnapshot(fileSnapshot);
    taskSnapshot = undefined;
    fileSnapshot = undefined;
    process.stdout.write(`${JSON.stringify({ installed: true, path: wrapperPath })}\n`);
  } catch (error) {
    let failure = error instanceof Error ? error : new Error(String(error));
    let rollbackSucceeded = true;
    try {
      rollbackInstall(previous, taskSnapshot, fileSnapshot, taskMutationStarted);
    } catch (rollbackError) {
      rollbackSucceeded = false;
      failure = new Error(`${failure.message}; rollback failed: ${rollbackError.message}`);
    }
    removeStagedLaunchers(stagedLaunchers);
    if (rollbackSucceeded) {
      removeTaskSnapshot(taskSnapshot);
      removeManagedFileSnapshot(fileSnapshot);
    } else {
      console.error("Rollback material retained under the service state directory.");
    }
    console.error(failure.message);
    process.exitCode = 1;
  }
} else if (command === "uninstall") {
  const current = inspectTask();
  if (current.exists) {
    endTask(current);
    deleteOwnedTask(current);
  }
  for (const target of [supervisorPath, launcherPath, wrapperPath, powerShellWrapperPath]) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {
      // The launcher may already be gone, or a concurrent uninstall removed it.
    }
  }
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "status") {
  const current = inspectTask();
  const installed = current.exists;
  const state = installed ? taskState() || "unknown" : "stopped";
  process.stdout.write(
    `${JSON.stringify({ installed, loaded: state === "running", state })}\n`,
  );
} else if (command === "stop") {
  // Stopping is idempotent, like uninstall and restart: a task that is missing
  // or already idle is the state the caller asked for, not an error to raise.
  endTask(inspectTask());
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else {
  const current = inspectTask();
  if (command === "restart") endTask(current);
  schtasks(["/Run", "/TN", taskName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
