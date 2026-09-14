import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function serviceEnv(platform, testRoot, target = "codex") {
  return {
    ...process.env,
    CODEX_HOME: path.join(testRoot, "codex home"),
    CODEX_ROUTER_STATE_DIR: path.join(testRoot, "router state"),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, `${target} router state`),
    MODEL_ROUTER_TARGET: target,
    CODEX_ROUTER_SERVICE_PLATFORM: platform,
    XDG_CONFIG_HOME: path.join(testRoot, "xdg config"),
  };
}

function serviceCommand(
  script,
  platform,
  testRoot,
  command = "render",
  target = "codex",
  sourceRoot = root,
  env = {},
) {
  const nodeArgs = sourceRoot === root ? [] : ["--preserve-symlinks", "--preserve-symlinks-main"];
  return execFileSync(
    process.execPath,
    [...nodeArgs, path.join(sourceRoot, "src", script), command],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      env: { ...serviceEnv(platform, testRoot, target), ...env },
    },
  );
}

function render(script, platform, testRoot, target = "codex", sourceRoot = root) {
  return serviceCommand(script, platform, testRoot, "render", target, sourceRoot);
}

// Mirrors src/service-windows.mjs: MODEL_ROUTER_STATE_DIR wins over every other
// state-directory source, and the fixture name deliberately carries a space.
function windowsStateDir(testRoot) {
  return path.join(testRoot, "codex router state");
}

// Mirrors the quoting in src/service-linux.mjs. Fixture paths are host-shaped,
// so on Windows they carry backslashes that the unit file has to escape; the
// expectation has to escape them too or the test only passes on POSIX hosts.
function systemdQuoted(value) {
  return `"${value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}

function launchdXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

test("background service definitions render for macOS, Linux, and Windows", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-services-"));
  try {
    const launchd = render("service-macos.mjs", "darwin", testRoot);
    assert.match(launchd, /<string>io\.github\.codex-router<\/string>/);
    assert.match(launchd, /<key>PATH<\/key>/);
    assert.match(launchd, /CODEX_ROUTER_STATE_DIR/);

    const systemd = render("service-linux.mjs", "linux", testRoot);
    assert.match(systemd, /\[Service\]/);
    assert.match(systemd, /ExecStart=/);
    assert.match(systemd, /Environment="PATH=/);
    assert.match(systemd, /Environment="CODEX_ROUTER_STATE_DIR=/);
    assert.match(systemd, /MODEL_ROUTER_GATEWAY_PORT=4200/);
    assert.match(systemd, /MODEL_ROUTER_OAUTH_PORT=4201/);
    assert.match(systemd, /MODEL_ROUTER_PORT=4202/);
    assert.match(systemd, /MODEL_ROUTER_API_PORT=4203/);

    const windows = render("service-windows.mjs", "win32", testRoot);
    assert.match(windows, /@echo off\r?\n/);
    assert.match(windows, /set "CODEX_ROUTER_STATE_DIR=/);
    assert.match(windows, /start-codex-router-env\.ps1/);
    assert.match(windows, /-WindowStyle Hidden -ExecutionPolicy Bypass -File/);
    assert.match(
      serviceCommand("service-windows.mjs", "win32", testRoot, "render-env-wrapper"),
      /start\.mjs/,
    );
    // The Python gateway must run with UTF-8 output even when the host
    // console code page is not UTF-8 (see service-windows.mjs).
    assert.match(windows, /set "PYTHONIOENCODING=utf-8"/);
    assert.match(windows, /set "PYTHONUTF8=1"/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Windows environment wrapper selects Nous without embedding its key", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-nous-env-'wrapper-"));
  try {
    const script = serviceCommand(
      "service-windows.mjs",
      "win32",
      testRoot,
      "render-env-wrapper",
    );

    assert.match(script, /enabled-providers\.json/);
    assert.match(script, /discovery-mode\.json/);
    assert.match(
      script,
      /\[Environment\]::GetEnvironmentVariable\('NOUS_API_KEY', 'User'\)/,
    );
    assert.match(
      script,
      /\[Environment\]::SetEnvironmentVariable\('NOUS_API_KEY', \$null, 'Process'\)/,
    );
    assert.match(
      script,
      /\[Environment\]::SetEnvironmentVariable\('NOUS_API_KEY', \$userKey, 'Process'\)/,
    );
    assert.match(script, /\$selectedNous = .*-contains 'nous'/);
    assert.match(script, /\$discoveryOverride = \$env:CODEX_ROUTER_NO_DISCOVERY/);
    assert.match(script, /if \(\$discoveryOverride -eq '1'\)/);
    assert.match(script, /\} elseif \(\$discoveryOverride -eq '0'\)/);
    assert.match(
      script,
      /\$discoveryOverride -eq '1'[\s\S]*?\$discoveryOverride -eq '0'[\s\S]*?Test-Path -LiteralPath \$discoveryModePath/,
    );
    assert.match(script, /if \(-not \$discoveryEnabled\)/);
    assert.match(script, /requires NOUS_API_KEY in the persistent user environment/);
    assert.match(script, /SetEnvironmentVariable\('NOUS_API_KEY', \$userKey, 'Process'\)\r?\n  \$userKey = \$null/);
    assert.match(script, /start\.mjs/);
    assert.match(script, /exit \$LASTEXITCODE/);
    assert.ok(
      script.includes(testRoot.replaceAll("'", "''")),
      "PowerShell paths must escape apostrophes in single-quoted literals",
    );

    const fakeKey = "nous-test-secret-value";
    assert.doesNotMatch(script, new RegExp(fakeKey));
    assert.doesNotMatch(script, /\$env:NOUS_API_KEY\s*=\s*['"][^'"]+['"]/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("legacy subagent cleanup opt-in reaches every background service", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-legacy-cleanup-"));
  const env = { CODEX_ROUTER_LEGACY_SUBAGENT_CLEANUP: "1" };
  try {
    const launchd = serviceCommand(
      "service-macos.mjs",
      "darwin",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.match(
      launchd,
      /<key>CODEX_ROUTER_LEGACY_SUBAGENT_CLEANUP<\/key>\s*<string>1<\/string>/,
    );

    const systemd = serviceCommand(
      "service-linux.mjs",
      "linux",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.match(
      systemd,
      /Environment="CODEX_ROUTER_LEGACY_SUBAGENT_CLEANUP=1"/,
    );

    const windows = serviceCommand(
      "service-windows.mjs",
      "win32",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.match(windows, /set "CODEX_ROUTER_LEGACY_SUBAGENT_CLEANUP=1"/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("packaged services preserve wrapper and PATH values with service-safe quoting", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-packaged-service-"));
  const stableRoot = path.join(testRoot, "opt % router", "libexec");
  const stableNode = path.join(testRoot, 'runtime "bin" %', "node wrapper");
  const servicePath = `${path.dirname(stableNode)}:${path.join(testRoot, "support & tools")}`;
  const env = {
    CODEX_ROUTER_SOURCE_ROOT: stableRoot,
    CODEX_ROUTER_NODE_BIN: stableNode,
    CODEX_ROUTER_PACKAGE_MANAGER: "homebrew",
    PATH: servicePath,
  };
  try {
    const launchd = serviceCommand(
      "service-macos.mjs",
      "darwin",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.ok(launchd.includes(`<string>${launchdXml(stableNode)}</string>`));
    assert.ok(
      launchd.includes(
        `<key>PATH</key>\n    <string>${launchdXml(servicePath)}</string>`,
      ),
    );
    assert.match(launchd, /<key>CODEX_ROUTER_SOURCE_ROOT<\/key>/);
    assert.match(launchd, /<key>CODEX_ROUTER_NODE_BIN<\/key>/);
    assert.match(launchd, /<string>homebrew<\/string>/);

    const systemd = serviceCommand(
      "service-linux.mjs",
      "linux",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.ok(systemd.includes(`WorkingDirectory=${stableRoot.replaceAll("%", "%%")}`));
    assert.ok(systemd.includes(`ExecStart=${systemdQuoted(stableNode)}`));
    assert.ok(systemd.includes(`Environment=${systemdQuoted(`PATH=${servicePath}`)}`));
    assert.ok(systemd.includes(`Environment="CODEX_ROUTER_PACKAGE_MANAGER=homebrew"`));
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the legacy Windows launcher starts the wrapper hidden and propagates its exit code", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-hidden-launcher-"));
  try {
    const stateDir = windowsStateDir(testRoot);
    assert.ok(stateDir.includes(" "), "the fixture state directory must contain a space");
    const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
    const script = serviceCommand("service-windows.mjs", "win32", testRoot, "render-launcher");

    assert.match(script, /^Option Explicit\r\n/);
    assert.match(script, /\r\nSet shell = CreateObject\("WScript\.Shell"\)\r\n/);
    // Window style 0 hides the wrapper's console; True waits for it so that
    // Run returns the wrapper's exit code instead of returning immediately.
    assert.ok(
      script.includes(
        `status = shell.Run("cmd.exe /D /C " & quote & quote & "${wrapperPath}" & quote & quote, 0, True)\r\n`,
      ),
      `launcher did not embed the wrapper path correctly:\n${script}`,
    );
    // Without this line Task Scheduler reads every crash as a clean exit and
    // the RestartCount/RestartInterval settings never fire again.
    assert.match(script, /\r\nWScript\.Quit status\r\n$/);
    // A failure to even start the wrapper must also surface as a failure.
    assert.match(script, /\r\nIf Err\.Number <> 0 Then\r\n {2}WScript\.Quit 1\r\nEnd If\r\n/);

    // Every generated line must be a valid VBScript statement: string literals
    // escape a double quote by doubling it, so quotes always come in pairs.
    for (const line of script.split("\r\n")) {
      assert.equal(
        (line.match(/"/g) || []).length % 2,
        0,
        `unbalanced quotes in generated line: ${line}`,
      );
    }
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Windows scheduled task runs the native supervisor without external arguments", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-task-action-"));
  try {
    const supervisorPath = path.join(
      windowsStateDir(testRoot),
      "start-codex-router-supervisor.exe",
    );
    const action = JSON.parse(
      serviceCommand("service-windows.mjs", "win32", testRoot, "render-task"),
    );

    assert.equal(action.execute, supervisorPath);
    assert.equal(action.argument, "");
    assert.match(action.execute, /start-codex-router-supervisor\.exe$/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// The scheduled task's restart policy is the reason the exit code matters:
// Task Scheduler only re-triggers RestartCount/RestartInterval when the action
// reports a failure, so a launcher that swallowed the wrapper's exit code would
// trade a console window for a router that stays dead after its first crash.
// Nothing off Windows can execute a .vbs, so -- exactly like
// `install.ps1 parses under powershell.exe` in test/installer-scripts.test.mjs --
// this is the only place that link is executed rather than reasoned about.
//
// wscript.exe with //B //NoLogo is the host for the legacy launcher renderer
// retained during migration. cscript.exe is the console host over the same
// script engine, and it runs without //B so that a broken launcher reports the
// parse or runtime error on stderr instead of arriving as an unexplained exit
// code.
const WINDOWS_SCRIPT_HOSTS = [
  { name: "cscript.exe", args: ["//NoLogo"] },
  { name: "wscript.exe", args: ["//B", "//NoLogo"] },
];

// Resolved absolutely: these live in the system directory, and naming them
// outright keeps the test independent of whatever PATH the runner supplies.
function scriptHost(name) {
  const systemDirectory =
    process.platform === "win32"
      ? execFileSync(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::SystemDirectory"],
          { encoding: "utf8" },
        ).trim()
      : path.join("C:\\Windows", "System32");
  return path.join(systemDirectory, name);
}

test(
  "the generated Windows launcher returns the wrapper's exit code to its script host",
  { skip: process.platform !== "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-vbs-exit-"));
    try {
      const stateDir = windowsStateDir(testRoot);
      mkdirSync(stateDir, { recursive: true });
      const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
      const launcherPath = path.join(stateDir, "start-codex-router-hidden.vbs");

      // The shipped generator produces the source. Only the encoding is
      // repeated here: `install` is the code path that writes the file, and
      // running it would register a real scheduled task on this machine.
      // `the Windows installer writes both launchers idempotently` asserts that
      // the shipped writer emits exactly these bytes.
      const source = serviceCommand(
        "service-windows.mjs",
        "win32",
        testRoot,
        "render-launcher",
      );
      const encoded = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(source, "utf16le"),
      ]);
      writeFileSync(launcherPath, encoded);

      const report = (host, result, expectation, note) =>
        [
          `host: ${host.name} ${host.args.join(" ")} "${launcherPath}"`,
          `expected exit code: ${expectation}`,
          `actual exit code: ${result.status}`,
          `terminating signal: ${result.signal ?? "none"}`,
          `spawn error: ${result.error ? result.error.message : "none"}`,
          `stdout: ${(result.stdout || "").trim() || "(empty)"}`,
          `stderr: ${(result.stderr || "").trim() || "(empty)"}`,
          note,
          "generated launcher source:",
          source,
        ].join("\n");

      const runLauncher = (host) => {
        const result = spawnSync(scriptHost(host.name), [...host.args, launcherPath], {
          encoding: "utf8",
          timeout: 60_000,
          windowsHide: true,
        });
        // A spawn failure or a timeout leaves status null, which would satisfy
        // the "not zero" assertion below without the launcher having run at all.
        assert.equal(
          typeof result.status,
          "number",
          report(host, result, "any number", "the script host did not run to completion"),
        );
        return result;
      };

      for (const host of WINDOWS_SCRIPT_HOSTS) {
        // A crashed router has to reach Task Scheduler as a failed run. 42 is
        // arbitrary and distinctive: it is neither the 1 a WSH script error
        // produces nor the 0 a silent success would.
        writeFileSync(wrapperPath, "@echo off\r\nexit /b 42\r\n");
        let result = runLauncher(host);
        assert.equal(
          result.status,
          42,
          report(host, result, 42, "the wrapper's exit code must reach the host unchanged"),
        );

        // ...and the reverse: a clean stop must not be reported as a failure,
        // or the task restarts a router that was deliberately shut down.
        writeFileSync(wrapperPath, "@echo off\r\nexit /b 0\r\n");
        result = runLauncher(host);
        assert.equal(
          result.status,
          0,
          report(host, result, 0, "a clean wrapper exit must not be reported as a failure"),
        );

        // A wrapper that cannot start at all must still fail. `On Error Resume
        // Next` without the Err.Number guard leaves `status` unset, and
        // `WScript.Quit` on an unset value exits 0 -- which is the shape that
        // silently disables the restart policy. cmd.exe itself reports this
        // particular failure; the Err.Number branch covers a cmd.exe that will
        // not start, which no ordinary host can reproduce because CreateProcess
        // resolves it from the system directory whatever PATH says.
        rmSync(wrapperPath);
        result = runLauncher(host);
        assert.notEqual(
          result.status,
          0,
          report(host, result, "anything but 0", "a wrapper that never ran must not report success"),
        );
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test("the Windows service installs a staged protected supervisor action", () => {
  const source = readFileSync(path.join(root, "src", "service-windows.mjs"), "utf8");
  assert.match(source, /supervisorCompilerExecutablePath/);
  assert.doesNotMatch(source, /process\.env\.SystemRoot/);
  assert.match(source, /\/target:winexe/);
  assert.match(source, /compileSupervisor\(\)/);
  assert.match(source, /stagedLaunchers = writeLaunchers\(\)/);
  assert.match(source, /endTask\(previous\);\s*promoteLaunchers\(stagedLaunchers\)/s);
  assert.match(source, /installTask\(\);[\s\S]*schtasks\(\["\/Run"/s);
  assert.match(source, /captureManagedFileSnapshot/);
  assert.match(source, /restoreManagedFileSnapshot/);
  assert.match(source, /restart: previous\.state === "running"/);
  assert.match(source, /The existing Windows service task is foreign or malformed/);
  assert.match(source, /process\.exitCode = 1/);
  assert.match(source, /stageProtectedLauncher\(wrapperPath/);
  assert.match(source, /privateFileIsProtected\(target\)/);
  assert.match(source, /\[supervisorPath, launcherPath, wrapperPath, powerShellWrapperPath\]/);
  const supervisor = readFileSync(path.join(root, "src", "windows-service-supervisor.cs"), "utf8");
  assert.match(supervisor, /JobObjectLimitKillOnJobClose/);
  assert.match(supervisor, /Environment\.SystemDirectory/);
  assert.doesNotMatch(supervisor, /GetEnvironmentVariable\("SystemRoot"/);
  assert.match(supervisor, /IndexOf\('%'\)/);
});

// Off Windows there is no schtasks.exe or powershell.exe, so every scheduler
// call src/service-windows.mjs makes is a failure and the ordering between them
// is invisible. Executable stubs of those names, first on PATH, make the whole
// sequence observable and let one call be failed on demand -- which is the only
// way to reach the recovery path without a Windows box and a restricted shell.
// They can never shadow the real executables, because the tests that use them
// are skipped on win32.
function schedulerStubs(directory, options = {}) {
  const {
    schtasksFail = "",
    schtasksFailOnce = "",
    powershellFail = "",
    runningQueries = 0,
    initialTask = "missing",
    initialAction = "native",
    initialPrincipal = "fixture-user",
  } = options;
  mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, "calls.log");
  const counterPath = path.join(directory, "state-queries");
  const taskStatePath = path.join(directory, "task-state");
  const taskActionPath = path.join(directory, "task-action");
  const failOncePath = path.join(directory, "schtasks-fail-once");
  writeFileSync(taskStatePath, `${initialTask}\n`);
  writeFileSync(taskActionPath, `${initialAction}\n`);
  const preamble = (fail) =>
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${logPath}"`,
      `for pattern in ${fail}; do`,
      '  case "$*" in *"$pattern"*) exit 1 ;; esac',
      "done",
    ].join("\n");
  const preambleOnce = (patterns) =>
    patterns
      ? [
          `for pattern in ${patterns}; do`,
          `  case "$*" in *"$pattern"*) if [ ! -f "${failOncePath}" ]; then : > "${failOncePath}"; exit 1; fi ;; esac`,
          "done",
        ].join("\n")
      : "";

  writeFileSync(
    path.join(directory, "schtasks.exe"),
    [
      preamble(schtasksFail),
      preambleOnce(schtasksFailOnce),
      `state_file="${taskStatePath}"`,
      `action_file="${taskActionPath}"`,
      'state=$(cat "$state_file" 2>/dev/null || printf missing)',
      'case "$*" in',
      '  */End*) [ "$state" = missing ] && exit 1; printf ready > "$state_file"; exit 0 ;;',
      '  */Delete*) printf missing > "$state_file"; exit 0 ;;',
      '  */Create*) printf present > "$state_file"; printf native > "$action_file"; exit 0 ;;',
      '  */Run*) [ "$state" = missing ] && exit 1; printf running > "$state_file"; exit 0 ;;',
      '  */Query*) [ "$state" = missing ] && exit 1; case "$*" in */XML*) printf \'<Task><RegistrationInfo/><Principals/><Actions/></Task>\' ;; esac; exit 0 ;;',
      'esac',
      "exit 0",
      "",
    ].join("\n"),
  );
  // taskState() reads the task state off this process's stdout. The counter is
  // what lets a test say "report Running for the first N queries", so the stop
  // wait can be observed polling and then finishing.
  writeFileSync(
    path.join(directory, "powershell.exe"),
    [
      preamble(powershellFail),
      'case "$*" in',
      '  *Register-ScheduledTask*) printf present > "' + taskStatePath + '"; printf native > "' + taskActionPath + '"; exit 0 ;;',
      '  *ConvertTo-Json*)',
      `    state=$(cat "${taskStatePath}" 2>/dev/null || printf missing)`,
      '    if [ "$state" = missing ]; then printf \'{"kind":"missing"}\'; else',
      `      action=$(cat "${taskActionPath}" 2>/dev/null || printf native)`,
      `      execute="$CODEX_ROUTER_STATE_DIR/start-codex-router-supervisor.exe"`,
      '      argument=""',
      '      if [ "$action" = legacy ]; then execute=wscript.exe; argument=$(printf \'//B //NoLogo "%s/start-codex-router-hidden.vbs"\' "$CODEX_ROUTER_STATE_DIR"); elif [ "$action" = foreign ]; then execute=foreign.exe; argument=--foreign; fi',
      '      escaped=$(printf \'%s\' "$argument" | sed \'s/"/\\\\"/g\')',
      `      printf '{"kind":"present","principal":"${initialPrincipal}","currentPrincipal":"fixture-user","currentSid":"","actions":[{"execute":"%s","argument":"%s"}]}' "$execute" "$escaped"`,
      '    fi; exit 0 ;;',
      "  *Get-ScheduledTask*)",
      "    count=0",
      `    if [ -f "${counterPath}" ]; then count=$(cat "${counterPath}"); fi`,
      "    count=$((count + 1))",
      `    printf '%s' "$count" > "${counterPath}"`,
      `    if [ "$count" -le ${runningQueries} ]; then printf 'Running'; else printf 'Ready'; fi`,
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  // service-windows.mjs compiles the native supervisor before it touches the
  // task. These tests run only off Windows, where the OS compiler is absent;
  // the stub creates a non-executable placeholder so scheduler ordering stays
  // observable without pretending to prove the native binary.
  writeFileSync(
    path.join(directory, "csc.exe"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${logPath}"`,
      "for argument in \"$@\"; do",
      "  case \"$argument\" in /out:*) output=\"${argument#/out:}\" ;; esac",
      "done",
      "[ -n \"${output:-}\" ] || exit 1",
      "printf '%s' 'fixture supervisor placeholder' > \"$output\"",
      "exit 0",
      "",
    ].join("\n"),
  );

  for (const name of ["schtasks.exe", "powershell.exe", "csc.exe"]) {
    chmodSync(path.join(directory, name), 0o755);
  }
  return {
    path: `${directory}${path.delimiter}${process.env.PATH}`,
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").filter(Boolean)
        : [],
  };
}

function runWindowsService(testRoot, command, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [path.join(root, "src", "service-windows.mjs"), command],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...serviceEnv("win32", testRoot), ...extraEnv },
    },
  );
}

test(
  "a run failure restores the recognized task and reports failure",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-recover-"));
    try {
      // A failed first run must restore the exact recognized task definition,
      // but still return failure so the caller cannot mistake rollback for a
      // successful native installation.
      const stubs = schedulerStubs(path.join(testRoot, "survivor"), {
        schtasksFailOnce: "/Run",
        initialTask: "present",
        runningQueries: 1,
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");

      const calls = stubs.calls();
      const at = (needle) => calls.findIndex((line) => line.includes(needle));
      assert.ok(at("/End") >= 0, `no /End in:\n${calls.join("\n")}`);
      assert.ok(
        at("/End") < at("Register-ScheduledTask"),
        `the running instance must be ended before re-registering:\n${calls.join("\n")}`,
      );
      assert.ok(
        calls.filter((line) => line.includes("/Create")).length >= 1,
        `rollback must recreate the prior XML definition:\n${calls.join("\n")}`,
      );
      assert.equal(calls.filter((line) => line.includes("/Run")).length, 2);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "a registration failure that leaves no task does not start one",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-no-task-"));
    try {
      const stubs = schedulerStubs(path.join(testRoot, "gone"), {
        schtasksFail: "/Create /Query",
        powershellFail: "Register-ScheduledTask",
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");

      const calls = stubs.calls();
      assert.ok(calls.some((line) => line.includes("/Query")));
      assert.equal(
        calls.some((line) => line.includes("/Run")),
        false,
        `nothing survived to start, so /Run must not be issued:\n${calls.join("\n")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "a foreign same-named task is refused before any scheduler mutation",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-foreign-"));
    try {
      const stubs = schedulerStubs(path.join(testRoot, "foreign"), {
        initialTask: "present",
        initialAction: "foreign",
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.notEqual(result.status, 0, "foreign task refusal must be nonzero");
      assert.match(result.stderr, /foreign or malformed/);
      const calls = stubs.calls();
      assert.equal(calls.some((line) => line.includes("/End")), false);
      assert.equal(calls.some((line) => line.includes("/Create")), false);
      assert.equal(calls.some((line) => line.includes("/Delete")), false);
      assert.equal(calls.some((line) => line.includes("/Run")), false);
      assert.equal(calls.some((line) => line.includes("csc.exe")), false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "install waits for the ended instance before starting the new one",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-stop-wait-"));
    try {
      // schtasks /End returns before the instance is gone. Reporting Running
      // for the first two state queries reproduces that window; a /Run issued
      // inside it is dropped by MultipleInstances IgnoreNew.
      const stubs = schedulerStubs(path.join(testRoot, "winding-down"), {
        runningQueries: 2,
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);

      const calls = stubs.calls();
      const states = calls.filter((line) => line.includes("Get-ScheduledTask"));
      assert.equal(
        states.length,
        3,
        `the wait must poll until the state leaves Running:\n${calls.join("\n")}`,
      );
      const lastState = calls.findLastIndex((line) => line.includes("Get-ScheduledTask"));
      assert.ok(
        lastState < calls.findIndex((line) => line.includes("/Run")),
        `the new instance must start after the old one has gone:\n${calls.join("\n")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "an instance that never stops cannot hang the install",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-stuck-"));
    try {
      // The state never leaves Running, so only the deadline can end the wait.
      // Without it install would block forever and take the installer with it.
      const stubs = schedulerStubs(path.join(testRoot, "stuck"), {
        runningQueries: 1_000_000,
        initialTask: "present",
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.notEqual(result.status, 0, result.stderr);

      const calls = stubs.calls();
      const states = calls.filter((line) => line.includes("Get-ScheduledTask"));
      assert.ok(states.length > 1, "the wait must have polled more than once");
      assert.ok(
        states.length < 500,
        `the wait must be bounded, not merely slow: ${states.length} state queries`,
      );
      assert.equal(
        calls.some((line) => line.includes("/Run")),
        false,
        `a task whose old instance cannot be proven stopped must not be replaced:\n${calls.join("\n")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "stopping a service that was never installed is not an error",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-stop-"));
    try {
      // No stubs on PATH, so schtasks.exe is missing exactly as it is when the
      // task does not exist. stop used to throw that straight at the caller
      // while uninstall and restart tolerated it.
      const result = runWindowsService(testRoot, "stop");
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { state: "stopped" });
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "systemd WorkingDirectory is unquoted and escapes literal specifiers",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-systemd-path-"));
    const linkedRoot = path.join(testRoot, "router %u");
    symlinkSync(root, linkedRoot, "dir");
    try {
      const systemd = render("service-linux.mjs", "linux", testRoot, "codex", linkedRoot);
      const workingDirectory = systemd
        .split(/\r?\n/)
        .find((line) => line.startsWith("WorkingDirectory="));
      assert.equal(
        workingDirectory,
        `WorkingDirectory=${linkedRoot.replaceAll("%", "%%")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
