import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DATA_FOLDER, LEGACY_FOLDERS, copyDirSync, migrateLegacyData } from "../electron/migrate";

// Reproduit la disposition d'Electron : <appData>/<dossier>/Local Storage/leveldb/<fichiers>
function legacy(appData: string, folder: string, content: string, ageSeconds = 0): void {
  const dir = path.join(appData, folder, "Local Storage", "leveldb");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "000003.log");
  writeFileSync(file, content);
  const t = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(file, t, t);
  utimesSync(dir, t, t);
  utimesSync(path.join(appData, folder, "Local Storage"), t, t);
}
// Nettoyage sans `rmSync` récursif : sous Windows, avec Node 22 et plus, il peut mal gérer les chemins accentués.
function removeTree(dir: string): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) removeTree(p); else unlinkSync(p);
  }
  rmdirSync(dir);
}
const fresh = () => mkdtempSync(path.join(tmpdir(), "decumulation-test-"));
const copied = (appData: string) => readFileSync(path.join(appData, DATA_FOLDER, "Local Storage", "leveldb", "000003.log"), "utf8");

describe("migration du dossier de données", () => {
  it("copie le stockage de l'ancien dossier du paquet (npm run start)", () => {
    const appData = fresh();
    legacy(appData, "retraite-planner", "scénarios");
    expect(migrateLegacyData(appData)).toBe(path.join(appData, "retraite-planner"));
    expect(copied(appData)).toBe("scénarios");
    expect(existsSync(path.join(appData, "retraite-planner", "Local Storage"))).toBe(true); // l'original reste intact
    removeTree(appData);
  });
  it("choisit le dossier le plus récemment utilisé parmi plusieurs", () => {
    const appData = fresh();
    legacy(appData, "retraite-planner", "vieux", 3600);
    legacy(appData, "Plan de décaissement", "récent", 10);
    legacy(appData, "Décumulation", "moyen", 600);
    expect(migrateLegacyData(appData)).toBe(path.join(appData, "Plan de décaissement"));
    expect(copied(appData)).toBe("récent");
    removeTree(appData);
  });
  it("ne refait rien quand le nouveau dossier a déjà un stockage local", () => {
    const appData = fresh();
    legacy(appData, "retraite-planner", "ancien");
    legacy(appData, DATA_FOLDER, "déjà là");
    expect(migrateLegacyData(appData)).toBe(null);
    expect(copied(appData)).toBe("déjà là");
    removeTree(appData);
  });
  it("ne fait rien sans ancien dossier (première installation) et ne crée rien", () => {
    const appData = fresh();
    expect(migrateLegacyData(appData)).toBe(null);
    expect(existsSync(path.join(appData, DATA_FOLDER))).toBe(false);
    removeTree(appData);
  });
  it("le nouveau dossier n'est aucun des anciens (aucune boucle de copie)", () => {
    expect(LEGACY_FOLDERS.includes(DATA_FOLDER)).toBe(false);
    expect(DATA_FOLDER).toBe("Decumulation");
  });
  it("copyDirSync copie les sous-dossiers et les fichiers, noms accentués compris", () => {
    const root = fresh();
    const src = path.join(root, "Plan de décaissement", "Local Storage");
    mkdirSync(path.join(src, "leveldb", "sous-dossier é"), { recursive: true });
    writeFileSync(path.join(src, "leveldb", "000003.log"), "a");
    writeFileSync(path.join(src, "leveldb", "sous-dossier é", "données.ldb"), "b");
    const dst = path.join(root, "Décumulation", "copie");
    copyDirSync(src, dst);
    expect(readFileSync(path.join(dst, "leveldb", "000003.log"), "utf8")).toBe("a");
    expect(readFileSync(path.join(dst, "leveldb", "sous-dossier é", "données.ldb"), "utf8")).toBe("b");
    removeTree(root);
  });
  it("n'utilise ni cpSync ni rmSync (plantage possible sous Windows avec des chemins accentués)", () => {
    for (const f of ["electron/migrate.ts", "electron/main.ts", "tests/migrate.test.ts"]) {
      const code = readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
      expect(/\b(cpSync|rmSync)\(/.test(code)).toBe(false);
    }
  });
});
