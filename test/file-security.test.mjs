import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  privateFileIsProtected,
  protectPrivateFile,
  writePrivateJson,
} from "../src/file-security.mjs";

test("private JSON state uses one owner-only atomic writer", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-private-json-"));
  const target = path.join(directory, "state.json");
  const value = { version: 1, enabled: true };
  try {
    assert.deepEqual(writePrivateJson(target, value, { directoryMode: 0o700 }), value);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), value);
    if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Windows private paths reject extra grants and restore an exact owner ACL",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-acl-"));
    const target = path.join(directory, "private.secret");
    writeFileSync(target, "TEST_ONLY\n");
    try {
      for (const candidate of [directory, target]) {
        protectPrivateFile(candidate);
        assert.equal(privateFileIsProtected(candidate), true);
        execFileSync(
          "icacls.exe",
          [candidate, "/grant", "*S-1-1-0:(R)"],
          { stdio: "ignore" },
        );
        assert.equal(privateFileIsProtected(candidate), false);
        protectPrivateFile(candidate);
        assert.equal(privateFileIsProtected(candidate), true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
