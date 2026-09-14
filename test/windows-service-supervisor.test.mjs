import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const systemDirectory = windows
  ? execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::SystemDirectory"],
      { encoding: "utf8" },
    ).trim()
  : path.join("C:\\Windows", "System32");
const system32 = systemDirectory;
const powershell = path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
const schtasks = path.join(system32, "schtasks.exe");
const compiler = path.join(path.dirname(systemDirectory), "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const supervisorSource = path.join(root, "src", "windows-service-supervisor.cs");

function runPowerShell(script, env = {}) {
  return execFileSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fixtureProcessesPresent(pids) {
  const ids = pids.map((pid) => Number(pid));
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "try { $ids = @($env:FIXTURE_PIDS -split ','); $found = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $ids -contains [string]$_.ProcessId } | Select-Object -ExpandProperty ProcessId); [Console]::Out.Write(($found -join ',')) } catch { exit 2 }",
    ],
    { encoding: "utf8", env: { ...process.env, FIXTURE_PIDS: ids.join(",") } },
  );
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || "unable to query fixture process state");
  }
  const found = new Set(
    result.stdout
      .trim()
      .split(",")
      .filter(Boolean)
      .map((pid) => Number(pid)),
  );
  return ids.map((pid) => found.has(pid));
}

async function waitForFixtureExit(pids, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let present = fixtureProcessesPresent(pids);
  while (Date.now() < deadline && present.some(Boolean)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    present = fixtureProcessesPresent(pids);
  }
  return present;
}

async function waitForFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return existsSync(file);
}

function registerFixtureTask(taskName, executable, argument = "") {
  runPowerShell(
    [
      "$action = if ([string]::IsNullOrEmpty($env:FIXTURE_ARGUMENT)) { New-ScheduledTaskAction -Execute $env:FIXTURE_EXECUTE } else { New-ScheduledTaskAction -Execute $env:FIXTURE_EXECUTE -Argument $env:FIXTURE_ARGUMENT }",
      "$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
      "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew",
      "$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
      "Register-ScheduledTask -TaskName $env:FIXTURE_TASK -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null",
    ].join("; "),
    { FIXTURE_TASK: taskName, FIXTURE_EXECUTE: executable, FIXTURE_ARGUMENT: argument },
  );
}

function endFixtureTask(taskName) {
  try {
    execFileSync(schtasks, ["/End", "/TN", taskName], { stdio: "ignore" });
  } catch {
    // The task may already be stopped during a failed fixture assertion.
  }
}

function deleteFixtureTask(taskName) {
  try {
    execFileSync(schtasks, ["/Delete", "/TN", taskName, "/F"], { stdio: "ignore" });
  } catch {
    // The task may already have been removed during cleanup.
  }
}

function fixtureTaskDetails(taskName) {
  try {
    return execFileSync(schtasks, ["/Query", "/TN", taskName, "/FO", "LIST", "/V"], {
      encoding: "utf8",
    });
  } catch (error) {
    return error.stdout || error.stderr || error.message;
  }
}

test(
  "Windows task owner normalization resolves a short principal to the current SID",
  { skip: !windows },
  () => {
    const record = JSON.parse(
      runPowerShell(
        "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $account = New-Object Security.Principal.NTAccount($env:USERNAME); $sid = $account.Translate([Security.Principal.SecurityIdentifier]).Value; [Console]::Out.Write(( [pscustomobject]@{ short = $env:USERNAME; principalSid = $sid; currentSid = $identity.User.Value } | ConvertTo-Json -Compress ))",
      ),
    );
    assert.equal(record.principalSid, record.currentSid);
    assert.equal(record.short.length > 0, true);
  },
);

test(
  "native supervisor keeps its temporary task descendants in an owned job",
  { skip: !windows, timeout: 90_000 },
  async () => {
    assert.ok(existsSync(compiler), `missing OS C# compiler: ${compiler}`);
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-supervisor-fixture-"));
    const supervisor = path.join(fixtureRoot, "start-codex-router-supervisor.exe");
    const wrapper = path.join(fixtureRoot, "start-codex-router.cmd");
    const legacyLauncher = path.join(fixtureRoot, "start-codex-router-hidden.vbs");
    const childScript = path.join(fixtureRoot, "child.ps1");
    const grandchildScript = path.join(fixtureRoot, "grandchild.ps1");
    const marker = path.join(fixtureRoot, "processes.json");
    const ready = path.join(fixtureRoot, "ready");
    const stop = path.join(fixtureRoot, "stop");
    const taskPrefix = `Codex Router Supervisor Fixture ${process.pid}-${Date.now()}`;

    try {
      writeFileSync(
        grandchildScript,
        [
          "$ErrorActionPreference = 'Stop'",
          `$stop = ${psLiteral(stop)}`,
          "while (-not (Test-Path -LiteralPath $stop)) { Start-Sleep -Milliseconds 100 }",
          "",
        ].join("\r\n"),
        "utf8",
      );
      writeFileSync(
        childScript,
        [
          "$ErrorActionPreference = 'Stop'",
          `$grandchild = Start-Process -FilePath ${psLiteral(powershell)} -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psLiteral(grandchildScript)}) -WindowStyle Hidden -PassThru`,
          `$record = @{ childPid = $PID; grandchildPid = $grandchild.Id } | ConvertTo-Json -Compress`,
          `[IO.File]::WriteAllText(${psLiteral(marker)}, $record)`,
          `[IO.File]::WriteAllText(${psLiteral(ready)}, 'ready')`,
          `$stop = ${psLiteral(stop)}`,
          "while (-not (Test-Path -LiteralPath $stop) -and -not $grandchild.HasExited) { Start-Sleep -Milliseconds 100 }",
          "try { $grandchild.WaitForExit(5000) } catch { }",
          "",
        ].join("\r\n"),
        "utf8",
      );
      writeFileSync(
        wrapper,
        [
          "@echo off",
          `"${powershell}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${childScript}"`,
          "exit /b %ERRORLEVEL%",
          "",
        ].join("\r\n"),
        "utf8",
      );
      execFileSync(
        compiler,
        [
          "/nologo",
          "/target:winexe",
          "/optimize+",
          "/platform:x64",
          `/out:${supervisor}`,
          supervisorSource,
        ],
        { stdio: "ignore" },
      );
      assert.equal(existsSync(supervisor), true);

      const percentRoot = path.join(fixtureRoot, "percent%path");
      mkdirSync(percentRoot);
      const percentSupervisor = path.join(percentRoot, "start-codex-router-supervisor.exe");
      copyFileSync(supervisor, percentSupervisor);
      copyFileSync(wrapper, path.join(percentRoot, "start-codex-router.cmd"));
      const percentRun = spawnSync(percentSupervisor, [], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
      assert.equal(typeof percentRun.status, "number");
      assert.notEqual(percentRun.status, 0, "the native supervisor must reject percent-bearing paths");

      // Render the shipped legacy action instead of copying its implementation
      // into this fixture. It is the reproduction control for the orphan bug.
      const legacySource = execFileSync(
        process.execPath,
        [path.join(root, "src", "service-windows.mjs"), "render-launcher"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: path.join(fixtureRoot, "codex-home"),
            MODEL_ROUTER_STATE_DIR: fixtureRoot,
            CODEX_ROUTER_SERVICE_PLATFORM: "win32",
          },
        },
      );
      writeFileSync(legacyLauncher, legacySource, "utf8");

      const runTaskVariant = async ({ taskName, execute, argument, expectedAfterEnd }) => {
        const pids = [];
        for (const file of [marker, ready, stop]) rmSync(file, { force: true });
        try {
          registerFixtureTask(taskName, execute, argument);
          execFileSync(schtasks, ["/Run", "/TN", taskName], { stdio: "ignore" });
          assert.equal(
            await waitForFile(ready, 15_000),
            true,
            `fixture child never reached readiness\n${fixtureTaskDetails(taskName)}`,
          );
          const record = JSON.parse(readFileSync(marker, "utf8"));
          pids.push(record.childPid, record.grandchildPid);
          assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 0));
          assert.deepEqual(
            fixtureProcessesPresent(pids),
            [true, true],
            "fixture descendants were not running before /End",
          );

          endFixtureTask(taskName);
          if (expectedAfterEnd) {
            // The legacy VBS action is expected to reproduce the defect: the
            // scheduled action ends while its CMD/PowerShell descendants live.
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            assert.deepEqual(
              fixtureProcessesPresent(pids),
              [true, true],
              "legacy /End unexpectedly quiesced its detached descendants",
            );
          } else {
            assert.deepEqual(
              await waitForFixtureExit(pids),
              [false, false],
              "native supervisor /End must quiesce every owned descendant",
            );
          }
        } finally {
          endFixtureTask(taskName);
          writeFileSync(stop, "stop\r\n", "utf8");
          if (pids.length) {
            assert.deepEqual(
              await waitForFixtureExit(pids, 5_000),
              [false, false],
              "fixture cleanup could not quiesce its own marked descendants",
            );
          }
          deleteFixtureTask(taskName);
        }
      };

      await runTaskVariant({
        taskName: `${taskPrefix} Legacy`,
        execute: "wscript.exe",
        argument: `//B //NoLogo "${legacyLauncher}"`,
        expectedAfterEnd: true,
      });
      await runTaskVariant({
        taskName: `${taskPrefix} Native`,
        execute: supervisor,
        argument: "",
        expectedAfterEnd: false,
      });
    } finally {
      writeFileSync(stop, "stop\r\n", "utf8");
      deleteFixtureTask(`${taskPrefix} Legacy`);
      deleteFixtureTask(`${taskPrefix} Native`);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);
