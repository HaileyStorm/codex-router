import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTO_ANNOUNCE_WINDOW_MS,
  annotateNewModelAnnouncements,
  buildMergedCatalog,
  buildLoginFreeCatalog,
  clampModelEfforts,
  codexEffortVocabulary,
  nativeCatalogIsReusable,
  deriveBaseInstructions,
  mergeNativeCatalogs,
  mergeNativeModel,
  promoteNativeMultiAgent,
  routedCatalogConfigured,
  routedModel,
} from "../src/catalog.mjs";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";
import {
  NATIVE_PROFILE_MANIFEST,
  assertNativeProfilesDisjoint,
} from "../src/native-profiles.mjs";

const template = {
  slug: "gpt-5.5",
  display_name: "GPT-5.5",
  description: "Native template",
  priority: 10,
  visibility: "list",
  base_instructions:
    "You are Codex, a coding agent based on GPT-5. You and the user share one workspace.",
  model_messages: {
    instructions_template:
      "You are Codex, a coding agent based on GPT-5. {{ personality }}",
    instructions_variables: {
      personality_default: "",
    },
  },
  apply_patch_tool_type: "freeform",
  default_service_tier: "priority",
};

test("Flash-Next is absent by default and explicit selection publishes exact picker metadata", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "catalog-freetoken-"));
  const script = `
    import { selectedConfiguredListedModels } from './src/provider-selection.mjs';
    import { routedModel } from './src/catalog.mjs';
    const model = selectedConfiguredListedModels().find(({ provider }) => provider === 'freetoken');
    const template = { slug: 'gpt-template', base_instructions: 'template', supports_parallel_tool_calls: true };
    console.log(JSON.stringify(model ? routedModel(template, model) : null));
  `;
  const run = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: state,
      CODEX_ROUTER_STATE_DIR: state,
      MODEL_ROUTER_SHOW_ALL_MODELS: "0",
      CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    },
  }));
  try {
    assert.equal(run(), null);
    writeFileSync(
      path.join(state, "enabled-providers.json"),
      '{"version":1,"providers":["freetoken"]}\n',
      { mode: 0o600 },
    );
    const entry = run();
    assert.equal(entry.slug, "freetoken/qwen3.8-flash-next");
    assert.equal(entry.display_name, "Qwen3.8 Flash Next (Local)");
    assert.match(entry.description, /Local, on-demand/);
    assert.equal(entry.context_window, 65_792);
    assert.equal(entry.auto_compact_token_limit, 65_536);
    assert.deepEqual(entry.input_modalities, ["text"]);
    assert.equal(entry.supports_parallel_tool_calls, false);
    assert.equal(entry.apply_patch_tool_type, null);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

const grok = {
  slug: "grok-oauth/grok-4.5",
  displayName: "Grok 4.5 (OAuth)",
  description: "Grok through OAuth",
  priority: 1,
  defaultEffort: "high",
  reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
  contextWindow: 500000,
  autoCompact: 440000,
  inputModalities: ["text", "image"],
  compHash: "grok-oauth-grok-4-5-v1",
  multiAgentVersion: "v2",
};

test("routed catalog is exposed only when the active provider reaches the router", () => {
  // An absent base URL is the first-install case: setup has not written the
  // caller capability yet, but the catalog still needs to be buildable.
  assert.equal(routedCatalogConfigured(""), true);
  assert.equal(routedCatalogConfigured('model_provider = "openai"\n'), true);
  assert.equal(
    routedCatalogConfigured('openai_base_url = "https://foreign.invalid/v1"\n'),
    false,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
openai_base_url = "https://foreign.invalid/v1"
`),
    false,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
openai_base_url = "http://127.0.0.1:4102/_codex-router/test-caller-secret-with-sufficient-length/v1"
`),
    true,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
note = """
[fake.table]
"""
openai_base_url = "https://foreign.invalid/v1"
`),
    false,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
note = '''
[fake.table]
'''
openai_base_url = "https://foreign.invalid/v1"
`),
    false,
  );
  assert.equal(routedCatalogConfigured('model_provider = "custom"\n'), false);
  assert.equal(
    routedCatalogConfigured(`model_provider = "custom"

[model_providers.custom]
base_url = "http://127.0.0.1:4102/_codex-router/test-caller-secret-with-sufficient-length/v1"
wire_api = "responses"
`),
    true,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "custom"
note = """
[model_providers.custom]
base_url = "http://127.0.0.1:4102/_codex-router/test-caller-secret-with-sufficient-length/v1"
"""

[model_providers.custom]
base_url = "https://foreign.invalid/v1"
wire_api = "responses"
`),
    false,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "custom]id"

[model_providers."custom]id"]
base_url = "http://127.0.0.1:4102/_codex-router/test-caller-secret-with-sufficient-length/v1"
wire_api = "responses"
`),
    true,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
note = """
[fake.table]
`),
    false,
  );
  assert.equal(routedCatalogConfigured('model_provider = "custom"\n', "1"), true);
  assert.equal(routedCatalogConfigured('model_provider = "custom"\n', "0"), false);
});

test("routed models rewrite GPT identity text to the external model name", () => {
  const model = routedModel(template, grok);
  assert.equal(model.slug, "grok-oauth/grok-4.5");
  assert.equal(model.display_name, "Grok 4.5 (OAuth)");
  assert.match(model.base_instructions, /based on Grok 4\.5/);
  assert.doesNotMatch(model.base_instructions, /GPT-5/);
  assert.match(model.model_messages.instructions_template, /based on Grok 4\.5/);
  assert.doesNotMatch(model.model_messages.instructions_template, /GPT-5/);
  assert.equal(model.model_messages.instructions_variables.personality_default, "");
  assert.equal(model.multi_agent_version, "v2");
});

test("Threadspan routes render as visible conservative native-picker entries", () => {
  const slugs = [
    "delegate/grok-build/grok-4.6",
    "consult/grok-build/grok-4.6",
    "integrated/nous/deepseek/deepseek-v4-flash-0731",
    "consult/nous/deepseek/deepseek-v4-flash-0731",
    "integrated/nous/deepseek/deepseek-v4-pro-0813",
    "consult/nous/deepseek/deepseek-v4-pro-0813",
  ];
  for (const slug of slugs) {
    const registry = MODEL_BY_SLUG.get(slug);
    const picker = routedModel(template, registry);
    assert.equal(picker.slug, slug);
    assert.equal(picker.visibility, "list");
    assert.equal(picker.context_window, 131072);
    assert.equal(picker.auto_compact_token_limit, 112000);
    assert.equal(
      picker.comp_hash,
      undefined,
      `${slug} leaves compacted-history compatibility uncertified`,
    );
    assert.equal(picker.supports_search_tool, false);
    assert.deepEqual(picker.input_modalities, ["text"]);
  }
});

test("routed models are native v2 spawn-agent model overrides", () => {
  const model = routedModel(template, grok);
  assert.equal(model.visibility, "list");
  assert.equal(model.supported_in_api, true);
  assert.equal(model.multi_agent_version, "v2");
});

test("routed models advertise reasoning summaries only when the registry opts in", () => {
  // Default stays off: external models must not claim summary support untested.
  const plain = routedModel(template, grok);
  assert.equal(plain.supports_reasoning_summaries, false);
  assert.equal(plain.default_reasoning_summary, "none");
  const summarized = routedModel(template, {
    ...grok,
    supportsReasoningSummaries: true,
    defaultReasoningSummary: "auto",
  });
  assert.equal(summarized.supports_reasoning_summaries, true);
  assert.equal(summarized.default_reasoning_summary, "auto");
});

test("ClinePass routed models omit the unsupported reasoning-effort selector", () => {
  const clinepass = routedModel(template, { ...grok, requestProfile: "clinepass" });
  assert.equal("default_reasoning_level" in clinepass, false);
  assert.equal("supported_reasoning_levels" in clinepass, false);

  const normal = routedModel(template, grok);
  assert.equal(normal.default_reasoning_level, "high");
  assert.deepEqual(normal.supported_reasoning_levels, grok.reasoningLevels);
});

test("routed models advertise search and image detail only when the registry opts in", () => {
  // Defaults stay off: external models must not claim capabilities untested.
  const plain = routedModel(template, grok);
  assert.equal(plain.supports_search_tool, false);
  assert.equal(plain.supports_image_detail_original, false);
  const capable = routedModel(template, {
    ...grok,
    searchTool: { mode: "hosted" },
    supportsImageDetailOriginal: true,
  });
  assert.equal(capable.supports_search_tool, true);
  assert.equal(capable.supports_image_detail_original, true);
  const standalone = routedModel(template, {
    ...grok,
    searchTool: { mode: "standalone" },
  });
  assert.equal(standalone.supports_search_tool, true);
});

test("routed models can explicitly narrow inherited tool capabilities", () => {
  const plain = routedModel(template, grok);
  assert.equal(plain.supports_parallel_tool_calls, true);
  assert.equal("experimental_supported_tools" in plain, false);

  const narrowed = routedModel(template, {
    ...grok,
    supportsParallelToolCalls: false,
    experimentalSupportedTools: [],
  });
  assert.equal(narrowed.supports_parallel_tool_calls, false);
  assert.deepEqual(narrowed.experimental_supported_tools, []);
});

test("routed service tiers are explicit and never inherit a paid default", () => {
  const plain = routedModel(template, grok);
  assert.deepEqual(plain.service_tiers, []);
  assert.equal(plain.default_service_tier, null);

  const tiered = routedModel(template, {
    ...grok,
    serviceTiers: [
      { id: " priority ", name: " Fast ", description: " Guaranteed throughput. " },
    ],
  });
  assert.deepEqual(tiered.service_tiers, [
    { id: "priority", name: "Fast", description: "Guaranteed throughput." },
  ]);
  assert.equal(tiered.default_service_tier, null);
});

test("routed models inherit apply_patch unless the registry opts out", () => {
  const plain = routedModel(template, grok);
  assert.equal(plain.apply_patch_tool_type, "freeform");
  const noPatch = routedModel(template, {
    ...grok,
    supportsApplyPatchTool: false,
  });
  assert.equal(noPatch.apply_patch_tool_type, null);
});

test("routed models announce availability only when curated with NUX copy", () => {
  // Default stays null: an empty announcement card must never render.
  const plain = routedModel(template, grok);
  assert.equal(plain.availability_nux, null);
  const announced = routedModel(template, {
    ...grok,
    availabilityNux: "  Grok 4.5 now routes through your own X subscription.  ",
  });
  assert.deepEqual(announced.availability_nux, {
    message: "Grok 4.5 now routes through your own X subscription.",
  });
});

test("first capture seeds announcement state without announcing anything", () => {
  const { models, announcedAt } = annotateNewModelAnnouncements([grok], null, new Set(), 1000);
  assert.equal(models[0].availabilityNux, undefined);
  assert.equal(announcedAt.get(grok.slug), 0);
});

test("models new since the last capture announce for a window, then go quiet", () => {
  const seeded = new Map([["kimi-oauth/k3", 0]]);
  const now = 5000;
  const { models, announcedAt } = annotateNewModelAnnouncements([grok], seeded, new Set(), now);
  assert.equal(
    models[0].availabilityNux,
    "Grok 4.5 (OAuth) just landed in your model picker. It comes with a 500K-token context window and image input.",
  );
  assert.equal(announcedAt.get(grok.slug), now);
  // Within the window the copy persists across rebuilds; after it, silence.
  const later = annotateNewModelAnnouncements([grok], announcedAt, new Set(), now + 1);
  assert.ok(later.models[0].availabilityNux);
  const expired = annotateNewModelAnnouncements(
    [grok],
    announcedAt,
    new Set(),
    now + AUTO_ANNOUNCE_WINDOW_MS,
  );
  assert.equal(expired.models[0].availabilityNux, undefined);
  assert.equal(expired.announcedAt.get(grok.slug), now);
});

test("curated copy and locally curated models are left alone by auto-announce", () => {
  const seeded = new Map();
  const curated = { ...grok, availabilityNux: "Hand-written copy." };
  const { models } = annotateNewModelAnnouncements([curated], seeded, new Set(), 1000);
  assert.equal(models[0].availabilityNux, "Hand-written copy.");
  const userModel = { ...grok, slug: "deepseek/user-added" };
  const skipped = annotateNewModelAnnouncements(
    [userModel],
    seeded,
    new Set(["deepseek/user-added"]),
    1000,
  );
  assert.equal(skipped.models[0].availabilityNux, undefined);
});

test("routed models carry a migration prompt only when curated with upgradeTo", () => {
  const plain = routedModel(template, grok);
  assert.equal(plain.upgrade, null);
  const upgraded = routedModel(template, {
    ...grok,
    upgradeTo: {
      model: "kimi-oauth/k3",
      markdown: "# Introducing Kimi K3\n\nSwitch from {model_from} to {model_to}.\n",
    },
  });
  assert.deepEqual(upgraded.upgrade, {
    model: "kimi-oauth/k3",
    migration_markdown: "# Introducing Kimi K3\n\nSwitch from {model_from} to {model_to}.",
  });
});

test("unverified routed models retain conservative v1 collaboration", () => {
  const model = routedModel(template, {
    ...grok,
    slug: "example/model",
    multiAgentVersion: undefined,
  });
  assert.equal(model.multi_agent_version, "v1");
});

test("merged catalog preserves native GPT identity while rewriting routed models", () => {
  const merged = buildMergedCatalog({ models: [template] }, [grok]);
  const bySlug = new Map(merged.map((model) => [model.slug, model]));
  assert.match(bySlug.get("gpt-5.5").base_instructions, /based on GPT-5/);
  assert.equal(bySlug.get("gpt-5.5").supports_reasoning_summaries, false);
  assert.match(bySlug.get("grok-oauth/grok-4.5").base_instructions, /based on Grok 4\.5/);
  assert.doesNotMatch(bySlug.get("grok-oauth/grok-4.5").base_instructions, /GPT-5/);
});

test("merged catalog applies owner limits only to exact native GPT-5.6 tiers", () => {
  const targetSlugs = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
  const controls = [
    {
      slug: "gpt-5.6-cyber",
      context_window: 400_000,
      max_context_window: 400_000,
      auto_compact_token_limit: 360_000,
      comp_hash: "cyber",
    },
    {
      slug: "gpt-5.6-sol-wm",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      auto_compact_token_limit: 900_000,
      comp_hash: "sol-wm",
    },
    {
      slug: "gpt-5.3-codex-spark",
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: 80_000,
      comp_hash: "spark",
    },
  ];
  const targets = targetSlugs.map((slug) => ({
    ...template,
    slug,
    context_window: 272_000,
    max_context_window: 872_000,
    comp_hash: "3000",
  }));
  const merged = buildMergedCatalog(
    {
      models: [...targets, ...controls.map((model) => ({ ...template, ...model }))],
    },
    [],
  );
  const bySlug = new Map(merged.map((model) => [model.slug, model]));

  for (const slug of targetSlugs) {
    const model = bySlug.get(slug);
    assert.equal(model.context_window, 320_000, slug);
    assert.equal(model.max_context_window, 872_000, slug);
    assert.equal(model.auto_compact_token_limit, 272_000, slug);
    assert.equal(model.comp_hash, "3000", slug);
  }
  for (const expected of controls) {
    const model = bySlug.get(expected.slug);
    for (const field of [
      "context_window",
      "max_context_window",
      "auto_compact_token_limit",
      "comp_hash",
    ]) {
      assert.equal(model[field], expected[field], `${expected.slug} ${field}`);
    }
  }
});

test("merged catalog clones exactly two explicit native Sol profiles", () => {
  const nativeSol = {
    ...template,
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    description: "Native Sol",
    context_window: 272_000,
    max_context_window: 872_000,
    auto_compact_token_limit: null,
    effective_context_window_percent: 95,
    comp_hash: "3000",
    multi_agent_version: "v2",
    input_modalities: ["text", "image"],
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "max", description: "Deep" },
    ],
    supports_search_tool: true,
    experimental_supported_tools: ["apply_patch"],
  };
  const merged = buildMergedCatalog({ models: [nativeSol] }, []);
  const bySlug = new Map(merged.map((model) => [model.slug, model]));
  const normalizedBase = bySlug.get(nativeSol.slug);
  assert.equal(normalizedBase.context_window, 320_000);
  assert.equal(normalizedBase.auto_compact_token_limit, 272_000);
  assert.equal(NATIVE_PROFILE_MANIFEST.version, 1);
  assert.equal(NATIVE_PROFILE_MANIFEST.profiles.length, 2);

  const mutableFields = new Set([
    "slug",
    "display_name",
    "description",
    "priority",
    "context_window",
    "max_context_window",
    "auto_compact_token_limit",
  ]);
  const capabilities = (model) =>
    Object.fromEntries(
      Object.entries(model).filter(([field]) => !mutableFields.has(field)),
    );
  for (const spec of NATIVE_PROFILE_MANIFEST.profiles) {
    const profile = bySlug.get(spec.slug);
    assert.ok(profile, spec.slug);
    assert.equal(profile.context_window, spec.contextWindow, spec.slug);
    assert.equal(profile.max_context_window, spec.contextWindow, spec.slug);
    assert.equal(profile.auto_compact_token_limit, spec.autoCompact, spec.slug);
    assert.equal(profile.priority, spec.priority, spec.slug);
    assert.equal(profile.comp_hash, "3000", spec.slug);
    assert.equal(profile.multi_agent_version, "v2", spec.slug);
    assert.deepEqual(capabilities(profile), capabilities(normalizedBase), spec.slug);
  }
  assert.match(bySlug.get("native-profile/gpt-5.6-sol-1m").display_name, /Experimental/);
  assert.deepEqual(
    merged
      .filter((model) => String(model.slug).startsWith("native-profile/"))
      .map((model) => model.slug),
    [
      "native-profile/gpt-5.6-sol-600k",
      "native-profile/gpt-5.6-sol-1m",
    ],
  );
});

test("native profile namespace collisions fail before catalog publication", () => {
  const nativeSol = { ...template, slug: "gpt-5.6-sol", comp_hash: "3000" };
  assert.throws(
    () =>
      buildMergedCatalog(
        {
          models: [
            nativeSol,
            { ...template, slug: "native-profile/gpt-5.6-sol-600k" },
          ],
        },
        [],
      ),
    /reserved profile namespace/,
  );
  assert.throws(
    () =>
      buildMergedCatalog(
        { models: [nativeSol] },
        [{ ...grok, slug: "native-profile/gpt-5.6-sol-1m" }],
      ),
    /reserved native profile namespace/,
  );
  assert.throws(
    () =>
      assertNativeProfilesDisjoint(
        new Map([["native-profile/gpt-5.6-sol-600k", { provider: "future" }]]),
      ),
    /collides with the external model registry/,
  );
});

test("routed GPT-5.6 wrappers publish the owner limits without changing Grok", () => {
  for (const slug of [
    "commandcode/gpt-5.6-sol",
    "commandcode/gpt-5.6-terra",
    "commandcode/gpt-5.6-luna",
    "opencode-go-responses/gpt-5.6-luna",
  ]) {
    const registry = MODEL_BY_SLUG.get(slug);
    const picker = routedModel(template, registry);
    assert.equal(picker.context_window, 320_000, slug);
    assert.equal(picker.max_context_window, 320_000, slug);
    assert.equal(picker.auto_compact_token_limit, 272_000, slug);
    assert.equal(picker.comp_hash, registry.compHash, slug);
  }

  const grokRegistry = MODEL_BY_SLUG.get("grok-oauth/grok-4.5");
  const grokPicker = routedModel(template, grokRegistry);
  assert.equal(grokPicker.context_window, 500_000);
  assert.equal(grokPicker.max_context_window, 500_000);
  assert.equal(grokPicker.auto_compact_token_limit, 440_000);
  assert.equal(grokPicker.comp_hash, grokRegistry.compHash);
});

test("merged catalog preserves an explicit native reasoning summary capability", () => {
  const native = {
    ...template,
    supports_reasoning_summaries: true,
  };
  const merged = buildMergedCatalog({ models: [native] }, []);
  assert.equal(merged[0].supports_reasoning_summaries, true);
});

test("login-free catalogs contain only authenticated external models", () => {
  const merged = buildMergedCatalog({ models: [template] }, [grok], {
    includeNative: false,
  });
  assert.deepEqual(merged.map((model) => model.slug), ["grok-oauth/grok-4.5"]);
});

test("login-free catalog republishes external models under native slugs", () => {
  const kimi = {
    ...grok,
    slug: "kimi-oauth/k3",
    displayName: "Kimi K3 (OAuth)",
    priority: 2,
    compHash: "kimi-oauth-k3-v1",
  };
  const secondNative = {
    ...template,
    slug: "gpt-5.4",
    display_name: "GPT-5.4",
    priority: 20,
  };
  const { models, aliases } = buildLoginFreeCatalog(
    { models: [secondNative, template] },
    [grok, kimi],
  );

  assert.deepEqual(aliases, {
    "gpt-5.5": "grok-oauth/grok-4.5",
    "gpt-5.4": "kimi-oauth/k3",
  });

  const bySlug = new Map(models.map((model) => [model.slug, model]));
  assert.equal(bySlug.get("gpt-5.5").display_name, "Grok 4.5 (OAuth)");
  assert.equal(bySlug.get("gpt-5.5").visibility, "list");
  assert.equal(bySlug.get("gpt-5.5").priority, 10);
  assert.match(bySlug.get("gpt-5.5").base_instructions, /based on Grok 4\.5/);
  assert.equal(bySlug.get("gpt-5.4").display_name, "Kimi K3 (OAuth)");
  assert.equal(bySlug.get("grok-oauth/grok-4.5").visibility, "hide");
  assert.equal(bySlug.get("kimi-oauth/k3").visibility, "hide");
  assert.equal(
    models.some((model) => String(model.slug).startsWith("native-profile/")),
    false,
  );
});

test("login-free catalog keeps overflow models visible under their own slugs", () => {
  const overflow = {
    ...grok,
    slug: "kimi-oauth/kimi-for-coding",
    displayName: "K2.7 Coding (OAuth)",
    priority: 3,
    compHash: "kimi-oauth-kimi-for-coding-v1",
  };
  const { models, aliases } = buildLoginFreeCatalog(
    { models: [template] },
    [grok, overflow],
  );

  assert.deepEqual(aliases, { "gpt-5.5": "grok-oauth/grok-4.5" });
  const bySlug = new Map(models.map((model) => [model.slug, model]));
  assert.equal(bySlug.get("kimi-oauth/kimi-for-coding").visibility, "list");
  assert.equal(bySlug.get("grok-oauth/grok-4.5").visibility, "hide");
});

function withCredentialEnvironment(kimiHome, run) {
  const previousKimi = process.env.KIMI_CODE_HOME;
  const previousGrok = process.env.GROK_AUTH_PATH;
  const dir = mkdtempSync(path.join(os.tmpdir(), "catalog-login-free-"));
  if (kimiHome === "unconfigured") {
    process.env.KIMI_CODE_HOME = path.join(dir, "kimi-home");
  } else {
    const credentialsDir = path.join(dir, "kimi-home", "credentials");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(
      path.join(credentialsDir, "kimi-code.json"),
      JSON.stringify({
        access_token: "access-value",
        refresh_token: "refresh-value",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        scope: "kimi-code",
      }),
      { mode: 0o600 },
    );
    process.env.KIMI_CODE_HOME = path.join(dir, "kimi-home");
  }
  process.env.GROK_AUTH_PATH = path.join(dir, "grok", "auth.json");
  try {
    return run();
  } finally {
    if (previousKimi === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimi;
    if (previousGrok === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousGrok;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("login-free catalog does not assign slots to unauthenticated providers", () => {
  const kimi = {
    ...grok,
    slug: "kimi-oauth/k3",
    provider: "kimi-oauth",
    displayName: "Kimi K3 (OAuth)",
    priority: 2,
    compHash: "kimi-oauth-k3-v1",
  };
  withCredentialEnvironment("unconfigured", () => {
    // The credential file does not exist under this KIMI_CODE_HOME, so
    // kimi-oauth is not configured; its model must not take a slot.
    const { models, aliases } = buildLoginFreeCatalog(
      { models: [template] },
      [kimi],
    );
    assert.deepEqual(aliases, {});
    assert.deepEqual(models, []);
  });
});

test("login-free catalog assigns slots to models of credentialed providers", () => {
  const kimi = {
    ...grok,
    slug: "kimi-oauth/k3",
    provider: "kimi-oauth",
    displayName: "Kimi K3 (OAuth)",
    priority: 2,
    compHash: "kimi-oauth-k3-v1",
  };
  const unauthenticatedGrok = {
    ...grok,
    provider: "grok-oauth",
  };
  withCredentialEnvironment("configured", () => {
    // kimi-oauth has a live credential, grok-oauth does not: only the kimi
    // model may take the whitelist slot.
    const { models, aliases } = buildLoginFreeCatalog(
      { models: [template] },
      [kimi, unauthenticatedGrok],
    );
    assert.deepEqual(aliases, { "gpt-5.5": "kimi-oauth/k3" });
    const bySlug = new Map(models.map((model) => [model.slug, model]));
    assert.equal(bySlug.get("gpt-5.5").display_name, "Kimi K3 (OAuth)");
    assert.equal(bySlug.get("gpt-5.5").visibility, "list");
    assert.equal(bySlug.get("kimi-oauth/k3").visibility, "hide");
  });
});

test("effort vocabulary follows the installed codex build's enum history", () => {
  // max and ultra joined the enum in 0.143.0.
  const legacy = codexEffortVocabulary("codex-cli 0.142.5");
  assert.deepEqual(
    [...legacy].sort(),
    ["high", "low", "medium", "minimal", "xhigh"],
  );
  assert.ok(codexEffortVocabulary("codex-cli 0.143.0").has("max"));
  assert.ok(codexEffortVocabulary("codex-cli 0.147.0-alpha.1.2").has("ultra"));
  // A prerelease of the boundary build may predate the variants, and an
  // unknown version must clamp rather than risk an unparseable picker level.
  assert.ok(!codexEffortVocabulary("codex-cli 0.143.0-alpha.3").has("max"));
  assert.ok(!codexEffortVocabulary(undefined).has("max"));
});

test("efforts the installed codex build cannot parse clamp to the nearest supported tier", () => {
  const vocabulary = codexEffortVocabulary("codex-cli 0.141.0");
  const [deepseek] = clampModelEfforts(
    [
      {
        ...grok,
        defaultEffort: "max",
        reasoningLevels: [
          { effort: "low", description: "Faster reasoning" },
          { effort: "high", description: "Deep reasoning" },
          { effort: "max", description: "Maximum reasoning" },
        ],
      },
    ],
    vocabulary,
  );
  // Codex 0.141 drops unknown enum variants, so "max" must reach it as xhigh
  // (issue #57); the forwarder already folds xhigh back to the upstream max.
  assert.deepEqual(deepseek.reasoningLevels, [
    { effort: "low", description: "Faster reasoning" },
    { effort: "high", description: "Deep reasoning" },
    { effort: "xhigh", description: "Maximum reasoning" },
  ]);
  assert.equal(deepseek.defaultEffort, "xhigh");
});

test("clamped duplicates collapse onto the model's genuine entry for that tier", () => {
  const vocabulary = codexEffortVocabulary("codex-cli 0.141.0");
  const [opus] = clampModelEfforts(
    [
      {
        ...grok,
        defaultEffort: "max",
        reasoningLevels: [
          { effort: "xhigh", description: "Extended reasoning" },
          { effort: "max", description: "Maximum reasoning" },
        ],
      },
    ],
    vocabulary,
  );
  assert.deepEqual(opus.reasoningLevels, [
    { effort: "xhigh", description: "Extended reasoning" },
  ]);
  assert.equal(opus.defaultEffort, "xhigh");
});

test("models stay untouched when the installed build understands their efforts", () => {
  const vocabulary = codexEffortVocabulary("codex-cli 0.146.1");
  const original = {
    ...grok,
    defaultEffort: "max",
    reasoningLevels: [
      { effort: "high", description: "Deep reasoning" },
      { effort: "max", description: "Maximum reasoning" },
    ],
  };
  const [unchanged] = clampModelEfforts([original], vocabulary);
  assert.equal(unchanged, original);
});

test("native catalog cache is reusable only for the codex build that captured it", () => {
  const captured = {
    captured_with: "codex-cli 0.142.5",
    native_source_fingerprint: "account-a",
    models: [template],
  };

  assert.equal(nativeCatalogIsReusable(captured, "codex-cli 0.142.5"), true);
  assert.equal(nativeCatalogIsReusable(captured, "codex-cli 0.146.1"), false);
  // Account catalogs change independently of the binary version.
  assert.equal(
    nativeCatalogIsReusable(captured, "codex-cli 0.142.5", "account-b"),
    false,
  );
  assert.equal(
    nativeCatalogIsReusable(captured, "codex-cli 0.142.5", "account-a"),
    true,
  );
  // Unknown current version: no binary to re-ask, so keep what we have.
  assert.equal(nativeCatalogIsReusable(captured, undefined), true);
  // Un-stamped caches predate version tracking; re-capture when we can ask.
  assert.equal(nativeCatalogIsReusable({ models: [template] }, "codex-cli 0.146.1"), false);
  assert.equal(nativeCatalogIsReusable({ models: [template] }, undefined), true);
  // Invalid or empty caches are never reusable.
  assert.equal(nativeCatalogIsReusable(undefined, undefined), false);
  assert.equal(nativeCatalogIsReusable({ models: [] }, "codex-cli 0.146.1"), false);
});

test("native catalog merge preserves account visibility and bundled-only models", () => {
  const accountMini = {
    slug: "gpt-mini",
    visibility: "list",
    source: "account",
    model_messages: { instructions_template: "account instructions" },
  };
  const merged = mergeNativeCatalogs(
    {
      models: [
        accountMini,
        {
          slug: "gpt-spark",
          visibility: "list",
          model_messages: { instructions_template: "spark instructions" },
        },
      ],
    },
    {
      models: [
        {
          slug: "gpt-mini",
          visibility: "hide",
          source: "bundled",
          base_instructions: "bundled instructions",
        },
        { slug: "gpt-bundled-only", visibility: "list" },
      ],
    },
  );
  assert.deepEqual(merged.models, [
    {
      ...accountMini,
      base_instructions: "bundled instructions",
    },
    {
      slug: "gpt-spark",
      visibility: "list",
      model_messages: { instructions_template: "spark instructions" },
      base_instructions: "spark instructions",
    },
    { slug: "gpt-bundled-only", visibility: "list" },
  ]);
});

test("native catalog merge never loses non-empty bundled metadata", () => {
  const merged = mergeNativeModel(
    {
      slug: "gpt-5.6-luna",
      additional_speed_tiers: [],
      service_tiers: [],
      input_modalities: [],
      experimental_supported_tools: [],
      include_apps_usage_instructions: undefined,
      model_messages: {},
    },
    {
      slug: "gpt-5.6-luna",
      additional_speed_tiers: ["fast"],
      service_tiers: [
        { id: "priority", name: "Fast", description: "1.5x speed" },
      ],
      input_modalities: ["text", "image"],
      experimental_supported_tools: ["web_search"],
      include_apps_usage_instructions: true,
      model_messages: { instructions_template: "bundled instructions" },
    },
  );
  assert.deepEqual(merged.additional_speed_tiers, ["fast"]);
  assert.deepEqual(merged.service_tiers, [
    { id: "priority", name: "Fast", description: "1.5x speed" },
  ]);
  assert.deepEqual(merged.input_modalities, ["text", "image"]);
  assert.deepEqual(merged.experimental_supported_tools, ["web_search"]);
  assert.equal(merged.include_apps_usage_instructions, true);
  assert.deepEqual(merged.model_messages, {
    instructions_template: "bundled instructions",
  });
  assert.equal(
    mergeNativeModel(
      { slug: "gpt-5.6-luna", visibility: "list" },
      { slug: "gpt-5.6-luna", visibility: "hide" },
    ).visibility,
    "list",
  );
});

test("bundled backfill is an allowlist, not every empty account field", () => {
  const merged = mergeNativeModel(
    {
      slug: "gpt-5.6-luna",
      // An account that lost its effort ladder is expressing exactly that;
      // resurrecting bundled's ladder would offer efforts it cannot spend.
      supported_reasoning_levels: [],
      // Unknown fields never backfill: the allowlist is the whole contract,
      // so a future schema field starts account-authoritative by default.
      some_future_field: "",
      // Empty on both sides stays empty rather than inventing a value.
      additional_speed_tiers: [],
    },
    {
      slug: "gpt-5.6-luna",
      supported_reasoning_levels: ["low", "high"],
      some_future_field: "bundled-value",
      additional_speed_tiers: [],
    },
  );
  assert.deepEqual(merged.supported_reasoning_levels, []);
  assert.equal(merged.some_future_field, "");
  assert.deepEqual(merged.additional_speed_tiers, []);
});

test("account-only models satisfy the strict custom-catalog instruction schema", () => {
  const native = mergeNativeCatalogs(
    {
      models: [
        {
          slug: "gpt-spark",
          visibility: "list",
          model_messages: { instructions_template: "spark instructions" },
        },
      ],
    },
    { models: [{ slug: "other", base_instructions: "other instructions" }] },
  );
  const [spark] = native.models;
  assert.equal(spark.base_instructions, "spark instructions");
  const [published] = buildMergedCatalog(native, []);
  assert.equal(published.supports_parallel_tool_calls, true);
  const [explicitlyDisabled] = buildMergedCatalog(
    { models: [{ ...spark, supports_parallel_tool_calls: false }] },
    [],
  );
  assert.equal(explicitlyDisabled.supports_parallel_tool_calls, false);
});

// The bundled catalog's base_instructions equals the account template with
// `{{ personality }}` replaced by `instructions_variables.personality_default`
// (verified against codex-cli for gpt-5.4, gpt-5.4-mini, and gpt-5.5).
// Account-only models must get the same treatment: the literal placeholder
// must never reach a system prompt.
test("derived base_instructions substitutes template variable defaults", () => {
  assert.equal(
    deriveBaseInstructions({
      instructions_template: "You are Codex.\n{{ personality }}\nBe fast.",
      instructions_variables: {
        personality_default: "# Personality\nStay neutral.",
        personality_friendly: "# Personality\nBe warm.",
      },
    }),
    "You are Codex.\n# Personality\nStay neutral.\nBe fast.",
  );
  // No default for the placeholder: strip it rather than leaking the token.
  assert.equal(
    deriveBaseInstructions({
      instructions_template: "Intro {{ tone }} outro.",
      instructions_variables: {},
    }),
    "Intro  outro.",
  );
  assert.equal(
    deriveBaseInstructions({ instructions_template: "plain" }),
    "plain",
  );
  assert.equal(deriveBaseInstructions(undefined), undefined);
});

test("no template placeholder survives into any merged base_instructions", () => {
  const merged = mergeNativeCatalogs(
    {
      models: [
        {
          slug: "gpt-spark",
          model_messages: {
            instructions_template: "Spark. {{ personality }} End.",
            instructions_variables: { personality_default: "Calm." },
          },
        },
        {
          slug: "gpt-undefaulted",
          model_messages: {
            instructions_template: "Head {{ mystery }} tail.",
            instructions_variables: {
              // A default may itself carry a placeholder; it must be stripped,
              // not substituted recursively.
              mystery_default: "nested {{ personality }} token",
            },
          },
        },
      ],
    },
    undefined,
  );
  for (const model of merged.models) {
    assert.equal(typeof model.base_instructions, "string");
    assert.doesNotMatch(model.base_instructions, /\{\{[\s\S]*?\}\}/);
  }
  assert.equal(merged.models[0].base_instructions, "Spark. Calm. End.");
});

test("duplicate account slugs collapse to the first occurrence", () => {
  const merged = mergeNativeCatalogs(
    {
      models: [
        { slug: "gpt-dupe", visibility: "list", base_instructions: "first" },
        { slug: "gpt-dupe", visibility: "hide", base_instructions: "second" },
      ],
    },
    { models: [{ slug: "gpt-dupe", base_instructions: "bundled" }] },
  );
  assert.equal(merged.models.length, 1);
  assert.equal(merged.models[0].base_instructions, "first");
  assert.equal(merged.models[0].visibility, "list");
});

test("native listed models follow the local subagent opt-in", () => {
  // Upstream still ships gpt-5.6-luna as v1 while it runs fine on the v2
  // backend, and spawn_agent filters child models on that static value.
  const native = [
    { slug: "gpt-5.6-terra", visibility: "list", multi_agent_version: "v2" },
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "codex-auto-review", visibility: "hide", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "all",
    enabled: [],
    disabled: [],
  });
  assert.equal(promoted[1].multi_agent_version, "v2");
  // Hidden native entries are never advertised as spawn targets.
  assert.equal(promoted[2].multi_agent_version, "v1");
});

test("native promotion honours disabled models and picker-hidden slugs", () => {
  const native = [
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "gpt-5.5", visibility: "list", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(
    native,
    { mode: "all", enabled: [], disabled: ["gpt-5.6-luna"] },
    new Set(["gpt-5.5"]),
  );
  assert.equal(promoted[0].multi_agent_version, "v1");
  assert.equal(promoted[1].multi_agent_version, "v1");
});

test("selected subagent mode only promotes the chosen native models", () => {
  const native = [
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "gpt-5.4", visibility: "list", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "selected",
    enabled: ["gpt-5.6-luna"],
    disabled: [],
  });
  assert.equal(promoted[0].multi_agent_version, "v2");
  assert.equal(promoted[1].multi_agent_version, "v1");
});

test("proven subagent mode still promotes upstream-verified v2-backend slugs", () => {
  // gpt-5.6-luna is shipped as v1 by upstream but runs on the v2 backend, so
  // it must be promoted even in the conservative proven mode; an unverified
  // native slug keeps its upstream value.
  const native = [
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "gpt-5.4", visibility: "list", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "proven",
    enabled: [],
    disabled: [],
  });
  assert.equal(promoted[0].multi_agent_version, "v2");
  assert.equal(promoted[1].multi_agent_version, "v1");
});

test("an upstream-verified slug still honours disabled and picker-hidden", () => {
  const native = [{ slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" }];
  const promoted = promoteNativeMultiAgent(
    native,
    { mode: "proven", enabled: [], disabled: ["gpt-5.6-luna"] },
  );
  assert.equal(promoted[0].multi_agent_version, "v1");
  const hidden = promoteNativeMultiAgent(
    native,
    { mode: "proven", enabled: [], disabled: [] },
    new Set(["gpt-5.6-luna"]),
  );
  assert.equal(hidden[0].multi_agent_version, "v1");
});

test("a ChatGPT-plan model drives the same advertisement as a routed engine", async () => {
  const { applyVisionBridge, nativeVisionCandidates, resolveVisionEngine } = await import(
    "../src/vision-bridge.mjs"
  );
  const deepseek = {
    ...grok,
    slug: "deepseek/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    gatewayModel: "deepseek-v4-flash",
    inputModalities: ["text"],
    compHash: "deepseek-v4-flash-native-bridge-v1",
  };
  // The native capture is snake_case, the registry is camelCase, and both have
  // to reach the same advertisement rule.
  const capture = [
    {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      visibility: "list",
      priority: 3,
      input_modalities: ["text", "image"],
    },
  ];

  const engine = resolveVisionEngine(() => nativeVisionCandidates(capture), {
    enabled: true,
    engine: "gpt-5.6-luna",
  });
  const [bridged] = applyVisionBridge([deepseek], engine);
  assert.deepEqual(routedModel(template, bridged).input_modalities, ["text", "image"]);

  // A model the operator took out of the picker is not theirs to spend, so it
  // cannot resolve, and the advertisement goes with it.
  const hidden = resolveVisionEngine(
    () => nativeVisionCandidates(capture, new Set(["gpt-5.6-luna"])),
    { enabled: true, engine: "gpt-5.6-luna" },
  );
  assert.equal(hidden, undefined);
  assert.deepEqual(
    routedModel(template, applyVisionBridge([deepseek], hidden)[0]).input_modalities,
    ["text"],
  );
});

test("a bridged text-only model advertises image input, and only through the bridge", async () => {
  const { applyVisionBridge } = await import("../src/vision-bridge.mjs");
  const deepseek = {
    ...grok,
    slug: "deepseek/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    gatewayModel: "deepseek-v4-pro",
    inputModalities: ["text"],
    compHash: "deepseek-v4-pro-v1",
  };

  // Off, or with no engine to read images with, the catalog repeats the
  // registry's honest declaration and Codex refuses the paste.
  assert.deepEqual(routedModel(template, deepseek).input_modalities, ["text"]);

  const [bridged] = applyVisionBridge([deepseek], grok);
  const entry = routedModel(template, bridged);
  assert.deepEqual(entry.input_modalities, ["text", "image"]);
  // The bridge is router state, not a picker field: nothing about the engine
  // leaks into what Codex reads.
  assert.equal(entry.visionBridgeEngine, undefined);
  // Advertising image input is not a claim about detail handling.
  assert.equal(entry.supports_image_detail_original, false);
});
