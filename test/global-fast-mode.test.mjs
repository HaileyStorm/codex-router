import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyGlobalFastMode,
  readGlobalFastModeIntent,
} from "../src/global-fast-mode.mjs";

const fastCatalog = [
  {
    slug: "gpt-5.6-sol",
    service_tiers: [{ id: "priority", name: "Fast" }],
    additional_speed_tiers: ["fast"],
  },
  {
    slug: "external-fast",
    service_tiers: [{ id: "priority", name: "Fast" }],
    additional_speed_tiers: ["fast"],
  },
  {
    slug: "external-flex",
    service_tiers: [{ id: "flex", name: "Flex" }],
    additional_speed_tiers: [],
  },
  {
    slug: "additional-only",
    service_tiers: [],
    additional_speed_tiers: ["fast"],
  },
  { slug: "plain-native", service_tiers: [], additional_speed_tiers: [] },
];

test("global Fast intent reads root and active-profile settings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "global-fast-config-"));
  const config = path.join(root, "config.toml");
  try {
    writeFileSync(config, 'service_tier = "priority"\n');
    assert.deepEqual(readGlobalFastModeIntent(config), {
      enabled: true,
      configuredTier: "priority",
      source: "service_tier",
      status: "enabled",
    });

    writeFileSync(
      config,
      'profile = "work"\nservice_tier = "priority"\n\n[profiles.work]\nservice_tier = "default"\n',
    );
    assert.deepEqual(readGlobalFastModeIntent(config), {
      enabled: false,
      configuredTier: null,
      source: "profiles.work.service_tier",
      status: "disabled",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global Fast intent fails closed on unavailable or ambiguous config", () => {
  assert.deepEqual(readGlobalFastModeIntent("/definitely/missing/config.toml"), {
    enabled: false,
    configuredTier: null,
    source: null,
    status: "unavailable",
  });

  const root = mkdtempSync(path.join(os.tmpdir(), "global-fast-invalid-"));
  const config = path.join(root, "config.toml");
  try {
    writeFileSync(config, 'service_tier = "priority"\nservice_tier = "default"\n');
    assert.equal(readGlobalFastModeIntent(config).status, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global Fast applies only to eligible native models and clears stale tiers", () => {
  const enabled = {
    enabled: true,
    configuredTier: "priority",
    source: "service_tier",
    status: "enabled",
  };
  const disabled = {
    enabled: false,
    configuredTier: null,
    source: "service_tier",
    status: "disabled",
  };

  const native = { model: "gpt-5.6-sol", service_tier: "default", input: "keep" };
  const nativeStatus = applyGlobalFastMode(native, {
    requestedModel: "gpt-5.6-sol",
    catalog: fastCatalog,
    intent: enabled,
  });
  assert.equal(native.service_tier, "priority");
  assert.equal(native.input, "keep");
  assert.equal(nativeStatus.effective, true);

  const external = { model: "external", service_tier: "priority" };
  assert.equal(
    applyGlobalFastMode(external, {
      requestedModel: "external",
      routed: true,
      catalog: fastCatalog,
      intent: enabled,
    }).reason,
    "external_route_not_fast_capable",
  );
  assert.equal(external.service_tier, undefined);

  const supportedExternal = { model: "external-fast", service_tier: "default" };
  assert.equal(
    applyGlobalFastMode(supportedExternal, {
      requestedModel: "external-fast",
      routed: true,
      catalog: fastCatalog,
      intent: enabled,
    }).reason,
    "enabled_for_external_route",
  );
  assert.equal(supportedExternal.service_tier, "priority");

  const flexExternal = { model: "external-flex", service_tier: "flex" };
  assert.equal(
    applyGlobalFastMode(flexExternal, {
      requestedModel: "external-flex",
      routed: true,
      catalog: fastCatalog,
      intent: enabled,
    }).reason,
    "external_route_not_fast_capable",
  );
  assert.equal(flexExternal.service_tier, "flex");

  const additionalOnly = { model: "additional-only", service_tier: "priority" };
  assert.equal(
    applyGlobalFastMode(additionalOnly, {
      requestedModel: "additional-only",
      catalog: fastCatalog,
      intent: enabled,
    }).reason,
    "model_not_fast_capable",
  );
  assert.equal(additionalOnly.service_tier, undefined);

  const unsupported = { model: "plain-native", service_tier: "priority" };
  assert.equal(
    applyGlobalFastMode(unsupported, {
      requestedModel: "plain-native",
      catalog: fastCatalog,
      intent: enabled,
    }).reason,
    "model_not_fast_capable",
  );
  assert.equal(unsupported.service_tier, undefined);

  const stale = { model: "gpt-5.6-sol", service_tier: "priority" };
  assert.equal(
    applyGlobalFastMode(stale, {
      requestedModel: "gpt-5.6-sol",
      catalog: fastCatalog,
      intent: disabled,
    }).reason,
    "global_disabled",
  );
  assert.equal(stale.service_tier, undefined);
});
