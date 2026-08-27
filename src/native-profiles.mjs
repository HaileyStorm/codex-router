// Router-owned picker profiles for native OpenAI models. These slugs exist
// only in the merged Codex catalog; the router rewrites them to the exact
// native model immediately before dispatch. Keeping this mapping separate
// from MODEL_BY_SLUG prevents LiteLLM/provider routing from claiming them.

export const NATIVE_PROFILE_MANIFEST = Object.freeze({
  version: 1,
  profiles: Object.freeze([
    Object.freeze({
      slug: "native-profile/gpt-5.6-sol-600k",
      nativeModel: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol 600K",
      description:
        "Deliberate native Sol profile with a 600K context window; retains more history and may use allowance faster.",
      priority: 90,
      contextWindow: 600_000,
      autoCompact: 480_000,
    }),
    Object.freeze({
      slug: "native-profile/gpt-5.6-sol-1m",
      nativeModel: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol 1M (Experimental)",
      description:
        "Experimental native Sol profile with a 1M context window; exceeds the current captured 872K maximum and may use allowance faster.",
      priority: 91,
      contextWindow: 1_000_000,
      autoCompact: 800_000,
    }),
  ]),
});

const NATIVE_PROFILE_BY_SLUG = new Map(
  NATIVE_PROFILE_MANIFEST.profiles.map((profile) => [profile.slug, profile]),
);

export function nativeProfile(slug) {
  return NATIVE_PROFILE_BY_SLUG.get(String(slug || ""));
}

export function isNativeProfileNamespace(slug) {
  return /^native-profile\//.test(String(slug || ""));
}

export function assertNativeProfilesDisjoint(modelBySlug) {
  for (const profile of NATIVE_PROFILE_MANIFEST.profiles) {
    if (modelBySlug.has(profile.slug)) {
      throw new Error(
        `Native profile slug collides with the external model registry: ${profile.slug}`,
      );
    }
  }
}
