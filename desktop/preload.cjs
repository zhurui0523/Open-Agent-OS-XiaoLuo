const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xiaoluoDesktop", {
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
