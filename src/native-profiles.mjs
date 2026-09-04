// Router-owned picker profiles for native OpenAI models. These slugs exist
// only in the merged Codex catalog; the router rewrites them to the exact
// native model immediately before dispatch. Keeping this mapping separate
// from MODEL_BY_SLUG prevents LiteLLM/provider routing from claiming them.

export const NATIVE_PROFILE_MANIFEST = Object.freeze({
  version: 2,
  profiles: Object.freeze([
    Object.freeze({
      slug: "native-profile/gpt-6-astra-1m",
      nativeModel: "gpt-6-astra",
      displayName: "GPT-6 Astra 1M (Experimental)",
      description:
        "Experimental native Astra profile with a 1M context window and later compaction; the current native catalog advertises an 872K maximum, so use only for explicit acceptance testing or work that needs the larger envelope.",
      priority: 2,
      contextWindow: 1_000_000,
      autoCompact: 850_000,
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
