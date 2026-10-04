import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  routedAgentDefinition,
  routedCodexAgentStatus,
  syncRoutedCodexAgents,
} from "../src/codex-agent-catalog.mjs";
import { subagentEligibleModels } from "../src/multi-agent-state.mjs";

const kimi = {
  slug: "kimi-oauth/k3",
  displayName: "Kimi K3 (OAuth)",
};

test("routed agent definitions select the router provider and exact model slug", () => {
  const definition = routedAgentDefinition(kimi);
  assert.equal(definition.agentName, "router_kimi_oauth_k3");
  assert.equal(definition.fileName, "router-model-kimi-oauth-k3.toml");
  assert.match(definition.contents, /^# Managed by Codex Router\./);
  assert.match(definition.contents, /model_provider = "codex-router"/);
  assert.match(definition.contents, /model = "kimi-oauth\/k3"/);
  assert.match(definition.contents, /cite the exact file and line/);
  assert.match(definition.contents, /Before claiming that something is absent/);
  assert.match(definition.contents, /Never invent or reuse a stale name/);
  assert.match(definition.contents, /Do not stop after merely announcing a next action/);
});

test("agent sync writes one private definition for every routed model", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  const grok = { slug: "grok-oauth/grok-4.5", displayName: "Grok 4.5 (OAuth)" };
  const { written, removed } = syncRoutedCodexAgents([kimi, grok], agentsDir);

  assert.deepEqual(removed, []);
  assert.deepEqual(
    written.map(({ model, agent }) => ({ model, agent })),
    [
      { model: "kimi-oauth/k3", agent: "router_kimi_oauth_k3" },
      { model: "grok-oauth/grok-4.5", agent: "router_grok_oauth_grok_4_5" },
    ],
  );
  const kimiFile = path.join(agentsDir, "router-model-kimi-oauth-k3.toml");
  assert.match(readFileSync(kimiFile, "utf8"), /name = "router_kimi_oauth_k3"/);
  assert.deepEqual(routedCodexAgentStatus([kimi, grok], agentsDir), {
    expected: 2,
    current: 2,
    missing: [],
    stale: [],
    unprotected: [],
    extra: [],
    ok: true,
  });
});

test("agent status reports definitions that have not been installed", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  assert.deepEqual(routedCodexAgentStatus([kimi], agentsDir), {
    expected: 1,
    current: 0,
    missing: ["kimi-oauth/k3"],
    stale: [],
    unprotected: [],
    extra: [],
    ok: false,
  });
});

test("agent definitions reject non-routed model slugs", () => {
  assert.throws(() => routedAgentDefinition({ slug: "gpt-5.6-sol" }), /invalid model slug/);
});

test("a model switched off as a subagent loses its definition", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  const grok = { slug: "grok-oauth/grok-4.5", displayName: "Grok 4.5 (OAuth)" };
  syncRoutedCodexAgents([kimi, grok], agentsDir);

  const { written, removed } = syncRoutedCodexAgents([kimi], agentsDir);
  assert.deepEqual(
    written.map(({ model }) => model),
    ["kimi-oauth/k3"],
  );
  assert.deepEqual(removed, ["router-model-grok-oauth-grok-4-5.toml"]);
  assert.deepEqual(readdirSync(agentsDir), ["router-model-kimi-oauth-k3.toml"]);
});

test("agent sync leaves definitions it does not manage alone", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  writeFileSync(path.join(agentsDir, "reviewer.toml"), 'name = "reviewer"\n');
  syncRoutedCodexAgents([kimi], agentsDir);

  const { removed } = syncRoutedCodexAgents([], agentsDir);
  assert.deepEqual(removed, ["router-model-kimi-oauth-k3.toml"]);
  assert.deepEqual(readdirSync(agentsDir), ["reviewer.toml"]);
});

test("agent status reports a definition left behind by an older install", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  syncRoutedCodexAgents([kimi], agentsDir);

  const status = routedCodexAgentStatus([], agentsDir);
  assert.deepEqual(status.extra, ["router-model-kimi-oauth-k3.toml"]);
  assert.equal(status.ok, false);
});

test("an install with every model switched off is a clean state", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  const status = routedCodexAgentStatus([], agentsDir);
  assert.deepEqual(status.extra, []);
  assert.equal(status.ok, true);
});

test("only registry-proven models receive routed agent definitions", () => {
  const models = [
    { slug: "kimi-oauth/k3", multiAgentVersion: "v2" },
    { slug: "grok-oauth/grok-4.5", multiAgentVersion: "v2" },
    { slug: "deepseek/deepseek-v4-flash" },
  ];
  assert.deepEqual(
    subagentEligibleModels(models, { mode: "proven", enabled: [], disabled: [] }).map(
      ({ slug }) => slug,
    ),
    ["kimi-oauth/k3", "grok-oauth/grok-4.5"],
  );
  assert.deepEqual(
    subagentEligibleModels(models, {
      mode: "all",
      enabled: [],
      disabled: ["grok-oauth/grok-4.5"],
    }).map(({ slug }) => slug),
    ["kimi-oauth/k3"],
  );
});


test("exact Nous V4.1 role stays monitor/classify-only at max effort", () => {
  const definition = routedAgentDefinition({ slug: "nous/deepseek/deepseek-v4.1-flash", displayName: "Nous Direct" });
  assert.match(definition.contents, /model_reasoning_effort = "max"/);
  assert.match(definition.contents, /bounded monitor\/classify-only task/);
  assert.match(definition.contents, /Do not implement fixes/);
  assert.doesNotMatch(routedAgentDefinition(kimi).contents, /monitor\/classify-only/);
});

const nousSlug = "nous/deepseek/deepseek-v4.1-flash";
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function publicationFixture(t, { proof, hidden = [], disabled = [], selected = true, foreignOwner = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-role-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const registry = path.join(root, "registry");
  const agents = path.join(root, "agents");
  mkdirSync(state); mkdirSync(registry); mkdirSync(agents);
  const providers = JSON.parse(readFileSync(path.join(sourceRoot, "config/nous/nous.json"), "utf8")).providers;
  const models = JSON.parse(readFileSync(path.join(sourceRoot, "config/nous/direct/models.json"), "utf8")).models;
  // This fixture supplies local capability evidence, not a registry promotion.
  for (const model of models) delete model.multiAgentVersion;
  writeFileSync(path.join(registry, "models.json"), JSON.stringify({ version: 1, providers, models }));
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: selected ? ["nous"] : [] }));
  writeFileSync(path.join(state, "multi-agent-settings.json"), JSON.stringify({ version: 2, mode: "proven", enabled: [], disabled }));
  writeFileSync(path.join(state, "model-picker.json"), JSON.stringify({ version: 1, hidden }));
  writeFileSync(path.join(state, "multi-agent-proofs.json"), JSON.stringify({ version: 1, proofs: proof ? { [nousSlug]: proof } : {} }));
  if (foreignOwner) writeFileSync(path.join(state, "install-manifest.json"), JSON.stringify({ version: 1, current: { sourceRoot: path.join(root, "other-checkout") } }));
  const retained = path.join(agents, "router-model-grok-oauth-grok-4-5.toml");
  const authored = path.join(agents, "monitor.toml");
  writeFileSync(retained, "# retained saved role\nmodel = \"grok-oauth/grok-4.5\"\n");
  writeFileSync(authored, "# authored monitor\nmodel = \"nous/deepseek/deepseek-v4.1-flash\"\n");
  const preimages = new Map([retained, authored].map((file) => [file, readFileSync(file)]));
  return {
    agents,
    preimages,
    publish() {
      // Per-child state overrides keep production roles, proofs and credentials
      // outside the fixture. HOME and CODEX_HOME retain their shell meanings.
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { publishQualifiedRoutedCodexAgent } from './src/codex-agent-catalog.mjs';
        try {
          console.log(JSON.stringify(publishQualifiedRoutedCodexAgent(process.argv[1], process.argv[2])));
        } catch (error) {
          console.error(error.message);
          process.exitCode = 1;
        }
      `, nousSlug, agents], {
        cwd: sourceRoot,
        env: { ...process.env, MODEL_ROUTER_TARGET: "codex", MODEL_ROUTER_STATE_DIR: state,
          CODEX_ROUTER_SOURCE_ROOT: sourceRoot, MODEL_ROUTER_ALLOW_FOREIGN_STATE: "0",
          MODEL_ROUTER_REGISTRY: registry, MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
          MODEL_ROUTER_MULTI_AGENT_STATE: path.join(state, "multi-agent-settings.json"),
          MODEL_ROUTER_SUBAGENT_PROOFS: path.join(state, "multi-agent-proofs.json"),
          MODEL_ROUTER_MODEL_PICKER_STATE: path.join(state, "model-picker.json"),
          MODEL_ROUTER_SHOW_ALL_MODELS: "0", CODEX_ROUTER_SHOW_ALL_MODELS: "0",
          CODEX_ROUTER_NO_DISCOVERY: "0", NOUS_API_KEY: "inert-fixture-only-no-provider-contact" },
        encoding: "utf8", timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      for (const [file, bytes] of preimages) assert.deepEqual(readFileSync(file), bytes);
      return result;
    },
  };
}

test("additive publication refuses absent or unsettled capability evidence", (t) => {
  for (const proof of [undefined, { status: "checking" }, { status: "failed" }]) {
    const fixture = publicationFixture(t, { proof });
    const result = fixture.publish();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unqualified routed agent/);
    assert.deepEqual(readdirSync(fixture.agents).sort(), ["monitor.toml", "router-model-grok-oauth-grok-4-5.toml"]);
  }
});

test("additive publication respects provider selection and capability demotions", (t) => {
  for (const options of [{ selected: false }, { hidden: [nousSlug] }, { disabled: [nousSlug] }]) {
    const fixture = publicationFixture(t, { proof: { status: "proven", spawn: { ok: true, status: 200 } }, ...options });
    const result = fixture.publish();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unqualified routed agent/);
    assert.equal(readdirSync(fixture.agents).length, 2);
  }
});

test("additive publication writes qualified Nous/max and preserves retained and authored roles", (t) => {
  const fixture = publicationFixture(t, { proof: { status: "proven", spawn: { ok: true, status: 200 } } });
  const result = fixture.publish();
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout);
  assert.equal(published.model, nousSlug);
  assert.equal(published.agent, "router_nous_deepseek_deepseek_v4_1_flash");
  assert.equal(published.path, path.join(fixture.agents, "router-model-nous-deepseek-deepseek-v4-1-flash.toml"));
  assert.equal(readFileSync(published.path, "utf8"), routedAgentDefinition({ slug: nousSlug, displayName: "Nous Direct · DeepSeek V4.1 Flash" }).contents);
  if (process.platform !== "win32") assert.equal(statSync(published.path).mode & 0o777, 0o600);
  assert.equal(readdirSync(fixture.agents).length, 3);
});

test("additive publication refuses a different checkout's owned state", (t) => {
  const fixture = publicationFixture(t, { proof: { status: "proven", spawn: { ok: true, status: 200 } }, foreignOwner: true });
  const result = fixture.publish();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owned by another checkout/);
  assert.equal(readdirSync(fixture.agents).length, 2);
});
