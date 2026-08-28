# Qwen3.8 Flash Next (Local)

The `freetoken/qwen3.8-flash-next` picker row targets the owner-managed
FreeToken server at `http://127.0.0.1:1919/v1`. It is visible only after the
operator explicitly enables `freetoken`; updates never enable it by default.

The checked route is bound to served model
`Qwen3.8-Flash-Next-NVFP4-7b719225`; the integration was validated against
FreeToken source commit `33b887604c99375f96cc524310ff5211a2b8e43e`. It is keyless, loopback-only,
text-only, and limited to one in-flight request. The router accepts at most 255
output tokens, advertises a 65,792-token context window, and asks Codex to
compact at 65,536. FreeToken's tokenizer remains the final authority for the
prompt-plus-output boundary.

Before every chat dispatch the router performs a fresh `GET /health` and
requires exactly `status=ok`, `maintenance=serving`, and the served model ID
above. This attests the live model identity, not the server's source revision.
A stopped, loading, or wrong-model endpoint returns an actionable local 503
before the chat body is sent. There is no provider fallback or retry.

Enable the row explicitly with:

```sh
bin/model-router codex providers enable freetoken
```

The server is on-demand and is not started by the router. A no-inference wiring
check may inspect only `/health`, `/v1/models`, and `/v1/cache/status`; it must
not call chat completions. Fully restart Codex Desktop after the router catalog
is republished before judging picker visibility.

The macOS tray intentionally uses its neutral CPU fallback icon for this
owner-local runtime; no third-party provider brand applies.
