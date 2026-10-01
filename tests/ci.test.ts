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
