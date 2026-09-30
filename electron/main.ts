import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_FOLDER, migrateLegacyData } from "./migrate";

// Dossier de données fixé explicitement : il ne dépend ni du nom du paquet ni du nom du produit.
app.setPath("userData", path.join(app.getPath("appData"), DATA_FOLDER));
try { migrateLegacyData(app.getPath("appData")); } catch { /* la migration est facultative */ }

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1100, minHeight: 680,
    title: "Décumulation",
    backgroundColor: "#f0f3f0",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  // L'application est locale : aucune navigation ni fenêtre externe.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e: { preventDefault(): void }) => e.preventDefault());
}

ipcMain.handle("file:open", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)!;
  const r = await dialog.showOpenDialog(win, { title: "Ouvrir un scénario", properties: ["openFile"], filters: [{ name: "Scénario (JSON)", extensions: ["json"] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { name: path.basename(r.filePaths[0]), content: await readFile(r.filePaths[0], "utf8") };
});

ipcMain.handle("file:save", async (event, suggestedName: string, content: string, kind: "json" | "csv") => {
  const win = BrowserWindow.fromWebContents(event.sender)!;
  const filters = kind === "csv" ? [{ name: "Tableau (CSV)", extensions: ["csv"] }] : [{ name: "Scénario (JSON)", extensions: ["json"] }];
  const r = await dialog.showSaveDialog(win, { title: "Enregistrer", defaultPath: path.join(app.getPath("documents"), suggestedName), filters });
  if (r.canceled || !r.filePath) return false;
  await writeFile(r.filePath, content, "utf8");
  return true;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
