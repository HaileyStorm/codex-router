// Electron shell for the Codex Model Router companion. It owns the window, the
// tray icon and the IPC bridge; every panel, chart and control it displays is
// the same apps/desktop/ui the Tauri shell renders, loaded verbatim. Only the
// host differs, so a UI fix lands in both shells at once.
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } = require("electron");
const http = require("node:http");
const path = require("node:path");

const UI_DIR = path.join(__dirname, "..", "desktop", "ui");
const ROUTER_PORT = Number(process.env.MODEL_ROUTER_PORT || 4202);

let bridge;
let root;
let tray;
let panel;
const settings = { islandEnabled: false, islandExpanded: false };

async function loadBridge() {
  bridge ??= await import("./bridge.mjs");
  root ??= bridge.sourceRoot(process.env, __dirname);
  return bridge;
}

// Mirrors the Rust reader: a short connect timeout so a stopped router reports
// offline promptly instead of stalling the panel behind a hanging socket.
function routerHealth() {
  return new Promise((resolve) => {
    const offline = (detail) => resolve({ ok: false, status: "offline", detail });
    const request = http.get(
      { host: "127.0.0.1", port: ROUTER_PORT, path: "/health", timeout: 2000 },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            offline("Router health response was unreadable.");
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      offline("Router health check did not finish.");
    });
    request.on("error", () => offline("Router is offline."));
  });
}

async function handleInvoke(command, args) {
  const { COMMANDS, runControl, parseJson } = await loadBridge();

  if (command === "router_health") return routerHealth();
  if (command === "platform_info") {
    return { platform: process.platform, island: process.platform !== "linux", shell: "electron" };
  }
  if (command === "desktop_settings") return { ...settings };
  if (command === "set_island_enabled") {
    settings.islandEnabled = Boolean(args.enabled);
    return { ...settings };
  }
  if (command === "set_island_expanded") {
    settings.islandExpanded = Boolean(args.expanded);
    return { ...settings };
  }
  if (command === "show_panel") {
    showPanel();
    return null;
  }
  if (command === "hide_panel") {
    panel?.hide();
    return null;
  }
  if (command === "quit_app") {
    app.quit();
    return null;
  }

  const build = COMMANDS[command];
  if (!build) throw new Error(`Unknown command: ${command}`);
  const plan = build(args ?? {});
  const output = await runControl(root, plan.args, { stdin: plan.stdin });
  for (const extra of plan.select ?? []) await runControl(root, extra);
  // A mutating command re-reads so the renderer always paints fresh state.
  if (plan.then) return parseJson(await runControl(root, plan.then));
  return output.trim() ? parseJson(output) : null;
}

function showPanel() {
  if (!panel || panel.isDestroyed()) {
    panel = new BrowserWindow({
      width: 420,
      height: 720,
      show: false,
      title: "Codex Model Router",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    panel.loadFile(path.join(UI_DIR, "index.html"));
    // The panel is the whole app; external links belong in a browser, not in
    // a window with a privileged preload attached to it.
    panel.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
  }
  panel.show();
  panel.focus();
}

function buildTray() {
  // A one-pixel transparent image keeps the tray constructible on a machine
  // with no icon theme (and in CI); the real asset replaces it when present.
  const icon = nativeImage.createFromPath(path.join(UI_DIR, "..", "src-tauri", "icons", "32x32.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Codex Model Router");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Model Router", click: showPanel },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showPanel);
}

// Not `require.main === module`: Electron does not load the entry point as
// Node's main module, so that guard is always false here and the app would
// start without ever opening a window. Running under Electron is the real
// condition, and it leaves the module inert for a plain-Node import.
if (process.versions.electron) {
  app.whenReady().then(() => {
    ipcMain.handle("router:invoke", (_event, command, args) => handleInvoke(command, args));
    try {
      buildTray();
    } catch {
      // A headless session has no tray host. The panel still works, which is
      // what an automated pass drives.
    }
    if (!process.env.CODEX_ROUTER_ELECTRON_TRAY_ONLY) showPanel();
  });
  // The companion lives in the tray, so closing the panel must not end it.
  app.on("window-all-closed", () => {});
}

module.exports = { handleInvoke, routerHealth, showPanel };
