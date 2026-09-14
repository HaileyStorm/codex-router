---
name: codex-router
description: Use when a verified custom (non-OpenAI) model needs Codex native tool routing or model-inheritance guidance.
---

# Codex Router (custom models in the Codex app)

Apply this skill only when runtime model/provider evidence identifies a custom route through codex-router. Tool names alone do not identify the provider. For native OpenAI sessions, use the available native tool schemas directly.

## How your tools work

- The app's native tools appear in your tool list with flattened names:
  `codex_app__create_thread`, `codex_app__list_threads`,
  `mcp__node_repl__js`, `mcp__peekaboo__create_task`, and so on.
- Call them with exactly those names. The router restores the original
  namespace (for example `create_thread` in `codex_app`) before the app
  sees the call, so the app executes it natively.
- The router never executes an app tool. It only relays definitions and
  results. If a call fails, fix your arguments; do not try to run the tool
  yourself.
- Never spawn a side-channel driver. Do not start your own node_repl
  process, do not fake MCP metadata, do not write driver scripts. The tools
  you need are already in your tool list.

## Task-specific references

- Threads, automations, navigation: read `codex-app-threads`.
- In-app browser: read `codex-in-app-browser`.
- Computer use: read `codex-computer-use`.

## When a tool rejects your arguments

The app answers `received invalid arguments.` when you missed a required
field. Stop guessing. Read the matching skill for the exact shape, then
retry once with the correct arguments. Repeated guessing burns tokens and
turns.

## Golden rules

1. Use the tools you were given. Do not build workarounds.
2. Read the companion skill before the relevant work.
3. When a call fails, fix the arguments from the skill, then retry.

## Spawned threads and model inheritance

For a new local Codex thread, preserve an explicit user model. Otherwise follow the shared role policy: Astra controls design and synthesis; eligible bounded work prefers Nous V4.1 Flash Max, with Luna Max fallback. Do not accidentally inherit an external parent model into private or incompatible work. The router preserves explicit model choices. Follow-up messages retain the target
thread's settings, and cloud tasks choose their model outside this relay.

## What the token and usage numbers mean

- The router meter records provider-reported counts verbatim. When the
  provider reports `input_tokens: 0`, the router substitutes a byte-based
  estimate and stores it in a separate `estimatedInputTokens` field; the
  provider's zero is preserved in the row. Treat `estimatedInputTokens` as
  an approximation, never as a real provider count.
- A turn whose upstream stream dies mid-flight is recorded with status 502
  and a `streamAborted` marker. A client cancel records status 0. If you see
  many `streamAborted` rows, the upstream connection is flaky; do not treat
  them as model behavior.
- The app's displayed context window is 95% of the model's advertised
  window. The per-turn input number you see in the app can include the
  estimate; the running total can therefore exceed the real context usage.

## If the session seems to stop mid-task

If provider diagnosis needs the meter, check its size first and read a bounded tail of `~/.codex/codex-router/usage-events.jsonl`, projecting only relevant fields. Causes, in order of likelihood: a spawned thread died
on a native usage limit while the parent waited; an upstream stream dropped
mid-flight; the app compacted early on inflated estimated totals; the router
restarted. The router service restarts are normally supervised by launchd
and are not a production crash loop unless the log shows repeated exits
without an external trigger.
