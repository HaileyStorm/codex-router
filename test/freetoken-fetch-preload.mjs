const productionOrigin = "http://127.0.0.1:1919";
const replacementOrigin = process.env.MODEL_ROUTER_TEST_FREETOKEN_REWRITE_ORIGIN;

if (!replacementOrigin) {
  throw new Error("MODEL_ROUTER_TEST_FREETOKEN_REWRITE_ORIGIN is required by the test preload.");
}

const replacement = new URL(replacementOrigin);
if (
  replacement.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(replacement.hostname) ||
  replacement.username ||
  replacement.password ||
  replacement.pathname !== "/" ||
  replacement.search ||
  replacement.hash
) {
  throw new Error("The FreeToken test rewrite must target an HTTP loopback origin.");
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = function testOnlyFreeTokenFetch(input, init) {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw);
  if (url.origin !== productionOrigin) return nativeFetch(input, init);
  const rewritten = `${replacement.origin}${url.pathname}${url.search}${url.hash}`;
  if (input instanceof Request) return nativeFetch(new Request(rewritten, input), init);
  return nativeFetch(rewritten, init);
};
