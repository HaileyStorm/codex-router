import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("usage events persist only bounded request metadata in a private file", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?test=${Date.now()}`);
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 321,
      responseStartMs: 121,
      inputTokens: 120,
      cachedInputTokens: 90,
      outputTokens: 35,
      totalTokens: 155,
      toolResultsAged: 2,
      toolResultBytesBefore: 80_000,
      toolResultBytesAfter: 5_000,
      toolResultBytesSaved: 75_000,
      prompt: "never persisted",
    });
    assert.deepEqual(usage.recentUsageEvents(), [
      {
        meteringVersion: 1,
        at: usage.recentUsageEvents()[0].at,
        model: "grok-oauth/grok-4.5",
        provider: "grok-oauth",
        status: 200,
        durationMs: 321,
        responseStartMs: 121,
        inputTokens: 120,
        cachedInputTokens: 90,
        outputTokens: 35,
        totalTokens: 155,
        toolResultsAged: 2,
        toolResultBytesBefore: 80_000,
        toolResultBytesAfter: 5_000,
        toolResultBytesSaved: 75_000,
      },
    ]);
    if (process.platform !== "win32") {
      assert.equal(statSync(usage.USAGE_EVENTS_PATH).mode & 0o777, 0o600);
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("tool-result aging totals aggregate savings across recorded events", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  let usage;
  try {
    usage = await import(`../src/usage-events.mjs?totals=${Date.now()}`);
    const emptyCache = { agedRate: null, unagedRate: null, agedTurns: 0, unagedTurns: 0 };
    // No events file yet: totals must report zeros rather than fail.
    assert.deepEqual(usage.toolResultAgingTotals(), {
      requests: 0,
      evaluatedRequests: 0,
      largestResultBytes: 0,
      resultsAged: 0,
      bytesSaved: 0,
      estimatedTokensSaved: 0,
      retentionFailures: 0,
      backendDegraded: false,
      degradedReason: undefined,
      lastRetentionAttemptHealthy: undefined,
      firstAt: undefined,
      lastAt: undefined,
      ranges: {
        "24h": { savedTokens: 0, requests: 0, buckets: new Array(24).fill(0), cache: emptyCache },
        "7d": { savedTokens: 0, requests: 0, buckets: new Array(7).fill(0), cache: emptyCache },
        "30d": { savedTokens: 0, requests: 0, buckets: new Array(30).fill(0), cache: emptyCache },
      },
    });
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 100,
      inputTokens: 120,
      cachedInputTokens: 90,
      toolResultsAged: 2,
      toolResultBytesBefore: 80_000,
      toolResultBytesAfter: 5_000,
      toolResultBytesSaved: 75_000,
    });
    // An ordinary turn without aging must not count as an aged request.
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 100,
    });
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 100,
      toolResultsAged: 1,
      toolResultBytesSaved: 25_000,
    });
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 100,
      toolResultRetentionFailures: 2,
      toolResultRetentionDegradedReason: "capacity",
    });
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 100,
      toolResultRetentionFailures: 1,
      toolResultRetentionDegradedReason: "storage",
    });
    const degraded = usage.toolResultAgingTotals();
    assert.equal(degraded.retentionFailures, 3);
    assert.equal(degraded.backendDegraded, true);
    assert.equal(degraded.degradedReason, "storage");
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 100,
      toolResultsAged: 1,
      toolResultBytesSaved: 5_000,
      toolResultRetentionHealthy: true,
    });
    const totals = usage.toolResultAgingTotals();
    assert.equal(totals.requests, 3);
    assert.equal(totals.resultsAged, 4);
    assert.equal(totals.bytesSaved, 105_000);
    assert.equal(totals.estimatedTokensSaved, 26_250);
    assert.equal(totals.retentionFailures, 3);
    assert.equal(totals.backendDegraded, true, "a distinct success cannot clear unresolved corruption");
    assert.equal(totals.degradedReason, "storage");
    assert.equal(totals.lastRetentionAttemptHealthy, true);
    assert.ok(typeof totals.firstAt === "string");
    assert.ok(typeof totals.lastAt === "string");
    assert.ok(Date.parse(totals.lastAt) >= Date.parse(totals.firstAt));
    // All three aged events landed within the current hour/day, so the newest
    // bucket of every range holds the whole series.
    for (const [key, size] of [["24h", 24], ["7d", 7], ["30d", 30]]) {
      const range = totals.ranges[key];
      assert.equal(range.buckets.length, size);
      assert.equal(range.buckets.at(-1), 26_250);
      assert.equal(range.savedTokens, 26_250);
      assert.equal(range.requests, 3);
      // The first event reported cache telemetry and carried aging; the
      // others reported none, so only the aged side has a measured rate.
      assert.equal(range.cache.agedTurns, 1);
      assert.equal(range.cache.agedRate, 0.75);
      assert.equal(range.cache.unagedTurns, 0);
      assert.equal(range.cache.unagedRate, null);
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
    // paths.mjs caches STATE_DIR from the first import in this process, so
    // the recorded file may live outside this test's tmpdir. Remove it even
    // on assertion failure so later tests start from an empty event log.
    if (usage) rmSync(usage.USAGE_EVENTS_PATH, { force: true });
  }
});

test("reading usage events folds protocol variants into their canonical provider", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?variant=${Date.now()}`);
    // Historical events recorded before canonicalization carry the variant id.
    usage.recordUsageEvent({
      model: "opencode-go-messages/minimax-m3",
      provider: "opencode-go-messages",
      status: 200,
      durationMs: 50,
    });
    assert.equal(usage.recentUsageEvents()[0].provider, "opencode-go");
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an aborted stream persists its marker and reads back", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?aborted=1&ts=${Date.now()}`);
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 502,
      durationMs: 90,
      streamAborted: true,
    });
    const [event] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.status === 502);
    assert.equal(event.status, 502);
    assert.equal(event.streamAborted, true);
    // An ordinary turn never carries the marker, so historical rows keep
    // their exact shape and old dashboards are unaffected.
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 40,
    });
    const [ordinary] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.status === 200);
    assert.equal("streamAborted" in ordinary, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a guard budget release persists its marker and reads back", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?guard=1&ts=${Date.now()}`);
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 40_100,
      emptyCompletionGuardReleased: true,
    });
    const [event] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.emptyCompletionGuardReleased === true);
    assert.equal(event.status, 200);
    assert.equal(event.durationMs, 40_100);
    // An ordinary turn never carries the marker, so the release path stays
    // distinguishable from a healthy turn of the same duration.
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 40_100,
    });
    const [ordinary] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.emptyCompletionGuardReleased !== true);
    assert.equal("emptyCompletionGuardReleased" in ordinary, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// An operator who enables aging on a workload of medium-sized results saw an
// all-zero ledger and reasonably concluded the hook had never loaded. The
// evaluated counter is what separates "ran and nothing qualified" from "never
// ran", and the largest-result byte count says how far under the floor it was.
test("totals separate a pass that ran and aged nothing from one that never ran", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?evaluated=${Date.now()}`);
    // Aging enabled, ran over eleven results, none of them past the floor.
    usage.recordUsageEvent({
      model: "qwen-plan/qwen3.8-max",
      provider: "qwen-plan",
      status: 200,
      durationMs: 100,
      inputTokens: 275_000,
      toolResultsEvaluated: 11,
      toolResultBytesLargest: 12_400,
    });
    // Aging off: the pass reports nothing, so this row must not be counted.
    usage.recordUsageEvent({
      model: "qwen-plan/qwen3.8-max",
      provider: "qwen-plan",
      status: 200,
      durationMs: 100,
      inputTokens: 275_000,
    });
    const totals = usage.toolResultAgingTotals();
    assert.equal(totals.evaluatedRequests, 1, "only the row from an enabled pass counts");
    assert.equal(totals.largestResultBytes, 12_400);
    assert.equal(totals.requests, 0, "nothing was aged, so no request saved anything");
    assert.equal(totals.bytesSaved, 0);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
