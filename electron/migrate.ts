import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Dossier de données de l'application (sous %APPDATA% sous Windows), fixé explicitement, sans accent. */
export const DATA_FOLDER = "Decumulation";

/**
 * Anciens dossiers de données. Selon la façon de lancer l'application, Electron utilisait le nom du paquet
 * (`npm run start`) ou le nom du produit (version installée ou portable).
 */
export const LEGACY_FOLDERS = ["retraite-planner", "Plan de décaissement", "Décumulation"];

/**
 * Copie récursive d'un dossier avec des primitives de base seulement (readdir, mkdir, copyFile).
 * On évite `fs.cpSync` : avec Node 22 et plus, sa version récursive peut faire planter le processus,
 * sans message, sur les chemins Windows qui contiennent des accents (nodejs/node#54476). Or les noms
 * d'utilisateur accentués sont courants, et les anciens dossiers de cette application aussi.
 */
export function copyDirSync(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

/** Date de dernière modification du stockage local : le fichier le plus récent de « Local Storage ». */
function lastWrite(localStorageDir: string): number {
  const dirs = [localStorageDir, path.join(localStorageDir, "leveldb")];
  let newest = 0;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    newest = Math.max(newest, statSync(d).mtimeMs);
    for (const f of readdirSync(d)) newest = Math.max(newest, statSync(path.join(d, f)).mtimeMs);
  }
  return newest;
}

/**
 * Au premier lancement, copie le stockage local (scénarios, données de base, préférences) de l'ancienne
 * version vers le nouveau dossier. Si plusieurs anciens dossiers existent, le plus récemment utilisé gagne.
 * Ne fait rien si le nouveau dossier a déjà un stockage local. Retourne le dossier source, ou null.
 */
export function migrateLegacyData(appDataDir: string, dataDir = path.join(appDataDir, DATA_FOLDER)): string | null {
  const target = path.join(dataDir, "Local Storage");
  if (existsSync(target)) return null;
  const found = LEGACY_FOLDERS
    .map((name) => ({ name, dir: path.join(appDataDir, name, "Local Storage") }))
    .filter((c) => existsSync(c.dir))
    .map((c) => ({ ...c, time: lastWrite(c.dir) }))
    .sort((a, b) => b.time - a.time);
  if (!found.length) return null;
  mkdirSync(dataDir, { recursive: true });
  copyDirSync(found[0].dir, target);
  return path.dirname(found[0].dir);
}
