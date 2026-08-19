const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xiaoluoDesktop", {
  runCommand: (payload) => ipcRenderer.invoke("brain:command", payload),
  fsAction: (payload) => ipcRenderer.invoke("brain:fs", payload),
  manageService: (payload) => ipcRenderer.invoke("brain:services", payload),
  deployProgram: (payload) => ipcRenderer.invoke("brain:deploy", payload),
  fetchLocal: (payload) => ipcRenderer.invoke("brain:fetch", payload),
  mcpAction: (payload) => ipcRenderer.invoke("brain:mcp", payload),
  localAi: (payload) => ipcRenderer.invoke("local-ai", payload),
  onLocalAiEvent: (listener) => {
    const wrappedListener = (_event, event) => listener(event);
    ipcRenderer.on("local-ai:event", wrappedListener);
    return () => ipcRenderer.removeListener("local-ai:event", wrappedListener);
  },
  getStatus: () => ipcRenderer.invoke("desktop:get-status"),
  getMeta: () => ipcRenderer.invoke("desktop:get-meta"),
  retry: () => ipcRenderer.invoke("desktop:retry"),
  openSecondary: () => ipcRenderer.invoke("desktop:open-secondary"),
  onStatus: (listener) => {
    const wrappedListener = (_event, status) => listener(status);
    ipcRenderer.on("desktop:status", wrappedListener);
    return () => ipcRenderer.removeListener("desktop:status", wrappedListener);
  },
});
