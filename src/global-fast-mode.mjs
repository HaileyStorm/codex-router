import { readFileSync } from "node:fs";

import { CONFIG_PATH } from "./paths.mjs";
import { scanTomlDocument, tomlStringValue } from "./toml-structure.mjs";

const FAST_CONFIG_VALUES = new Set(["fast", "priority"]);

function configuredServiceTier(document) {
  const profile = tomlStringValue(document, [], "profile");
  if (profile) {
    const profileTier = tomlStringValue(document, ["profiles", profile], "service_tier");
    if (profileTier !== undefined) {
      return { value: profileTier, source: `profiles.${profile}.service_tier` };
    }
  }
  return {
    value: tomlStringValue(document, [], "service_tier"),
    source: "service_tier",
  };
}

// The Desktop's Settings -> Speed row and composer shortcut both persist this
// value through App Server config/batchWrite. Read that same document instead
// of inventing a second router-owned toggle. A malformed or unreadable config
// fails closed to normal speed: Fast costs more, so stale per-thread state may
// not silently keep it enabled when the owner-visible global state is unknown.
export function readGlobalFastModeIntent(configPath = CONFIG_PATH) {
  try {
    const document = scanTomlDocument(readFileSync(configPath, "utf8"));
    const configured = configuredServiceTier(document);
    const enabled = FAST_CONFIG_VALUES.has(configured.value);
    return {
      enabled,
      configuredTier: enabled ? configured.value : null,
      source: configured.source,
      status: enabled ? "enabled" : "disabled",
    };
  } catch {
    return {
      enabled: false,
      configuredTier: null,
      source: null,
      status: "unavailable",
    };
  }
}

function catalogFastTier(model) {
  const serviceTiers = catalogServiceTierIds(model);
  if (serviceTiers.has("priority")) return "priority";
  if (serviceTiers.has("fast")) return "fast";
  return null;
}

function catalogServiceTierIds(model) {
  const serviceTiers = Array.isArray(model?.service_tiers) ? model.service_tiers : [];
  return new Set(
    serviceTiers
      .map((tier) => (typeof tier === "string" ? tier : tier?.id))
      .filter((tier) => typeof tier === "string" && tier.length > 0),
  );
}

export function applyGlobalFastMode(
  payload,
  {
    requestedModel,
    routed = false,
    catalog = [],
    intent = readGlobalFastModeIntent(),
  } = {},
) {
  const incomingTier = payload.service_tier;
  const model = catalog.find((candidate) => candidate?.slug === requestedModel);
  const declaredTiers = catalogServiceTierIds(model);
  const preservedRoutedTier =
    routed &&
    typeof incomingTier === "string" &&
    !FAST_CONFIG_VALUES.has(incomingTier) &&
    declaredTiers.has(incomingTier)
      ? incomingTier
      : null;
  // The global switch is authoritative at the safe request boundary. Remove a
  // stale composer/thread Fast value first. A routed provider's independently
  // selected non-Fast tier survives only when its canonical catalog row
  // declares that exact wire value.
  delete payload.service_tier;
  if (preservedRoutedTier) payload.service_tier = preservedRoutedTier;

  if (intent.status === "unavailable") {
    return { ...intent, effective: false, reason: "global_state_unavailable" };
  }
  if (!intent.enabled) {
    return { ...intent, effective: false, reason: "global_disabled" };
  }
  const tier = catalogFastTier(model);
  if (!tier) {
    return {
      ...intent,
      effective: false,
      reason: routed ? "external_route_not_fast_capable" : "model_not_fast_capable",
    };
  }

  payload.service_tier = tier;
  return {
    ...intent,
    effective: true,
    effectiveTier: tier,
    reason: routed ? "enabled_for_external_route" : "enabled",
  };
}
