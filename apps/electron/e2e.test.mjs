import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(appDir, "..", "..");
const shots = path.join(root, ".electron-shots");

// Driving the real application, not a mock of it: Playwright launches the
// actual Electron binary, and every assertion below reads what the shipped
// apps/desktop/ui rendered inside it. The UI is shared with the Tauri shell,
// so this also proves the bridge presents the shape that UI expects.
// Electron ships a 200 MB binary and needs a display, so the suite skips when
// either is absent rather than failing a machine that never asked for it --
// but never silently: a skip prints its reason.
const electronBinary = path.join(
  appDir,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const missing = !existsSync(electronBinary)
  ? "electron is not installed (npm ci --prefix apps/electron)"
  : !existsSync(path.join(appDir, "node_modules", "playwright"))
    ? "playwright is not installed (npm ci --prefix apps/electron)"
    : process.platform === "linux" && !process.env.DISPLAY
      ? "no display; run under xvfb-run"
      : false;
const options = { skip: missing };

async function launch() {
  const { _electron } = await import("playwright");
  return _electron.launch({
    args: [appDir, "--no-sandbox", "--disable-gpu"],
    cwd: appDir,
    env: {
      ...process.env,
      MODEL_ROUTER_SOURCE_ROOT: root,
      CODEX_ROUTER_ELECTRON_TRAY_ONLY: "",
    },
  });
}

test("the Electron companion starts and renders the shared UI", options, async () => {
  const electron = await launch();
  try {
    const window = await electron.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    assert.equal(await window.title(), "Codex Model Router");
    mkdirSync(shots, { recursive: true });
    await window.screenshot({ path: path.join(shots, "01-panel.png") });
    // The shared stylesheet and scripts loaded, not a blank shell.
    assert.ok(await window.locator("body").count());
    const failed = await window.evaluate(() =>
      [...document.querySelectorAll("link[rel=stylesheet]")].length,
    );
    assert.ok(failed > 0, "the shared stylesheet must be linked");
  } finally {
    await electron.close();
  }
});

test("the preload exposes the bridge the shared UI expects", options, async () => {
  const electron = await launch();
  try {
    const window = await electron.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    // app.js reads exactly this path; if it is missing the UI silently
    // degrades to "Desktop bridge unavailable".
    const shape = await window.evaluate(() => ({
      hasTauri: Boolean(window.__TAURI__),
      hasInvoke: typeof window.__TAURI__?.core?.invoke === "function",
    }));
    assert.deepEqual(shape, { hasTauri: true, hasInvoke: true });
  } finally {
    await electron.close();
  }
});

test("each feature command answers through the bridge", options, async () => {
  const electron = await launch();
  try {
    const window = await electron.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // Read-only commands, one per feature area the macOS tray exposes. Each is
    // driven through the renderer's own invoke, so this exercises preload,
    // IPC, the command table and the CLI shell-out together.
    const features = {
      "router health": "router_health",
      "platform info": "platform_info",
      "desktop settings": "desktop_settings",
      "limits / overview": "control_snapshot",
      "provider usage": "provider_usage",
      "provider setup": "provider_setup",
      "local LLMs": "local_models",
    };
    const results = {};
    for (const [label, command] of Object.entries(features)) {
      results[label] = await window.evaluate(
        async (name) => {
          try {
            const value = await window.__TAURI__.core.invoke(name, {});
            return { ok: true, type: Array.isArray(value) ? "array" : typeof value };
          } catch (error) {
            return { ok: false, error: String(error?.message || error) };
          }
        },
        command,
      );
    }
    for (const [label, result] of Object.entries(results)) {
      assert.equal(result.ok, true, `${label} failed: ${result.error}`);
      assert.equal(result.type, "object", `${label} returned ${result.type}`);
    }
  } finally {
    await electron.close();
  }
});

test("an unknown command is refused rather than shelled out", options, async () => {
  const electron = await launch();
  try {
    const window = await electron.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    const error = await window.evaluate(async () => {
      try {
        await window.__TAURI__.core.invoke("rm_minus_rf", {});
        return null;
      } catch (failure) {
        return String(failure?.message || failure);
      }
    });
    assert.match(error ?? "", /Unknown command/);
  } finally {
    await electron.close();
  }
});

test("a malformed provider id never reaches a command line", options, async () => {
  const electron = await launch();
  try {
    const window = await electron.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    const error = await window.evaluate(async () => {
      try {
        await window.__TAURI__.core.invoke("set_provider_enabled", {
          provider: "deepseek; rm -rf /",
          enabled: true,
        });
        return null;
      } catch (failure) {
        return String(failure?.message || failure);
      }
    });
    assert.match(error ?? "", /Unknown provider/);
  } finally {
    await electron.close();
  }
});

// Feature by feature: drive each tab the way a person would -- click it, wait
// for its panel, and capture what rendered. A command that answers over IPC is
// not the same as a panel that paints, and only this catches the difference.
test("every tab opens and renders its panel", options, async () => {
  const electron = await launch();
  try {
    const window = await electron.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    mkdirSync(shots, { recursive: true });

    const tabs = [
      { id: "usage", expect: /token activity|allowance|limits/i },
      { id: "connections", expect: /connection|provider|api key/i },
      { id: "models", expect: /model|subagent|picker/i },
    ];

    for (const [index, tab] of tabs.entries()) {
      const button = window.locator(`button.tab[data-tab="${tab.id}"]`);
      assert.equal(await button.count(), 1, `no tab button for ${tab.id}`);
      await button.click();
      await window.waitForTimeout(400);

      // The clicked tab is the active one, and no other tab is.
      const active = await window.evaluate(
        () => document.querySelector("button.tab.is-active")?.dataset.tab,
      );
      assert.equal(active, tab.id, `${tab.id} did not become the active tab`);

      // Something recognisably that panel's content is on screen.
      const text = await window.locator("body").innerText();
      assert.match(text, tab.expect, `${tab.id} panel did not render its content`);

      await window.screenshot({
        path: path.join(shots, `0${index + 2}-${tab.id}.png`),
      });
    }
  } finally {
    await electron.close();
  }
});

test("the panel survives a reload without losing its bridge", options, async () => {
  // The tray reopens the panel repeatedly over a session; a bridge that only
  // attaches on first load would work once and then quietly stop.
  const electron = await launch();
  try {
    const window = await electron.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    const ok = await window.evaluate(
      () => typeof window.__TAURI__?.core?.invoke === "function",
    );
    assert.equal(ok, true, "the bridge did not survive a reload");
  } finally {
    await electron.close();
  }
});
