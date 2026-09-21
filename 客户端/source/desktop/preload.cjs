const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xiaoluoDesktop", {
  runCommand: (payload) => ipcRenderer.invoke("brain:command", payload),
  cancelCommands: () => ipcRenderer.invoke("brain:command-cancel"),
  fsAction: (payload) => ipcRenderer.invoke("brain:fs", payload),
  manageService: (payload) => ipcRenderer.invoke("brain:services", payload),
  deployProgram: (payload) => ipcRenderer.invoke("brain:deploy", payload),
  fetchLocal: (payload) => ipcRenderer.invoke("brain:fetch", payload),
  mcpAction: (payload) => ipcRenderer.invoke("brain:mcp", payload),
  appServer: (payload) => ipcRenderer.invoke("brain:appserver", payload), // P21-preload
  onAppServerEvent: (listener) => {
    const wrappedListener = (_event, event) => listener(event);
    ipcRenderer.on("brain:appserver-event", wrappedListener);
    return () => ipcRenderer.removeListener("brain:appserver-event", wrappedListener);
  },
  localAi: (payload) => ipcRenderer.invoke("local-ai", payload),
  appData: (payload) => ipcRenderer.invoke("app-data", payload), // DATA-DIR 存储位置设置
  serverUrl: (payload) => ipcRenderer.invoke("server-url", payload), // SERVER-URL 连接地址设置
  browserAction: (payload) => ipcRenderer.invoke("brain:browser", payload), // VISION-OPS 截图/鼠标口
  desktopAction: (payload) => ipcRenderer.invoke("brain:desktop", payload), // DESKTOP-OPS 整桌口
  onLocalAiEvent: (listener) => {
    const wrappedListener = (_event, event) => listener(event);
    ipcRenderer.on("local-ai:event", wrappedListener);
    return () => ipcRenderer.removeListener("local-ai:event", wrappedListener);
  },
  getStatus: () => ipcRenderer.invoke("desktop:get-status"),
  getMeta: () => ipcRenderer.invoke("desktop:get-meta"),
  retry: () => ipcRenderer.invoke("desktop:retry"),
  openSecondary: () => ipcRenderer.invoke("desktop:open-secondary"),
  openExternal: (payload) => ipcRenderer.invoke("desktop:open-external", payload),
  writeClipboard: (payload) => ipcRenderer.invoke("desktop:write-clipboard", payload),
  onStatus: (listener) => {
    const wrappedListener = (_event, status) => listener(status);
    ipcRenderer.on("desktop:status", wrappedListener);
    return () => ipcRenderer.removeListener("desktop:status", wrappedListener);
  },
});
