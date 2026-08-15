// The UI reaches its backend through exactly one function --
// window.__TAURI__.core.invoke -- funnelled through a single call site in
// app.js. Presenting that same shape here is what lets the Electron shell run
// the existing UI unchanged rather than forking five thousand lines of it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__TAURI__", {
  core: {
    invoke: (command, args) => ipcRenderer.invoke("router:invoke", command, args ?? {}),
  },
});
