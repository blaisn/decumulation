import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDialogDir } from "./dialog-dir";

// Dossier de données fixé explicitement : il ne dépend ni du nom du paquet ni du nom du produit.
const DATA_FOLDER = "Decumulation";
app.setPath("userData", path.join(app.getPath("appData"), DATA_FOLDER));

// Dernier dossier utilisé par les boîtes d'ouverture et d'enregistrement : depuis Electron 43, le système ne le retient plus
// et ouvre « Téléchargements ». Gardé d'une session à l'autre dans le dossier de données; Documents au premier lancement.
const dialogDirFile = () => path.join(app.getPath("userData"), "dialog-dir.txt");
const dialogDir = createDialogDir({
  read: () => readFile(dialogDirFile(), "utf8").catch(() => null),
  write: async (dir) => { await mkdir(path.dirname(dialogDirFile()), { recursive: true }); await writeFile(dialogDirFile(), dir, "utf8"); },
  isDirectory: async (dir) => (await stat(dir)).isDirectory(),
}, () => app.getPath("documents"));

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
  const r = await dialog.showOpenDialog(win, { title: "Ouvrir un scénario", defaultPath: await dialogDir.get(), properties: ["openFile"], filters: [{ name: "Scénario (JSON)", extensions: ["json"] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  await dialogDir.remember(r.filePaths[0]);
  return { name: path.basename(r.filePaths[0]), content: await readFile(r.filePaths[0], "utf8") };
});

ipcMain.handle("file:save", async (event, suggestedName: string, content: string, kind: "json" | "csv") => {
  const win = BrowserWindow.fromWebContents(event.sender)!;
  const filters = kind === "csv" ? [{ name: "Tableau (CSV)", extensions: ["csv"] }] : [{ name: "Scénario (JSON)", extensions: ["json"] }];
  // path.basename : le nom proposé ne doit jamais pouvoir désigner un autre dossier.
  const r = await dialog.showSaveDialog(win, { title: "Enregistrer", defaultPath: path.join(await dialogDir.get(), path.basename(suggestedName)), filters });
  if (r.canceled || !r.filePath) return false;
  await writeFile(r.filePath, content, "utf8");
  await dialogDir.remember(r.filePath);
  return true;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
