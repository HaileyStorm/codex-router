// Hosted search is executed by an upstream Responses provider, not by Codex.
// A client may advertise it on every request even for a coding-only task.
// Keep client-executed tools usable without pretending Nous hosts that search.
const HOSTED_SEARCH_TYPES = new Set(["web_search", "web_search_preview"]);
export const NOUS_HOSTED_SEARCH_NOTICE =
  "Tool availability: Nous Direct cannot execute the client-advertised hosted web-search tool. " +
  "That hosted tool is unavailable on this route; do not call it or claim to have used it. " +
  "If the task requires that capability and no suitable authorized client tool is available, " +
  "report the missing capability and ask the parent to use a compatible search route. " +
  "Do not silently switch providers or fabricate search results.";

const requiredSearchError = () => ({
  status: 400,
  error: {
    type: "local_nous_tool_unavailable",
    message: "This request requires hosted web search, which Nous Direct cannot execute. " +
      "Use client-side standalone search in a compatible native profile or select a search-capable provider; the request was not sent to Nous.",
  },
});

export function prepareNousToolAvailability(payload) {
  if (!Array.isArray(payload?.tools)) return { payload, omitted: [] };
  const hosted = payload.tools.filter((tool) => HOSTED_SEARCH_TYPES.has(tool?.type));
  if (!hosted.length) return { payload, omitted: [] };
  const tools = payload.tools.filter((tool) => !HOSTED_SEARCH_TYPES.has(tool?.type));
  const choice = payload.tool_choice;
  if (HOSTED_SEARCH_TYPES.has(choice?.type) || (choice === "required" && tools.length === 0)) {
    return { ...requiredSearchError(), omitted: [] };
  }
  // Preserve malformed instructions for the strict adapter to reject; do not
  // coerce user data into text or overwrite it with a capability notice.
  if (payload.instructions !== undefined && typeof payload.instructions !== "string") {
    return { payload, omitted: [] };
  }
  return {
    payload: {
      ...payload,
      tools,
      instructions: payload.instructions
        ? `${payload.instructions}\n\n${NOUS_HOSTED_SEARCH_NOTICE}`
        : NOUS_HOSTED_SEARCH_NOTICE,
    },
    omitted: [...new Set(hosted.map((tool) => tool.type))],
  };
}
