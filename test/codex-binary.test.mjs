import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { codexAuthStatus, findCodexBinary, preferSpawnablePath, spawnableCommand } from "../src/codex-binary.mjs";

// Reported in #46: `where.exe codex` on an npm global install lists the
// extensionless POSIX shim before the batch shim. Node cannot spawn the former
// without a shell, so taking the first line made every Codex probe throw
// ENOENT. That was then read as "signed out", which stripped every native
// model from the catalog with no error surfaced.
const NPM_WHERE_OUTPUT = [
  "C:\\Users\\krist\\AppData\\Roaming\\npm\\codex",
  "C:\\Users\\krist\\AppData\\Roaming\\npm\\codex.cmd",
  "",
];

test("prefers the spawnable shim over the extensionless one on Windows", () => {
  assert.equal(
    preferSpawnablePath(NPM_WHERE_OUTPUT, "win32"),
    "C:\\Users\\krist\\AppData\\Roaming\\npm\\codex.cmd",
  );
});

test("prefers a real executable over a batch shim when both are on PATH", () => {
  assert.equal(
    preferSpawnablePath(["C:\\shim\\codex.cmd", "C:\\real\\codex.exe"], "win32"),
    "C:\\real\\codex.exe",
  );
});

test("keeps the first match on POSIX, where every entry is spawnable", () => {
  assert.equal(
    preferSpawnablePath(["/opt/homebrew/bin/codex", "/usr/local/bin/codex"], "darwin"),
    "/opt/homebrew/bin/codex",
  );
});

test("falls back to the first entry when nothing looks spawnable", () => {
  assert.equal(preferSpawnablePath(["C:\\odd\\codex"], "win32"), "C:\\odd\\codex");
});

test("ignores blank lines in finder output", () => {
  assert.equal(
    preferSpawnablePath(["", "   ", "/opt/homebrew/bin/codex"], "darwin"),
    "/opt/homebrew/bin/codex",
  );
});

test("returns undefined for empty finder output", () => {
  assert.equal(preferSpawnablePath([], "win32"), undefined);
  assert.equal(preferSpawnablePath(["", "   "], "darwin"), undefined);
});

test("a Windows batch shim runs through cmd.exe with its path escaped", () => {
  // cmd.exe splits on spaces and Codex is routinely installed under a profile
  // directory that contains them.
  const target = spawnableCommand("C:\\Program Files\\npm\\codex.cmd", ["login"], "win32");
  assert.match(target.command, /cmd\.exe$/i);
  assert.equal(target.args[0], "/d");
  assert.equal(target.args[2], "/c");
  assert.match(target.args[3], /C:\\Program\^ Files\\npm\\codex\.cmd/);
  assert.equal(target.options.windowsVerbatimArguments, true);
});

test("a Windows .exe is spawned directly, without a shell", () => {
  const target = spawnableCommand("C:\\Programs\\Codex\\codex.exe", ["login"], "win32");
  assert.equal(target.command, "C:\\Programs\\Codex\\codex.exe");
  assert.deepEqual(target.args, ["login"]);
  assert.deepEqual(target.options, {});
});

test("a POSIX binary never gets a shell, even if it ends in .cmd", () => {
  assert.deepEqual(spawnableCommand("/opt/homebrew/bin/codex", ["login"], "darwin"), {
    command: "/opt/homebrew/bin/codex",
    args: ["login"],
    options: {},
  });
  assert.deepEqual(spawnableCommand("/weird/path/codex.cmd", [], "darwin").options, {});
});

test(
  "finds the newest Codex Desktop App bundled CLI on Windows",
  { skip: process.platform !== "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-desktop-cli-"));
    const binDir = path.join(testRoot, "OpenAI", "Codex", "bin");
    const oldVersion = path.join(binDir, "aaa111", "codex.exe");
    const newVersion = path.join(binDir, "bbb222", "codex.exe");
    mkdirSync(path.dirname(oldVersion), { recursive: true });
    mkdirSync(path.dirname(newVersion), { recursive: true });
    writeFileSync(oldVersion, "");
    writeFileSync(newVersion, "");
    const past = new Date(Date.now() - 60_000);
    utimesSync(oldVersion, past, past);
    utimesSync(newVersion, new Date(), new Date());

    const saved = {
      CODEX_BIN: process.env.CODEX_BIN,
      CODEX_INSTALL_DIR: process.env.CODEX_INSTALL_DIR,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
    };
    try {
      delete process.env.CODEX_BIN;
      delete process.env.CODEX_INSTALL_DIR;
      process.env.LOCALAPPDATA = testRoot;
      assert.equal(findCodexBinary(), newVersion);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

// A nonzero process exit alone must never remove native models. Use executable
// fixtures to exercise the actual spawn/error path without touching auth.
for (const [label, output, status, reason] of [
  ["authenticated", "Logged in using ChatGPT", 0, "authenticated"],
  ["signed out", "Not logged in", 1, "signed-out"],
  ["old CLI configuration error", "Error loading configuration: invalid type: map, expected a boolean", 1, "probe-failed"],
  ["unexplained nonzero exit", "", 1, "probe-failed"],
  ["failed launcher", "Not logged in", 2, "probe-failed"],
]) {
  test(`auth probe distinguishes ${label}`, { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "codex-auth-probe-"));
    const binary = path.join(root, "codex");
    writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${output}' >&2\nexit ${status}\n`, { mode: 0o700 });
    const saved = process.env.CODEX_BIN;
    try {
      process.env.CODEX_BIN = binary;
      const result = codexAuthStatus();
      assert.equal(result.reason, reason);
      assert.equal(result.authenticated, status === 0);
      assert.equal(result.binary, binary);
      assert.equal("stderr" in result, false);
      assert.equal("stdout" in result, false);
    } finally {
      if (saved === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("active PATH CLI outranks legacy global installs while CODEX_BIN still wins", { skip: process.platform !== "linux" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-path-priority-"));
  const binary = path.join(root, "codex");
  const explicit = path.join(root, "explicit-codex");
  for (const file of [binary, explicit]) writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const saved = Object.fromEntries(["CODEX_BIN", "CODEX_INSTALL_DIR", "PATH"].map((key) => [key, process.env[key]]));
  try {
    delete process.env.CODEX_BIN;
    delete process.env.CODEX_INSTALL_DIR;
    process.env.PATH = `${root}${path.delimiter}${saved.PATH}`;
    assert.equal(findCodexBinary(), binary);
    process.env.CODEX_BIN = explicit;
    assert.equal(findCodexBinary(), explicit);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
