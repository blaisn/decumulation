import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDialogDir, type DialogDirStore } from "../electron/dialog-dir";

/** Stockage de remplacement : un « fichier » en mémoire et la liste des dossiers qui existent. */
function fakeStore(saved: string | null, existing: string[], fail: { read?: boolean; write?: boolean; stat?: boolean } = {}) {
  const calls = { reads: 0, writes: [] as string[] };
  let content = saved;
  const store: DialogDirStore = {
    async read() { calls.reads++; if (fail.read) throw new Error("lecture impossible"); return content; },
    async write(dir) { if (fail.write) throw new Error("écriture impossible"); calls.writes.push(dir); content = dir; existing.push(dir); },
    async isDirectory(dir) { if (fail.stat) throw new Error("stat impossible"); return existing.includes(dir); },
  };
  return { store, calls, saved: () => content };
}
const DOCS = "/home/alex/Documents";

describe("dernier dossier des boîtes d'ouverture et d'enregistrement (Electron 43 n'en retient plus)", () => {
  it("au premier lancement, on commence dans Documents", async () => {
    const { store } = fakeStore(null, [DOCS]);
    expect(await createDialogDir(store, () => DOCS).get()).toBe(DOCS);
  });
  it("on retrouve le dossier mémorisé lors d'une session précédente, s'il existe encore", async () => {
    const { store } = fakeStore("/home/alex/Planification", ["/home/alex/Planification"]);
    expect(await createDialogDir(store, () => DOCS).get()).toBe("/home/alex/Planification");
  });
  it("un dossier mémorisé qui a disparu est remplacé par Documents", async () => {
    const { store } = fakeStore("/home/alex/Supprime", [DOCS]);
    expect(await createDialogDir(store, () => DOCS).get()).toBe(DOCS);
  });
  it("une valeur mémorisée vide, relative ou illisible est ignorée", async () => {
    for (const bad of ["", "   \n", "dossier/relatif", "../ailleurs"]) {
      const { store } = fakeStore(bad, [DOCS, bad]);
      expect(await createDialogDir(store, () => DOCS).get()).toBe(DOCS);
    }
  });
  it("après un fichier choisi ou enregistré, la prochaine boîte s'ouvre dans son dossier", async () => {
    const { store, calls } = fakeStore(null, [DOCS]);
    const dir = createDialogDir(store, () => DOCS);
    await dir.remember("/home/alex/Planification/scenario.json");
    expect(await dir.get()).toBe("/home/alex/Planification");
    expect(calls.writes).toEqual(["/home/alex/Planification"]);
    await dir.remember("/home/alex/Exports/tableau.csv");
    expect(await dir.get()).toBe("/home/alex/Exports");
  });
  it("le dossier est conservé d'une session à l'autre (nouvelle instance, même stockage)", async () => {
    const { store } = fakeStore(null, [DOCS]);
    await createDialogDir(store, () => DOCS).remember("/home/alex/Planification/scenario.json");
    expect(await createDialogDir(store, () => DOCS).get()).toBe("/home/alex/Planification");
  });
  it("le stockage n'est lu qu'une fois, et pas du tout si on a déjà mémorisé un dossier", async () => {
    const a = fakeStore("/home/alex/Planification", ["/home/alex/Planification"]);
    const d1 = createDialogDir(a.store, () => DOCS);
    await d1.get(); await d1.get(); await d1.get();
    expect(a.calls.reads).toBe(1);
    const b = fakeStore("/home/alex/Planification", ["/home/alex/Planification"]);
    const d2 = createDialogDir(b.store, () => DOCS);
    await d2.remember("/home/alex/Autre/x.json");
    await d2.get();
    expect(b.calls.reads).toBe(0);
  });
  it("si le dossier mémorisé est supprimé pendant la session, on revient à Documents", async () => {
    const existing = [DOCS];
    const { store } = fakeStore(null, existing);
    const dir = createDialogDir(store, () => DOCS);
    await dir.remember("/home/alex/Temp/x.json");
    expect(await dir.get()).toBe("/home/alex/Temp");
    existing.splice(existing.indexOf("/home/alex/Temp"), 1);
    expect(await dir.get()).toBe(DOCS);
  });
  it("les erreurs de lecture, d'écriture ou de vérification ne bloquent jamais une boîte de dialogue", async () => {
    const r = fakeStore("/home/alex/Planification", [DOCS], { read: true });
    expect(await createDialogDir(r.store, () => DOCS).get()).toBe(DOCS);
    const w = fakeStore(null, [DOCS], { write: true });
    const dir = createDialogDir(w.store, () => DOCS);
    await dir.remember("/home/alex/Planification/x.json");                 // l'écriture échoue : aucune exception
    expect(w.calls.writes).toEqual([]);
    const s = fakeStore("/home/alex/Planification", [DOCS], { stat: true });
    expect(await createDialogDir(s.store, () => DOCS).get()).toBe(DOCS);
  });
  it("un chemin relatif n'est jamais mémorisé", async () => {
    const { store, calls } = fakeStore(null, [DOCS]);
    const dir = createDialogDir(store, () => DOCS);
    await dir.remember("scenario.json");
    await dir.remember("relatif/scenario.json");
    expect(calls.writes).toEqual([]);
    expect(await dir.get()).toBe(DOCS);
  });
});

describe("processus Electron : dossier de départ des boîtes de dialogue", () => {
  const main = readFileSync("electron/main.ts", "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const calls = [...main.matchAll(/dialog\.show(Open|Save)Dialog\(([^;]*)\);/g)];

  it("les deux boîtes reçoivent un dossier de départ : sinon Electron 43 et plus ouvrent « Téléchargements »", () => {
    expect(calls.map((c) => c[1]).sort()).toEqual(["Open", "Save"]);
    for (const c of calls) expect(c[2]).toContain("defaultPath");
  });
  it("le dossier de départ est le dernier dossier utilisé, et les choix sont mémorisés", () => {
    for (const c of calls) expect(c[2]).toContain("dialogDir.get()");
    expect((main.match(/dialogDir\.remember\(/g) ?? []).length).toBe(2);
  });
  it("le nom de fichier proposé ne peut pas désigner un autre dossier", () => {
    expect(main).toContain("path.basename(suggestedName)");
  });
});
