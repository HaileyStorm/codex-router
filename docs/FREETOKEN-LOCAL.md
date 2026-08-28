# Qwen3.8 Flash Next (Local)

The `freetoken/qwen3.8-flash-next` picker row targets the owner-managed
FreeToken server at `http://127.0.0.1:1919/v1`. It is visible only after the
operator explicitly enables `freetoken`; updates never enable it by default.
The server is on-demand and the router does not start or supervise it.

The route is bound to served model
`Qwen3.8-Flash-Next-NVFP4-FP8-344f3a68` and FreeToken source commit
`24cfb86b99ab0280a8263680496726642e54ddc4`. It is keyless, HTTP loopback-only,
text-only, and limited to one in-flight request. Do not change the bind to
`0.0.0.0`; remote use needs a separately authorized, owner-controlled
authenticated tunnel or proxy.

Responses (`/v1/responses`) is the primary Codex route. The forwarder also
accepts Chat Completions (`/v1/chat/completions`) for compatible local clients.
Both surfaces preserve the selected `off`, `low`, `medium`, or `xhigh`
reasoning effort; `xhigh` is the default. The catalog advertises the served
65,792-token context window and asks Codex to compact at 56,000, leaving about
9.8K tokens for output and dispatch headroom. FreeToken remains the final
authority for the total input-plus-output boundary.

Before every generation dispatch, inside the shared one-request lane, the
router performs fresh unauthenticated checks in this order:

1. `GET /health`: `status=ok` and `maintenance=serving`.
2. `GET /v1/models`: the exact model ID with both `context_length=65792` and
   `max_model_len=65792`.
3. `GET /v1/cache/status`: `state=serving`.

The model and cache checks run together only after health passes. A stopped,
loading, wrong-model, wrong-context, or rebuilding endpoint returns an
actionable local 503 before any prompt is sent. No Authorization header is sent
to FreeToken, and there is no retry or provider fallback.

Enable the row explicitly with:

```sh
bin/model-router codex providers enable freetoken
```

A no-inference wiring check may inspect only `/health`, `/v1/models`, and
`/v1/cache/status`; it must not call either generation endpoint. Fully restart
Codex Desktop after the router catalog is republished before judging picker
visibility.

The exact mixed-FP8, BS1, `qwen3_coder` build passed an owner-private live
65,536-input-plus-256-output acceptance at the source revision above, including
identical cold/warm output and reasoning. That proves the served envelope, not
an uptime SLA: the server was stopped after the run, and a cold 64K prefill took
about 8.4 minutes. Long-context callers should allow at least 1,200 seconds;
ordinary requests should allow at least 300 seconds.

No compact/resume compatibility certificate is claimed yet, so the picker row
intentionally omits `comp_hash`. Native compact-and-resume acceptance is a
separate gate.

The macOS tray intentionally uses its neutral CPU fallback icon for this
owner-local runtime; no third-party provider brand applies.
