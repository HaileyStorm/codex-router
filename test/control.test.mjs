import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pickerCommandArgs } from "../src/control-args.mjs";
import { privateFileIsProtected, protectPrivateFile } from "../src/file-security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

function probe(target, providers, usageEvents = [], options = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-probe-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers })}\n`,
    { mode: 0o600 },
  );
  if (usageEvents.length) {
    writeFileSync(
      path.join(stateDir, "usage-events.jsonl"),
      `${usageEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  if (options.nativeModels) {
    writeFileSync(
      path.join(stateDir, "native-models.json"),
      `${JSON.stringify({ models: options.nativeModels })}\n`,
      { mode: 0o600 },
    );
  }
  if (options.subagentSettings) {
    writeFileSync(
      path.join(stateDir, "multi-agent-settings.json"),
      `${JSON.stringify({ version: 2, ...options.subagentSettings })}\n`,
      { mode: 0o600 },
    );
  }
  if (options.selectedModel) {
    writeFileSync(
      path.join(stateDir, "config.toml"),
      `model = ${JSON.stringify(options.selectedModel)}\n`,
      { mode: 0o600 },
    );
  }
  if (options.loginFree) {
    writeFileSync(
      path.join(stateDir, "config.toml"),
      `model = ${JSON.stringify(options.selectedModel || "deepseek/deepseek-v4-pro")}\nmodel_provider = "codex-router"\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(stateDir, "codex-provider-mode.json"),
      `${JSON.stringify({
        version: 1,
        previousPresent: false,
        previousModelPresent: false,
      })}\n`,
      { mode: 0o600 },
    );
  }
  try {
    const output = execFileSync(process.execPath, [path.join(root, "src", "control.mjs"), "--probe"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: stateDir,
        MODEL_ROUTER_TARGET: target,
        MODEL_ROUTER_STATE_DIR: stateDir,
        CODEX_ROUTER_TOOL_RESULT_AGING: "1",
      },
    });
    return JSON.parse(output);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("codex probe reports enabled models", () => {
  const slice = probe("codex", ["deepseek"]);
  assert.equal(slice.target, "codex");
  const deepseek = slice.models.filter((m) => m.provider === "deepseek");
  assert.ok(deepseek.length > 0 && deepseek.every((m) => m.enabled));
});

test("codex probe folds protocol variants into one provider family", () => {
  const slice = probe("codex", ["opencode-go"]);
  // Models served by the messages/responses variants group under the family
  // id, so the tray renders a single opencode Go row.
  const family = slice.models.filter((m) => m.provider === "opencode-go");
  assert.ok(family.length > 0 && family.every((m) => m.enabled));
  assert.ok(!slice.models.some((m) => m.provider.startsWith("opencode-go-")));
  const providerIds = slice.providers.map((p) => p.id);
  assert.ok(providerIds.includes("opencode-go"));
  assert.ok(!providerIds.some((id) => id.startsWith("opencode-go-")));
});

test("codex probe folds Command Code protocol variants into one provider family", () => {
  const slice = probe("codex", ["commandcode"]);
  const family = slice.models.filter((m) => m.provider === "commandcode");
  assert.ok(family.length > 0 && family.every((m) => m.enabled));
  assert.ok(!slice.models.some((m) => m.provider.startsWith("commandcode-")));
  const providerIds = slice.providers.map((p) => p.id);
  assert.ok(providerIds.includes("commandcode"));
  assert.ok(!providerIds.some((id) => id.startsWith("commandcode-")));
});

test("codex probe exposes only privacy-safe recent usage events", () => {
  const event = {
    at: new Date().toISOString(),
    model: "grok-oauth/grok-4.5",
    provider: "grok-oauth",
    status: 200,
    durationMs: 1234,
    prompt: "must not escape the private event store",
  };
  const slice = probe("codex", ["grok-oauth"], [event]);
  assert.deepEqual(slice.usageEvents, [{
    at: event.at,
    model: event.model,
    provider: event.provider,
    status: event.status,
    durationMs: event.durationMs,
  }]);
  assert.equal("prompt" in slice.usageEvents[0], false);
  assert.equal("response" in slice.usageEvents[0], false);
});

test("codex probe includes native GPT models and the configured default", () => {
  const slice = probe("codex", ["grok-oauth"], [], {
    selectedModel: "gpt-5.6-terra",
    nativeModels: [
      {
        slug: "gpt-5.6-terra",
        display_name: "GPT-5.6-Terra",
        visibility: "list",
      },
      {
        slug: "codex-auto-review",
        display_name: "Codex Auto Review",
        visibility: "hide",
      },
    ],
  });

  assert.equal(slice.selectedModel, "gpt-5.6-terra");
  assert.deepEqual(
    slice.models.find((model) => model.slug === "gpt-5.6-terra"),
    {
      slug: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      provider: "openai",
      gatewayModel: "gpt-5.6-terra",
      enabled: true,
      native: true,
      multiAgentVersion: "v1",
      visible: true,
    },
  );
  assert.equal(slice.models.some((model) => model.slug === "codex-auto-review"), false);
  assert.equal(slice.loginFree, false);
  assert.equal(slice.loginFreeManaged, false);
  assert.equal(slice.modelSettings.picker.hidden.length, 0);
  assert.ok(["all", "selected", "proven"].includes(slice.modelSettings.subagents.mode));
  // Routed compaction is default-on; native remains a separate setting.
  assert.equal(slice.modelSettings.toolResultAging.enabled, true);
  // The panel's periodic refresh reads this snapshot, not `local-models
  // list`, so the LM Studio section has to ride here or it paints once and
  // vanishes on the next poll.
  assert.equal(slice.modelSettings.localModels.lmstudio.provider, "lmstudio");
  assert.equal(typeof slice.modelSettings.localModels.lmstudio.reachable, "boolean");
  assert.ok(Array.isArray(slice.modelSettings.localModels.lmstudio.models));
});

test("codex probe reports the effective v2 state of selected native GPT models", () => {
  const slice = probe("codex", [], [], {
    nativeModels: [
      {
        slug: "gpt-5.6-terra",
        display_name: "GPT-5.6-Terra",
        visibility: "list",
        multi_agent_version: "v1",
      },
      {
        slug: "gpt-5.6-luna",
        display_name: "GPT-5.6-Luna",
        visibility: "list",
        multi_agent_version: "v1",
      },
    ],
    subagentSettings: {
      mode: "selected",
      enabled: ["gpt-5.6-terra"],
      disabled: [],
    },
  });

  assert.equal(
    slice.models.find((model) => model.slug === "gpt-5.6-terra")?.multiAgentVersion,
    "v2",
  );
  assert.equal(
    slice.models.find((model) => model.slug === "gpt-5.6-luna")?.multiAgentVersion,
    "v2",
  );
});

test("codex probe exposes managed login-free mode without credential details", () => {
  const slice = probe("codex", ["deepseek"], [], { loginFree: true });
  assert.equal(slice.loginFree, true);
  assert.equal(slice.loginFreeManaged, true);
  assert.equal(JSON.stringify(slice).includes("previousModelProvider"), false);
});

test("control exposes subagent and picker settings without credentials", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-settings-"));
  try {
    const env = {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: stateDir,
    };
    const subagents = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "subagents", "status"],
        { cwd: root, encoding: "utf8", env },
      ),
    );
    assert.ok(["all", "selected", "proven"].includes(subagents.mode));
    assert.ok(Array.isArray(subagents.enabled));
    assert.ok(Array.isArray(subagents.disabled));

    const picker = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "picker", "status"],
        { cwd: root, encoding: "utf8", env },
      ),
    );
    assert.deepEqual(picker.hidden, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("control toggles tool-result aging without a router restart", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-tool-result-aging-"));
  const env = {
    ...process.env,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
  delete env.CODEX_ROUTER_TOOL_RESULT_AGING;
  const runControl = (action) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "tool-result-aging", action],
        { cwd: root, encoding: "utf8", env },
      ),
    );
  try {
    // A missing saved choice uses the routed default-on policy.
    assert.equal(runControl("status").enabled, true);
    assert.equal(runControl("off").enabled, false);
    assert.equal(runControl("status").enabled, false);
    assert.equal(runControl("on").enabled, true);
    assert.equal(runControl("status").enabled, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("control retrieves exact owner-local bytes and fails closed on mismatches", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-tool-result-retrieve-"));
  const env = {
    ...process.env,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
  const value = Buffer.from("exact control bytes\0\u001b]0;not-a-title\u0007😀", "utf8");
  const digest = createHash("sha256").update(value).digest("hex");
  const callId = "control-call";
  const outputType = "function_call_output";
  const routeKind = "routed";
  const routeModel = "deepseek/deepseek-v4-pro";
  const destination = path.join(stateDir, "retrieved-tool-results", "saved-output.bin");
  const retentionUrl = pathToFileURL(path.join(root, "src", "tool-result-retention.mjs")).href;
  try {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { retainToolResult, toolResultRetentionContext } from ${JSON.stringify(retentionUrl)}; retainToolResult(Buffer.from(${JSON.stringify(value.toString("base64"))}, "base64"), { expectedDigest: ${JSON.stringify(digest)}, callId: ${JSON.stringify(callId)}, outputType: ${JSON.stringify(outputType)}, context: toolResultRetentionContext(${JSON.stringify(routeKind)}, ${JSON.stringify(routeModel)}) });`,
      ],
      { cwd: root, env },
    );
    const retrieved = JSON.parse(execFileSync(
      process.execPath,
      [
        path.join(root, "src", "control.mjs"),
        "tool-result-aging",
        "retrieve",
        digest,
        String(value.length),
        callId,
        outputType,
        routeKind,
        routeModel,
        destination,
      ],
      { cwd: root, env, encoding: "utf8" },
    ));
    assert.deepEqual(retrieved, { ok: true, byteLength: value.length });
    assert.deepEqual(readFileSync(destination), value);
    assert.doesNotMatch(JSON.stringify(retrieved), /not-a-title|\u001b/);
    if (process.platform !== "win32") {
      assert.equal(statSync(destination).mode & 0o777, 0o600);
    }
    assert.throws(
      () => execFileSync(
        process.execPath,
        [
          path.join(root, "src", "control.mjs"),
          "tool-result-aging",
          "retrieve",
          digest,
          String(value.length),
          "wrong-call",
          outputType,
          routeKind,
          routeModel,
          path.join(stateDir, "retrieved-tool-results", "wrong-output.bin"),
        ],
        { cwd: root, env, stdio: "pipe" },
      ),
      (error) => {
        const stderr = error.stderr?.toString("utf8") || "";
        return error.status !== 0
          && !error.stdout?.includes(value)
          && !stderr.includes(stateDir)
          && !stderr.includes(digest)
          && !stderr.includes("cause:");
      },
    );

    // The control entrypoint is absolute and never executes a cwd-controlled
    // project bin/control while handling owner-local retrieval.
    const hostile = path.join(stateDir, "hostile-project");
    mkdirSync(path.join(hostile, "bin"), { recursive: true });
    writeFileSync(path.join(hostile, "bin", "control"), "hostile marker", "utf8");
    assert.throws(
      () => execFileSync(
        process.execPath,
        [
          path.join(root, "src", "control.mjs"),
          "tool-result-aging",
          "retrieve",
          digest,
          String(value.length),
          callId,
          outputType,
          routeKind,
          routeModel,
          destination,
        ],
        { cwd: hostile, env, stdio: "pipe" },
      ),
      (error) => error.status !== 0,
    );
    assert.equal(readFileSync(path.join(hostile, "bin", "control"), "utf8"), "hostile marker");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("real aging store is deterministic across processes and missing-key state fails closed", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "aging-process-restart-"));
  const env = { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir };
  const agingUrl = pathToFileURL(path.join(root, "src", "tool-result-aging.mjs")).href;
  const retentionUrl = pathToFileURL(path.join(root, "src", "tool-result-retention.mjs")).href;
  const source = [
    `import { ageToolResults } from ${JSON.stringify(agingUrl)};`,
    `import { retainToolResult, toolResultRetentionContext } from ${JSON.stringify(retentionUrl)};`,
    `const value = "restart test row\\n".repeat(3000);`,
    `const input = [{ type: "function_call", call_id: "restart-call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) }, { type: "function_call_output", call_id: "restart-call", output: value }, { type: "message", role: "assistant", content: "acted" }];`,
    `const result = ageToolResults(input, { frontier: 0, retain: retainToolResult, retentionContext: toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro") });`,
    `if (result.stats.toolResultsAged !== 1) { process.stderr.write(JSON.stringify(result.stats)); process.exit(9); }`,
    `process.stdout.write(result.input[1].output);`,
  ].join("\n");
  const runAging = (targetStateDir = stateDir) => execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: root,
      env: { ...env, MODEL_ROUTER_STATE_DIR: targetStateDir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let tornStateDir;
  try {
    const first = runAging();
    const second = runAging();
    assert.equal(second, first);
    const retainedDir = path.join(stateDir, "retained-tool-results");
    assert.equal(
      readdirSync(retainedDir).filter((name) => name.endsWith(".result")).length,
      1,
    );
    const [resultName] = readdirSync(retainedDir).filter((name) => name.endsWith(".result"));
    writeFileSync(path.join(retainedDir, resultName), "torn", { mode: 0o600 });
    assert.equal(runAging(), first, "an exact replay atomically repairs a torn result");
    assert.ok(statSync(path.join(retainedDir, resultName)).size > 40_000);

    tornStateDir = mkdtempSync(path.join(os.tmpdir(), "aging-torn-key-"));
    const tornRetentionDir = path.join(tornStateDir, "retained-tool-results");
    mkdirSync(tornRetentionDir, { recursive: true, mode: 0o700 });
    const tornKeyPath = path.join(tornRetentionDir, ".retention-key");
    writeFileSync(tornKeyPath, "torn-key", { mode: 0o600 });
    // POSIX mode 0600 is not a Windows ACL. The repair fixture must satisfy
    // the same exact owner-only precondition as a production-created key;
    // otherwise Windows is correctly required to reject it rather than repair.
    protectPrivateFile(tornKeyPath);
    const concurrent = await Promise.all([
      execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: root,
        env: { ...env, MODEL_ROUTER_STATE_DIR: tornStateDir },
        encoding: "utf8",
      }),
      execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: root,
        env: { ...env, MODEL_ROUTER_STATE_DIR: tornStateDir },
        encoding: "utf8",
      }),
    ]);
    assert.match(concurrent[0].stdout, /smart summary v2/);
    assert.equal(concurrent[1].stdout, concurrent[0].stdout);
    assert.equal(runAging(tornStateDir), concurrent[0].stdout);
    assert.equal(statSync(path.join(tornRetentionDir, ".retention-key")).size, 32);
    assert.equal(
      readdirSync(tornRetentionDir).filter((name) => name.endsWith(".result")).length,
      1,
    );
    const exact = Buffer.from("restart test row\n".repeat(3000), "utf8");
    const exactDigest = createHash("sha256").update(exact).digest("hex");
    const retrieveSource = [
      `import { retrieveToolResultByDigest, toolResultRetentionContext } from ${JSON.stringify(retentionUrl)};`,
      `const value = retrieveToolResultByDigest(${JSON.stringify(exactDigest)}, ${exact.length}, "restart-call", "function_call_output", toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro"));`,
      `process.stdout.write(value.toString("base64"));`,
    ].join("\n");
    const retrieved = execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", retrieveSource],
      {
        cwd: root,
        env: { ...env, MODEL_ROUTER_STATE_DIR: tornStateDir },
        encoding: "utf8",
      },
    );
    assert.deepEqual(Buffer.from(retrieved, "base64"), exact);

    unlinkSync(path.join(retainedDir, ".retention-key"));
    assert.throws(
      runAging,
      (error) => error.status !== 0 && error.stdout?.length === 0,
    );
    assert.equal(existsSync(path.join(retainedDir, ".retention-key")), false);
    assert.equal(
      readdirSync(retainedDir).filter((name) => name.endsWith(".result")).length,
      1,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    if (tornStateDir) rmSync(tornStateDir, { recursive: true, force: true });
  }
});

test(
  "Windows refuses to repair a torn key whose ACL grants another principal",
  { skip: process.platform !== "win32" },
  () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "aging-unprotected-key-"));
    const retentionDir = path.join(stateDir, "retained-tool-results");
    const keyPath = path.join(retentionDir, ".retention-key");
    const retentionUrl = pathToFileURL(path.join(root, "src", "tool-result-retention.mjs")).href;
    const agingUrl = pathToFileURL(path.join(root, "src", "tool-result-aging.mjs")).href;
    const aclScript = [
      "$target = $env:CODEX_ROUTER_TEST_KEY",
      "$acl = [System.IO.File]::GetAccessControl($target)",
      "$everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')",
      "$rule = New-Object Security.AccessControl.FileSystemAccessRule($everyone, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)",
      "[void]$acl.AddAccessRule($rule)",
      "[System.IO.File]::SetAccessControl($target, $acl)",
    ].join("; ");
    const sddl = () => execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_TEST_KEY); [Console]::Out.Write($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All))",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_ROUTER_TEST_KEY: keyPath },
      },
    );
    try {
      mkdirSync(retentionDir, { recursive: true, mode: 0o700 });
      writeFileSync(keyPath, "torn-key", { mode: 0o600 });
      protectPrivateFile(keyPath);
      execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", aclScript],
        {
          env: { ...process.env, CODEX_ROUTER_TEST_KEY: keyPath },
          stdio: "ignore",
        },
      );
      assert.equal(privateFileIsProtected(keyPath), false);
      const bytesBefore = readFileSync(keyPath);
      const aclBefore = sddl();
      const source = [
        `import { ageToolResults } from ${JSON.stringify(agingUrl)};`,
        `import { retainToolResult, toolResultRetentionContext } from ${JSON.stringify(retentionUrl)};`,
        `const value = "unprotected key row\\n".repeat(3000);`,
        `const input = [{ type: "function_call", call_id: "unprotected-key", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) }, { type: "function_call_output", call_id: "unprotected-key", output: value }, { type: "message", role: "assistant", content: "acted" }];`,
        `const result = ageToolResults(input, { frontier: 0, retain: retainToolResult, retentionContext: toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro") });`,
        `process.stdout.write(JSON.stringify({ unchanged: result.input === input, aged: result.stats.toolResultsAged, failures: result.stats.toolResultRetentionFailures, reason: result.stats.toolResultRetentionDegradedReason }));`,
      ].join("\n");
      const result = JSON.parse(execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", source],
        {
          cwd: root,
          env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir },
          encoding: "utf8",
        },
      ));
      assert.deepEqual(result, {
        unchanged: true,
        aged: 0,
        failures: 1,
        reason: "storage",
      });
      assert.deepEqual(readFileSync(keyPath), bytesBefore);
      assert.equal(sddl(), aclBefore);
      assert.equal(privateFileIsProtected(keyPath), false);
      assert.equal(readdirSync(retentionDir).some((name) => name.endsWith(".result")), false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);

test("orphan retention stages count toward the hard file cap", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "aging-stage-cap-"));
  const retentionDir = path.join(stateDir, "retained-tool-results");
  mkdirSync(retentionDir, { recursive: true, mode: 0o700 });
  for (const suffix of ["a".repeat(32), "b".repeat(32)]) {
    writeFileSync(path.join(retentionDir, `.orphan.result.stage.${suffix}`), "orphan", {
      mode: 0o600,
    });
  }
  const agingUrl = pathToFileURL(path.join(root, "src", "tool-result-aging.mjs")).href;
  const retentionUrl = pathToFileURL(path.join(root, "src", "tool-result-retention.mjs")).href;
  const source = [
    `import { ageToolResults } from ${JSON.stringify(agingUrl)};`,
    `import { retainToolResult, toolResultRetentionContext } from ${JSON.stringify(retentionUrl)};`,
    `const value = "stage cap row\\n".repeat(3000);`,
    `const input = [{ type: "function_call", call_id: "stage-cap", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) }, { type: "function_call_output", call_id: "stage-cap", output: value }, { type: "message", role: "assistant", content: "acted" }];`,
    `const result = ageToolResults(input, { frontier: 0, retain: retainToolResult, retentionContext: toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro") });`,
    `process.stdout.write(JSON.stringify({ aged: result.stats.toolResultsAged, failures: result.stats.toolResultRetentionFailures, unchanged: result.input === input }));`,
  ].join("\n");
  try {
    const result = JSON.parse(execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", source],
      {
        cwd: root,
        env: {
          ...process.env,
          MODEL_ROUTER_STATE_DIR: stateDir,
          MODEL_ROUTER_TOOL_RESULT_RETENTION_MAX_FILES: "2",
        },
        encoding: "utf8",
      },
    ));
    assert.deepEqual(result, { aged: 0, failures: 1, unchanged: true });
    assert.equal(readdirSync(retentionDir).filter((name) => name.endsWith(".result")).length, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test(
  "a retry re-syncs final key and result names after publication fsync failures",
  { skip: process.platform === "win32" },
  () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "aging-publication-fsync-"));
    const retentionUrl = pathToFileURL(path.join(root, "src", "tool-result-retention.mjs")).href;
    const runRetain = (callId, value, failingDirectorySyncs = [], retrieveAfter = true) => {
      const source = [
        `import fs from "node:fs";`,
        `import { syncBuiltinESMExports } from "node:module";`,
        `const failing = new Set(${JSON.stringify(failingDirectorySyncs)});`,
        `const realFsync = fs.fsyncSync.bind(fs);`,
        `let directorySync = 0;`,
        `fs.fsyncSync = (descriptor) => { if (fs.fstatSync(descriptor).isDirectory()) { directorySync += 1; if (failing.has(directorySync)) { const error = new Error("injected directory fsync failure"); error.code = "EIO"; throw error; } } return realFsync(descriptor); };`,
        `syncBuiltinESMExports();`,
        `const retention = await import(${JSON.stringify(`${retentionUrl}?fault=`)} + Math.random());`,
        `const bytes = Buffer.from(${JSON.stringify(value.toString("base64"))}, "base64");`,
        `const digest = ${JSON.stringify(createHash("sha256").update(value).digest("hex"))};`,
        `try {`,
        `  const metadata = { expectedDigest: digest, callId: ${JSON.stringify(callId)}, outputType: "function_call_output", context: retention.toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro") };`,
        `  const stored = retention.retainToolResult(bytes, metadata);`,
        retrieveAfter
          ? `  const recovered = retention.retrieveToolResult(stored.handle, digest, bytes.length, metadata.callId, metadata.outputType, metadata.context); process.stdout.write(recovered.toString("base64"));`
          : `  process.stdout.write(stored.handle);`,
        `} catch (error) { process.exitCode = 23; }`,
      ].join("\n");
      return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
        cwd: root,
        env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    };
    const retentionDir = path.join(stateDir, "retained-tool-results");
    const first = Buffer.from("key publication retry bytes", "utf8");
    const second = Buffer.from("result publication retry bytes", "utf8");
    try {
      assert.throws(
        () => runRetain("key-sync", first, [1, 2]),
        (error) => error.status === 23,
      );
      assert.equal(statSync(path.join(retentionDir, ".retention-key")).size, 32);
      assert.equal(readdirSync(retentionDir).filter((name) => name.endsWith(".result")).length, 0);
      const publishedKey = readFileSync(path.join(retentionDir, ".retention-key"));
      assert.throws(
        () => runRetain("key-sync", first, [1, 2], false),
        (error) => error.status === 23,
        "retry must fail closed when it cannot re-sync the existing key name",
      );
      assert.deepEqual(readFileSync(path.join(retentionDir, ".retention-key")), publishedKey);
      assert.equal(
        readdirSync(retentionDir).filter((name) => name.endsWith(".result")).length,
        0,
        "key retry must fail before publishing any result",
      );
      assert.deepEqual(Buffer.from(runRetain("key-sync", first), "base64"), first);

      assert.throws(
        () => runRetain("result-sync", second, [2, 3]),
        (error) => error.status === 23,
      );
      assert.equal(readdirSync(retentionDir).filter((name) => name.endsWith(".result")).length, 2);
      assert.throws(
        () => runRetain("result-sync", second, [2], false),
        (error) => error.status === 23,
        "retain itself must fail closed when it cannot re-sync the existing result name",
      );
      assert.deepEqual(Buffer.from(runRetain("result-sync", second), "base64"), second);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);

test(
  "retention rejects a symlinked state path before touching its target",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "aging-symlink-state-"));
    const external = path.join(testRoot, "external");
    const linkedState = path.join(testRoot, "linked-state");
    mkdirSync(external, { mode: 0o755 });
    symlinkSync(external, linkedState, "dir");
    const retentionUrl = pathToFileURL(path.join(root, "src", "tool-result-retention.mjs")).href;
    const source = [
      `import { createHash } from "node:crypto";`,
      `import { retainToolResult, toolResultRetentionContext } from ${JSON.stringify(retentionUrl)};`,
      `const bytes = Buffer.from("private bytes");`,
      `retainToolResult(bytes, { expectedDigest: createHash("sha256").update(bytes).digest("hex"), callId: "symlink-call", outputType: "function_call_output", context: toolResultRetentionContext("routed", "deepseek/deepseek-v4-pro") });`,
    ].join("\n");
    try {
      assert.throws(
        () => execFileSync(
          process.execPath,
          ["--input-type=module", "--eval", source],
          {
            cwd: root,
            env: { ...process.env, MODEL_ROUTER_STATE_DIR: linkedState },
            stdio: "pipe",
          },
        ),
        (error) => error.status !== 0,
      );
      assert.equal(statSync(external).mode & 0o777, 0o755);
      assert.equal(existsSync(path.join(external, "retained-tool-results")), false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test("picker all accepts the documented show/hide flag position", () => {
  assert.deepEqual(pickerCommandArgs(["picker", "all", "show"]), [
    "all",
    undefined,
    "show",
  ]);
  assert.deepEqual(pickerCommandArgs(["picker", "all", "hide"]), [
    "all",
    undefined,
    "hide",
  ]);
  assert.deepEqual(
    pickerCommandArgs([
      "picker",
      "set",
      "deepseek/deepseek-v4-flash",
      "hide",
    ]),
    ["set", "deepseek/deepseek-v4-flash", "hide"],
  );
});

function probeSet(target, providers, provider, desired) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-set-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers })}\n`,
    { mode: 0o600 },
  );
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "--probe-set", provider, desired],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MODEL_ROUTER_TARGET: target, MODEL_ROUTER_STATE_DIR: stateDir },
      },
    );
    return JSON.parse(output);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("toggle on adds a provider; toggle off removes it", () => {
  const added = probeSet("codex", ["deepseek"], "grok-oauth", "on");
  assert.deepEqual(added.enabledProviders, ["deepseek", "grok-oauth"]);

  const removed = probeSet("codex", ["grok-oauth", "deepseek"], "deepseek", "off");
  assert.deepEqual(removed.enabledProviders, ["grok-oauth"]);
});

test("toggle rejects an unknown provider", () => {
  assert.throws(() => probeSet("codex", ["deepseek"], "not-a-provider", "on"));
});

test("login-free control selects a ready external model and restores Codex defaults", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-login-free-"));
  writeFileSync(path.join(stateDir, "config.toml"), `model = "gpt-5.6-sol"\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          visibility: "list",
          priority: 10,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const runMode = (desired) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "auth-mode", desired],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: stateDir,
            CODEX_BIN: process.execPath,
            MODEL_ROUTER_TARGET: "codex",
            MODEL_ROUTER_STATE_DIR: stateDir,
          },
        },
      ),
    );

  try {
    const enabled = runMode("on");
    assert.equal(enabled.login_free, true);
    assert.equal(enabled.model, "gpt-5.6-sol");
    assert.equal(enabled.model_provider, "codex-router");
    const catalog = JSON.parse(readFileSync(path.join(stateDir, "merged-models.json"), "utf8"));
    const aliasEntry = catalog.models.find((model) => model.slug === "gpt-5.6-sol");
    assert.match(aliasEntry.display_name, /DeepSeek/);
    assert.equal(aliasEntry.visibility, "list");
    assert.deepEqual(
      catalog.models
        .filter((model) => model.slug.startsWith("deepseek/"))
        .map((model) => [model.slug, model.visibility]),
      [
        ["deepseek/deepseek-v4-flash", "hide"],
        ["deepseek/deepseek-v4-pro", "list"],
      ],
    );
    const aliases = JSON.parse(readFileSync(path.join(stateDir, "native-aliases.json"), "utf8"));
    assert.deepEqual(aliases, {
      version: 1,
      aliases: { "gpt-5.6-sol": "deepseek/deepseek-v4-flash" },
    });

    const disabled = runMode("off");
    assert.equal(disabled.login_free, false);
    assert.equal(disabled.model, "gpt-5.6-sol");
    assert.equal(disabled.model_provider, "openai");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("login-free aliasing applies even when a ChatGPT credential is still stored", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-login-free-auth-"));
  writeFileSync(path.join(stateDir, "config.toml"), `model = "gpt-5.6-sol"\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 10 },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  try {
    const enabled = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "auth-mode", "on"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: stateDir,
            // A real Codex install must not leak into this test on Windows,
            // where /usr/bin/true does not exist. Node is runnable everywhere
            // and produces no Codex catalog, so the seeded fixture is reused.
            CODEX_BIN: process.execPath,
            MODEL_ROUTER_TARGET: "codex",
            MODEL_ROUTER_STATE_DIR: stateDir,
          },
        },
      ),
    );
    assert.equal(enabled.login_free, true);
    assert.equal(enabled.model, "gpt-5.6-sol");
    const aliases = JSON.parse(readFileSync(path.join(stateDir, "native-aliases.json"), "utf8"));
    assert.deepEqual(aliases.aliases, { "gpt-5.6-sol": "deepseek/deepseek-v4-flash" });
    const catalog = JSON.parse(readFileSync(path.join(stateDir, "merged-models.json"), "utf8"));
    assert.match(
      catalog.models.find((model) => model.slug === "gpt-5.6-sol").display_name,
      /DeepSeek/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("model-set switches the login-free model and rejects unavailable models", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-model-set-"));
  writeFileSync(path.join(stateDir, "config.toml"), `model = "gpt-5.6-sol"\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek", "kimi-api"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          visibility: "list",
          priority: 10,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const environment = {
    ...process.env,
    CODEX_HOME: stateDir,
    CODEX_BIN: process.execPath,
    KIMI_CODE_HOME: path.join(stateDir, "kimi-code"),
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
  delete environment.KIMI_API_KEY;
  delete environment.MOONSHOT_API_KEY;
  const runControl = (...commandArgs) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), ...commandArgs],
        { cwd: root, encoding: "utf8", env: environment },
      ),
    );

  try {
    assert.throws(
      () => runControl("model-set", "deepseek/deepseek-v4-flash"),
      /login-free/,
      "model-set must require login-free mode",
    );

    runControl("auth-mode", "on");
    const switched = runControl("model-set", "deepseek/deepseek-v4-flash");
    assert.equal(switched.model, "gpt-5.6-sol");
    assert.equal(switched.model_provider, "codex-router");
    assert.equal(switched.login_free, true);

    const overflow = runControl("model-set", "deepseek/deepseek-v4-pro");
    assert.equal(overflow.model, "deepseek/deepseek-v4-pro");

    assert.throws(
      () => runControl("model-set", "kimi-api/kimi-k3"),
      /enabled, authenticated/,
      "model-set must reject models from unauthenticated providers",
    );
    assert.throws(
      () => runControl("model-set", "gpt-5.6-sol"),
      /enabled, authenticated/,
      "model-set must reject native models",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("signed routing rolls back catalog and config after a forced post-publication failure", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-signed-rollback-"));
  const configPath = path.join(stateDir, "config.toml");
  const originalCatalog = {
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        visibility: "list",
        priority: 10,
      },
    ],
  };
  const staleMergedCatalog = {
    models: [
      ...originalCatalog.models,
      {
        slug: "deepseek/deepseek-v4-flash",
        display_name: "DeepSeek V4 Flash",
        visibility: "list",
        priority: 6,
      },
    ],
  };
  writeFileSync(
    configPath,
    `model_provider = "custom"

[model_providers.custom]
name = "CC Switch"
base_url = "https://direct.invalid/v1"

[model_providers.custom.query_params]
api_key = "ROLLBACK_QUERY_SECRET"
`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify(originalCatalog)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "merged-models.json"),
    `${JSON.stringify(staleMergedCatalog, null, 2)}\n`,
    { mode: 0o600 },
  );
  const environment = {
    ...process.env,
    CODEX_HOME: stateDir,
    CODEX_BIN: process.execPath,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_TEST_FAIL_AFTER_CATALOG_WRITE: "1",
  };
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(root, "src", "control.mjs"), "signed-routing", "on"],
          { cwd: root, encoding: "utf8", env: environment, stdio: "pipe" },
        ),
      /catalog|publication/i,
    );
    const restoredConfig = readFileSync(configPath, "utf8");
    assert.match(restoredConfig, /^model_provider = "custom"$/m);
    assert.match(restoredConfig, /base_url = "https:\/\/direct\.invalid\/v1"/);
    assert.match(restoredConfig, /api_key = "ROLLBACK_QUERY_SECRET"/);
    assert.doesNotMatch(restoredConfig, /codex-router-signed-provider-managed/);
    const safeCatalog = JSON.parse(
      readFileSync(path.join(stateDir, "merged-models.json"), "utf8"),
    );
    assert.equal(
      safeCatalog.models.some((model) => model.slug === "deepseek/deepseek-v4-flash"),
      false,
    );
    assert.equal(
      existsSync(path.join(stateDir, "signed-provider-mode.json")),
      false,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The state directory is pinned per case on purpose: this assertion used to
// read the developer's own installation, so publishing to DeepSeek Harness on
// the machine running the tests changed the expected target list.
function overviewTargets(stateDir) {
  const output = execFileSync(process.execPath, [path.join(root, "src", "control.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir },
  });
  return Object.keys(JSON.parse(output).targets).sort();
}

test("aggregate overview covers every target", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-targets-"));
  try {
    assert.deepEqual(overviewTargets(stateDir), ["codex"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the harness target appears only once its route has been published", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-targets-dsh-"));
  try {
    writeFileSync(
      path.join(stateDir, "dsh-models.json"),
      `${JSON.stringify({ version: 1, route: "codex-router", models: [] })}\n`,
      { mode: 0o600 },
    );
    assert.deepEqual(overviewTargets(stateDir), ["codex", "dsh"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the tray usage advertises rebuild alongside the supervised actions", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-tray-usage-"));
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(root, "src", "control.mjs"), "tray", "bogus"],
          {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir },
          },
        ),
      (error) => {
        assert.match(String(error.stderr), /Usage: control tray enable\|disable\|status\|restart\|rebuild/);
        return true;
      },
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
