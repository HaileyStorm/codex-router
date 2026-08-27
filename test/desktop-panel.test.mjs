import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import http from "node:http";
import test from "node:test";

import { writeJson } from "../src/http-utils.mjs";
import {
  handlePanelRequest,
  isPanelRoute,
  panelCommandAllowed,
} from "../src/desktop-panel.mjs";

// The panel is served by the router, so these drive the real handler over a
// real socket rather than calling it in-process: the routing, the headers and
// the JSON contract are the parts a browser actually depends on.
function serve() {
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    if (isPanelRoute(route)) {
      if (await handlePanelRequest(request, response, route, { writeJson })) return;
    }
    writeJson(response, 404, { error: { type: "not_found", message: "no route" } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: (path) => `http://127.0.0.1:${port}${path}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("panel routes are recognised, and nothing else is", () => {
  assert.equal(isPanelRoute("/panel"), true);
  assert.equal(isPanelRoute("/panel/app.js"), true);
  assert.equal(isPanelRoute("/panel/invoke"), true);
  assert.equal(isPanelRoute("/panel/../../etc/passwd"), false);
  assert.equal(isPanelRoute("/panel/secrets.json"), false);
  assert.equal(isPanelRoute("/v1/responses"), false);
});

test("the panel serves the shared UI with the bridge injected", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const body = await response.text();
    // The same UI the shells load, plus the one function app.js calls.
    assert.match(body, /window\.__TAURI__/);
    assert.match(body, /fetch\("\.\/invoke"/);
    assert.match(body, /data-tab="connections"/);
    assert.match(body, /id="global-fast-state"/);
    assert.match(
      body,
      /id="tool-result-aging-switch" type="checkbox" disabled/,
      "the aging toggle must start disabled until the backend confirms state",
    );
    // Framing and sniffing are closed off even though the route is gated.
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await close();
  }
});

test("the panel serves each asset the UI loads", async () => {
  const { url, close } = await serve();
  try {
    for (const [asset, pattern] of [
      ["/panel/styles.css", /text\/css/],
      ["/panel/app.js", /javascript/],
      ["/panel/model.mjs", /javascript/],
      ["/panel/thinking-orb.mjs", /javascript/],
    ]) {
      const response = await fetch(url(asset));
      assert.equal(response.status, 200, `${asset} did not serve`);
      assert.match(response.headers.get("content-type"), pattern, asset);
    }
    const app = await (await fetch(url("/panel/app.js"))).text();
    assert.match(
      app,
      /lastRetentionAttemptHealthy === true[\s\S]*toolAgingDegradedPrior/,
      "a later successful attempt must not be described as a current global outage",
    );
  } finally {
    await close();
  }
});

// A browser tab is reachable by anything that learns the capability, so the
// panel deliberately carries only the reading half of the command table.
test("the panel refuses the commands that change credentials or state", async () => {
  const { url, close } = await serve();
  try {
    for (const command of ["save_api_key", "remove_api_key", "set_provider_enabled", "connect_oauth"]) {
      const response = await fetch(url("/panel/invoke"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, args: { provider: "deepseek", apiKey: "x" } }),
      });
      assert.equal(response.status, 403, `${command} was not refused`);
      const payload = await response.json();
      assert.match(payload.error.message, /not available from the browser panel/);
    }
    assert.equal(panelCommandAllowed("save_api_key"), false);
    assert.equal(panelCommandAllowed("control_snapshot"), true);
    // The full table is still reachable for a shell that asks for it.
    assert.equal(panelCommandAllowed("save_api_key", { readOnly: false }), true);
  } finally {
    await close();
  }
});

test("an unknown command is refused rather than shelled out", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "rm_minus_rf", args: {} }),
    });
    assert.equal(response.status, 403);
    assert.equal(panelCommandAllowed("rm_minus_rf"), false);
  } finally {
    await close();
  }
});

test("a read command answers with the router's own data", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "control_snapshot", args: {} }),
    });
    // Read once: the failure message and the assertion cannot both consume it.
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const payload = JSON.parse(raw);
    assert.equal(typeof payload.value, "object");
    // The overview the tray renders, produced by the same control CLI.
    assert.ok(payload.value.targets, "expected the control overview shape");
  } finally {
    await close();
  }
});

test("router health exposes the authoritative host-global Fast intent", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "router_health", args: {} }),
    });
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const payload = JSON.parse(raw);
    assert.equal(payload.value.ok, true);
    assert.equal(typeof payload.value.fastMode.enabled, "boolean");
    assert.match(payload.value.fastMode.status, /^(enabled|disabled|unavailable)$/);
    assert.equal(
      payload.value.fastMode.status === "enabled",
      payload.value.fastMode.configuredTier === "fast" ||
        payload.value.fastMode.configuredTier === "priority",
    );
  } finally {
    await close();
  }
});

test("malformed JSON and wrong methods are answered, not crashed on", async () => {
  const { url, close } = await serve();
  try {
    const bad = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);

    const wrongMethod = await fetch(url("/panel/invoke"), { method: "GET" });
    assert.equal(wrongMethod.status, 405);

    const wrongAssetMethod = await fetch(url("/panel"), { method: "POST" });
    assert.equal(wrongAssetMethod.status, 405);
  } finally {
    await close();
  }
});

// Serving the files is not the same as the page working. This drives the panel
// in a real browser, because the two defects that got through here -- relative
// assets resolving one level too high at "/panel", and the UI's non-CLI
// commands being refused -- both served a 200 and rendered an empty panel.
const chromiumPath = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browserSkip = !existsSync(chromiumPath)
  ? "no preinstalled chromium"
  : !existsSync(new URL("../apps/electron/node_modules/playwright", import.meta.url))
    ? "playwright is not installed (npm ci --prefix apps/electron)"
    : false;

test("the panel renders and answers in a real browser", { skip: browserSkip }, async () => {
  // Playwright's entry is CommonJS; imported from ESM the namespace may carry
  // the exports directly or behind `default` depending on the interop path.
  const loaded = await import("../apps/electron/node_modules/playwright/index.js");
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  assert.ok(chromium, "playwright did not expose chromium");
  const { url, close } = await serve();
  const browser = await chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 720 } });
    const failures = [];
    page.on("pageerror", (error) => failures.push(String(error.message)));
    page.on("response", (response) => {
      const route = new URL(response.url()).pathname;
      // account_usage needs a Codex install, which a test machine need not
      // have; every other non-2xx is a real failure.
      if (response.status() >= 400 && response.status() !== 502) {
        failures.push(`${response.status()} ${route}`);
      }
    });

    await page.goto(url("/panel/"), { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    // The bridge is present and the UI painted real data through it.
    assert.equal(
      await page.evaluate(() => typeof window.__TAURI__?.core?.invoke),
      "function",
    );
    await page.click('button.tab[data-tab="connections"]');
    await page.waitForTimeout(600);
    const text = await page.locator("body").innerText();
    assert.match(text, /anthropic|cerebras|deepseek/i, "provider rows did not render");
    await page.click('button.tab[data-tab="status"]');
    await page.waitForTimeout(100);
    assert.match(await page.locator("#global-fast-state").innerText(), /Global Fast intent/);
    assert.equal(
      await page.evaluate(() => document.querySelector("button.tab.is-active")?.dataset.tab),
      "status",
    );
    assert.equal(
      await page.locator("#tool-result-aging-switch").isDisabled(),
      true,
      "the read-only browser panel must never expose an actionable aging toggle",
    );
    assert.deepEqual(failures, [], `browser reported: ${failures.join(", ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("the bare panel path redirects to the directory form", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel"), { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "./panel/");
  } finally {
    await close();
  }
});
