import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// Garde-fou : les workflows GitHub ne doivent appeler que des scripts npm qui existent.
const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
const workflows = existsSync(".github/workflows") ? readdirSync(".github/workflows").filter((f) => /\.ya?ml$/.test(f)) : [];

describe("workflows GitHub", () => {
  it("il y a une vérification et une construction d'installateur", () => {
    expect(workflows.includes("ci.yml")).toBe(true);
    expect(workflows.includes("windows-installer.yml")).toBe(true);
  });
  it("chaque « npm run <script> » des workflows existe dans package.json", () => {
    for (const f of workflows) {
      const text = readFileSync(`.github/workflows/${f}`, "utf8");
      for (const m of text.matchAll(/npm run ([\w:-]+)/g)) expect(m[1] in scripts).toBe(true);
    }
  });
  it("la CI lance les types, les tests et la construction", () => {
    const text = readFileSync(".github/workflows/ci.yml", "utf8");
    for (const cmd of ["npm run typecheck", "npm test", "npm run build"]) expect(text.includes(cmd)).toBe(true);
    expect("typecheck" in scripts && "test" in scripts && "build" in scripts).toBe(true);
  });
  it("l'installateur ne publie rien par accident", () => {
    expect(scripts.dist.includes("--publish never")).toBe(true);
  });
  it("le modèle de PR existe", () => {
    expect(existsSync(".github/pull_request_template.md")).toBe(true);
  });
});

describe("boîtes de dialogue", () => {
  const dirs = ["ui/src", "electron"];
  const sources = dirs.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => `${d}/${f}`) : []));
  const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("aucune boîte bloquante du navigateur (confirm, alert, prompt) : sous Electron (Windows), elles font perdre le focus clavier au formulaire", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const f of sources) expect(/\b(window\.)?(confirm|alert|prompt)\s*\(/.test(code(f))).toBe(false);
  });
  it("les confirmations passent par la boîte intégrée à la page", () => {
    const main = code("ui/src/main.ts");
    expect(main.includes("confirmDialog(")).toBe(true);
    expect(existsSync("ui/src/dialog.ts")).toBe(true);
  });
});

describe("publication Windows (MSI, version GitHub, S3)", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string; scripts: Record<string, string>; build: { win: { target: string[] }; msi: { upgradeCode: string; artifactName: string; perMachine: boolean }; nsis: { artifactName: string }; portable: { artifactName: string } } };
  const wf = readFileSync(".github/workflows/windows-installer.yml", "utf8");
  const doc = existsSync("docs/PUBLICATION.md") ? readFileSync("docs/PUBLICATION.md", "utf8") : "";

  it("l'installateur, la version portable et le MSI sont construits", () => {
    for (const t of ["nsis", "portable", "msi"]) expect(pkg.build.win.target.includes(t)).toBe(true);
  });
  it("la version est au format X.Y.Z : le MSI refuse les suffixes comme « -beta »", () => {
    expect(/^\d+\.\d+\.\d+$/.test(pkg.version)).toBe(true);
  });
  it("le MSI a un code de mise à niveau fixe (GUID) : sans lui, chaque version s'installerait à côté de la précédente", () => {
    expect(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(pkg.build.msi.upgradeCode)).toBe(true);
  });
  it("les trois fichiers ont des noms distincts, sans accent", () => {
    const names = [pkg.build.msi.artifactName, pkg.build.nsis.artifactName, pkg.build.portable.artifactName];
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(/^[\x20-\x7E]+$/.test(n)).toBe(true);
    expect(names.some((n) => n.endsWith(".${ext}"))).toBe(true);
  });
  it("le workflow conserve le MSI, les .exe et les sommes de contrôle, et vérifie l'étiquette de version", () => {
    for (const part of ["release/*.msi", "release/*.exe", "release/SHA256SUMS.txt", 'startsWith(github.ref, \'refs/tags/v\')', "ne correspond pas à la version"]) expect(wf.includes(part)).toBe(true);
  });
  it("moindres privilèges : lecture seule par défaut, écriture seulement pour créer la version, OIDC seulement pour S3", () => {
    expect(/^permissions:\n  contents: read\n/m.test(wf)).toBe(true);
    expect(wf.split("contents: write").length - 1).toBe(1);
    expect(wf.split("id-token: write").length - 1).toBe(1);
    expect(wf.indexOf("contents: write")).toBeLessThan(wf.indexOf("publish-s3:"));
    expect(wf.indexOf("id-token: write")).toBeGreaterThan(wf.indexOf("publish-s3:"));
  });
  it("la copie sur S3 reste inactive tant que la variable S3_BUCKET n'existe pas, et n'utilise aucune clé d'accès enregistrée", () => {
    expect(wf.includes("vars.S3_BUCKET != ''")).toBe(true);
    expect(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|secrets\.AWS/.test(wf)).toBe(false);
    expect(wf.includes("role-to-assume")).toBe(true);
  });
  it("la publication de version ne s'exécute que pour une étiquette, jamais pour un lancement manuel", () => {
    const release = wf.slice(wf.indexOf("  release:"), wf.indexOf("  publish-s3:"));
    expect(release.includes("if: startsWith(github.ref, 'refs/tags/v')")).toBe(true);
  });
  it("chaque variable `vars.X` du workflow est expliquée dans docs/PUBLICATION.md, et la doc existe", () => {
    expect(doc.length).toBeGreaterThan(1000);
    const names = [...new Set([...wf.matchAll(/vars\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const n of names) expect(doc.includes("`" + n + "`")).toBe(true);
  });
  it("les gabarits JSON de la documentation sont valides", () => {
    const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const b of blocks) expect(() => JSON.parse(b)).not.toThrow();
  });
  it("la version GitHub est créée avec le jeton du workflow, sans action tierce", () => {
    expect(wf.includes("gh release create")).toBe(true);
    const uses = [...wf.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1]);
    for (const u of uses) expect(/^(actions|aws-actions)\//.test(u)).toBe(true);
  });
});

describe("Node 24 : actions GitHub et version du projet", () => {
  const files = readdirSync(".github/workflows").filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
  const texts = files.map((f) => ({ f, t: readFileSync(f, "utf8") }));
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { engines?: { node?: string }; devDependencies: Record<string, string> };

  // Première version majeure de chaque action qui tourne sur Node 24 (Node 20 n'est plus offert par GitHub Actions depuis le 23 septembre 2026).
  const FIRST_NODE24: Record<string, number> = {
    "actions/checkout": 5,
    "actions/setup-node": 5,
    "actions/upload-artifact": 6,
    "actions/download-artifact": 7,
    "aws-actions/configure-aws-credentials": 6,
  };

  it("chaque action utilisée est une version qui tourne sur Node 24", () => {
    let vues = 0;
    for (const { f, t } of texts) for (const m of t.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@v(\d+)/g)) {
      const min = FIRST_NODE24[m[1]];
      expect(min !== undefined).toBe(true);              // une nouvelle action doit être ajoutée à la liste ci-dessus, après vérification
      expect(Number(m[2])).toBeGreaterThanOrEqual(min);
      vues++;
    }
    expect(vues).toBeGreaterThanOrEqual(8);
  });
  it("toutes les actions sont référencées par une version majeure explicite (@vN)", () => {
    for (const { t } of texts) for (const m of t.matchAll(/uses:\s*(\S+)/g)) expect(/@v\d+$/.test(m[1])).toBe(true);
  });
  it("les workflows utilisent la même version de Node que celle exigée par package.json (engines)", () => {
    const required = /(\d+)/.exec(pkg.engines?.node ?? "")?.[1];
    expect(required).toBe("24");
    let vus = 0;
    for (const { t } of texts) for (const m of t.matchAll(/node-version:\s*(\d+)/g)) { expect(m[1]).toBe(required); vus++; }
    expect(vus).toBeGreaterThanOrEqual(2);
  });
  it("les types de Node correspondent à la version de Node utilisée", () => {
    expect(/^\^?24\./.test(pkg.devDependencies["@types/node"])).toBe(true);
  });
});

describe("dépannage de la construction sous Windows", () => {
  const doc = readFileSync("docs/PUBLICATION.md", "utf8");
  it("la documentation explique l'erreur « Cannot create symbolic link » (winCodeSign), sa cause et ses solutions", () => {
    for (const part of ["Cannot create symbolic link", "winCodeSign", "mode développeur", "rm -rf \"$LOCALAPPDATA/electron-builder/Cache/winCodeSign\"", "Remove-Item", "Run workflow"]) expect(doc.includes(part)).toBe(true);
  });
  it("le README renvoie vers ce dépannage", () => {
    expect(readFileSync("README.md", "utf8").includes("Cannot create symbolic link")).toBe(true);
  });
});
