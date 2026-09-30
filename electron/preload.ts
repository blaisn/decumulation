import { contextBridge, ipcRenderer } from "electron";

// Seule passerelle entre l'interface et le système de fichiers : deux fonctions, pas d'accès à Node.
contextBridge.exposeInMainWorld("retraite", {
  openFile: () => ipcRenderer.invoke("file:open"),
  saveFile: (name: string, content: string, kind: "json" | "csv") => ipcRenderer.invoke("file:save", name, content, kind),
});
