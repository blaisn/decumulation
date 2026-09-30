import { describe, it, expect } from "vitest";
import table2026 from "../src/engine/data/tax-2026.json";
import { runProjection } from "../src/index";
import type { StrategySummary, TaxYearTable } from "../src/index";
import { changedPaths, defaultForm, describeChanges, fileFromJson, fileToJson, formFromJson, formToJson, parseNumber, strategyToForm, toScenario } from "../ui/src/model";
import { planToCsv } from "../ui/src/csv";
import { balancesChart, sourcesChart } from "../ui/src/charts";
import { strategiesTable, yearTable } from "../ui/src/tables";
import { comparePanel } from "../ui/src/compare-view";
import { KEYS, migrateLegacyKeys } from "../ui/src/storage-migration";
import { deathMatrix, deathRankTable } from "../ui/src/tables";
import { compareLongevity } from "../src/index";
import { summarize } from "../src/index";

const tax = table2026 as unknown as TaxYearTable;
const has = (text: string, part: string) => text.includes(part);

describe("formulaire vers scénario", () => {
  it("les valeurs d'exemple donnent un scénario valide, en fractions", () => {
    const r = toScenario(defaultForm());
    expect(r.errors).toEqual([]);
    expect(r.scenario!.assumptions.inflation).toBeCloseTo(0.02, 10);
    expect(r.scenario!.spouses[0].name).toBe("Alex");
    expect(r.scenario!.spouses[0].dbPensions[0].survivorPct).toBeCloseTo(0.6, 10);
    expect(r.options.estateTaxRate).toBeCloseTo(0.45, 10);
  });
  it("accepte la virgule décimale et les espaces", () => {
    expect(parseNumber("2,5")).toBe(2.5);
    expect(parseNumber("1 234 567 $")).toBe(1234567);
    expect(Number.isNaN(parseNumber("  "))).toBe(true);
  });
  it("signale les erreurs en français, avec le prénom", () => {
    const f = defaultForm();
    f.spouses[0].birthYear = "abc";
    f.assumptions.inflation = "-3";
    const r = toScenario(f);
    expect(r.scenario).toBe(undefined);
    expect(r.errors.some((e) => has(e, "Alex : année de naissance") && has(e, "n'est pas un nombre"))).toBe(true);
    expect(r.errors.some((e) => has(e, "Inflation"))).toBe(true);
  });
  it("refuse un décès avant le début du plan et une fin de plan trop proche", () => {
    const f = defaultForm();
    f.spouses[1].deathAge = "60"; // né en 1962 -> 2022
    expect(toScenario(f).errors.some((e) => has(e, "avant le début du plan"))).toBe(true);
    const g = defaultForm();
    g.assumptions.endAge = "62";
    expect(toScenario(g).errors.some((e) => has(e, "Âge de fin du plan"))).toBe(true);
  });
  it("refuse une année de départ sans table fiscale", () => {
    const f = defaultForm();
    f.assumptions.startYear = "2024";
    expect(toScenario(f).errors.some((e) => has(e, "Année de départ"))).toBe(true);
  });
  it("convertit les stratégies avec plafond, seuil de la PSV et âge limite", () => {
    const f = defaultForm();
    f.strategy = { kind: "meltdown", ceiling: "80000", usePsvThreshold: false, untilAge: "75" };
    expect(toScenario(f).scenario!.strategy).toEqual({ kind: "meltdown", ceiling: 80000, untilAge: 75 });
    f.strategy = { kind: "ceiling", ceiling: "", usePsvThreshold: true, untilAge: "" };
    expect(toScenario(f).scenario!.strategy).toEqual({ kind: "ceiling", ceiling: "psv-threshold" });
  });
  it("strategyToForm est l'inverse de la conversion", () => {
    const f = defaultForm();
    f.strategy = strategyToForm({ kind: "meltdown", ceiling: 90000, untilAge: 72 }, f.strategy);
    expect(toScenario(f).scenario!.strategy).toEqual({ kind: "meltdown", ceiling: 90000, untilAge: 72 });
  });
});

describe("fichiers de scénario", () => {
  it("l'enregistrement puis l'ouverture redonnent le même formulaire", () => {
    const f = defaultForm();
    f.spouses[0].pensions.push({ label: "Autre", amount: "1000", startAge: "65", indexation: "0", survivorPct: "0" });
    f.spouses[1].deathAge = "85";
    expect(formFromJson(formToJson(f))).toEqual(f);
  });
  it("complète un fichier partiel avec les valeurs par défaut", () => {
    const partial = JSON.stringify({ form: { spending: "80000", spouses: [{ name: "Lou" }] } });
    const f = formFromJson(partial);
    expect(f.spending).toBe("80000");
    expect(f.spouses[0].name).toBe("Lou");
    expect(f.spouses[1].name).toBe("Sam");
    expect(toScenario(f).errors).toEqual([]);
  });
  it("refuse un fichier qui n'est pas un scénario", () => {
    let message = "";
    try { formFromJson('{"a":1}'); } catch (e) { message = (e as Error).message; }
    expect(has(message, "scénario de retraite")).toBe(true);
  });
});

describe("export et affichage", () => {
  const parsed = toScenario((() => { const f = defaultForm(); f.spouses[0].name = '<b>"Alex"</b>'; f.spouses[0].deathAge = "82"; return f; })());
  const s = parsed.scenario!;
  const rows = runProjection(s, tax);

  it("le CSV a une ligne par conjoint et par année, avec BOM et point-virgule", () => {
    const csv = planToCsv(s, rows);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.trim().split("\r\n").length).toBe(1 + rows.length * 2);
    expect(has(csv, '"<b>""Alex""</b>"')).toBe(true); // guillemets échappés
    expect(csv.split("\r\n")[0].split(";").length).toBe(21);
    const first = csv.split("\r\n")[1].split(";");
    expect(first[first.length - 1]).toBe("1,0000"); // indice d'inflation de l'année de départ
    const second = csv.split("\r\n")[3].split(";");
    expect(second[second.length - 1]).toBe("1,0200");
  });
  it("les graphiques sont des SVG accessibles; les noms sont échappés", () => {
    const b = balancesChart(s, rows, true);
    expect(has(b, 'role="img"')).toBe(true);
    expect(has(b, "aria-label=")).toBe(true);
    expect(b.split("<polygon").length - 1).toBe(3);
    expect(has(b, "mark death")).toBe(true);
    expect(has(b, "<b>")).toBe(false);
    expect(has(b, "&lt;b&gt;")).toBe(true);
    const src = sourcesChart(s, rows, false);
    expect(has(src, 'class="outflow"')).toBe(true);
  });
  it("le tableau annuel sépare les rentes, la RRQ et la PSV, et leur somme reste celle des revenus garantis", () => {
    const t = yearTable(s, rows, false);
    const headers = [...t.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headers.slice(0, 7)).toEqual(["Année", "Âges", "Rentes de régimes", "RRQ", "PSV", "Retraits REER/FERR", "Retraits CELI et non enr."]);
    expect(headers.includes("Revenus garantis")).toBe(false);
    // 2033 : les deux conjoints touchent leurs rentes, la RRQ et la PSV
    const y = rows.find((r) => r.year === 2033)!;
    const line = t.split("<tbody>")[1].split("</tr>").find((tr) => tr.includes("<th scope=\"row\">2033</th>"))!;
    const cells = [...line.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => Number(m[1].replace(/[^\d-]/g, "")));
    const pick = (f: (p: (typeof y.spouses)[0]) => number) => Math.round(f(y.spouses[0]) + f(y.spouses[1]));
    expect(cells[0]).toBe(pick((p) => p.pensionIncome));
    expect(cells[1]).toBe(pick((p) => p.rrqIncome));
    expect(cells[2]).toBe(pick((p) => p.psvIncome));
    expect(cells[0] + cells[1] + cells[2]).toBeCloseTo(pick((p) => p.guaranteedIncome), -1);
  });
  it("le tableau annuel a une ligne par année et marque les décès", () => {
    const t = yearTable(s, rows, true);
    expect(t.split("<tr").length - 1).toBe(rows.length + 1);
    expect(has(t, "†")).toBe(true);
  });
  it("le tableau des stratégies regroupe les résultats identiques", () => {
    const amounts = (estate: number, k = 1) => ({ totalTax: 100 * k, totalClawback: 0, totalShortfall: 0, finalReer: 0, finalCeli: 0, finalNonReg: 0, afterTaxEstate: estate * k });
    const mk = (label: string, estate: number): StrategySummary => ({ label, strategy: { kind: "reer-first" }, yearsWithShortfall: 0, ...amounts(estate), nominal: amounts(estate, 2) });
    const html = strategiesTable([mk("A", 500), mk("B", 500), mk("C", 400)], true);
    const nominalHtml = strategiesTable([mk("A", 500)], false);
    expect(nominalHtml.replace(/\s|\u00a0|\u202f/g, "")).toContain("1000$");
    expect(html.split("<tbody>")[1].split("<tr").length - 1).toBe(2);
    expect(has(html, "+ 1 autre stratégie au même résultat")).toBe(true);
    expect(has(html, 'data-index="2"')).toBe(true); // l'index d'origine est conservé
  });
});

describe("données de base", () => {
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  it("aucun changement quand le formulaire est identique", () => {
    const f = defaultForm();
    expect(changedPaths(f, clone(f)).size).toBe(0);
    expect(describeChanges(f, clone(f))).toEqual([]);
  });
  it("« 100000 » et « 100 000 » sont la même valeur; « 2,5 » et « 2.5 » aussi", () => {
    const f = defaultForm(), g = clone(f);
    g.spending = "100 000";
    g.assumptions.inflation = "2,0";
    expect(changedPaths(f, g).size).toBe(0);
  });
  it("décrit les changements en français, avec le prénom", () => {
    const f = defaultForm(), g = clone(f);
    g.spending = "90000";
    g.spouses[0].reer = "700000";
    g.spouses[1].deathAge = "85";
    g.strategy.kind = "meltdown";
    const list = describeChanges(f, g);
    expect(list).toContain("Dépenses nettes annuelles : 100000 → 90000");
    expect(list).toContain("Alex, REER/FERR : 600000 → 700000");
  });
  it("les chemins modifiés servent à encadrer les champs", () => {
    const f = defaultForm(), g = clone(f);
    g.spouses[1].celi = "1";
    g.spouses[0].pensions[0].amount = "1";
    expect([...changedPaths(f, g)].sort()).toEqual(["spouses.0.pensions.0.amount", "spouses.1.celi"]);
  });
  it("signale une rente ajoutée ou retirée une seule fois", () => {
    const f = defaultForm(), g = clone(f);
    g.spouses[1].pensions.push({ label: "Autre", amount: "500", startAge: "65", indexation: "0", survivorPct: "0" });
    expect(describeChanges(f, g)).toEqual(["Sam : rente 2 ajoutée"]);
    expect(describeChanges(g, f)).toEqual(["Sam : rente 2 retirée"]);
    expect(changedPaths(f, g).size).toBe(5);
  });
  it("le nom de la stratégie est lisible", () => {
    const f = defaultForm(), g = clone(f);
    g.strategy.kind = "celi-first";
    expect(describeChanges(f, g)[0]).toBe("Ordre des retraits : REER/FERR d'abord, puis CELI → CELI d'abord, puis REER/FERR");
  });
  it("le fichier de scénario contient les données actuelles et la base, et les redonne", () => {
    const f = defaultForm(), g = clone(f);
    g.spending = "85000";
    const base = { savedAt: "2026-09-29T12:00:00.000Z", form: f };
    const back = fileFromJson(fileToJson(g, base));
    expect(back.form).toEqual(g);
    expect(back.base).toEqual(base);
  });
  it("un fichier sans base (ancien format) s'ouvre sans base", () => {
    const back = fileFromJson(formToJson(defaultForm()));
    expect(back.base).toBe(null);
    expect(back.form.spending).toBe("100000");
  });
});

describe("comparaison à la base", () => {
  const view = (mutate: (f: ReturnType<typeof defaultForm>) => void) => {
    const f = defaultForm(); mutate(f);
    const sc = toScenario(f).scenario!;
    const rows = runProjection(sc, tax);
    return { form: f, v: { scenario: sc, rows, summary: summarize("x", sc.strategy!, rows, sc.assumptions, { estateTaxRate: 0.45, nonRegTaxRate: 0.1 }) } };
  };
  const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/[\s\u00a0\u202f]+/g, " ");

  it("sans changement : plans identiques et écarts nuls", () => {
    const a = view(() => {}), b = view(() => {});
    const html = comparePanel({ base: a.v, cur: b.v, changes: describeChanges(a.form, b.form), real: true });
    expect(strip(html)).toContain("les deux plans sont identiques");
    expect(html.split('class="delta"').length - 1).toBe(8);
    expect(strip(html)).not.toContain("+");
  });
  it("avec changements : liste, écarts signés, deux graphiques", () => {
    const base = view(() => {}), cur = view((f) => { f.spending = "115000"; f.spouses[0].reer = "300000"; });
    const html = comparePanel({ base: base.v, cur: cur.v, changes: describeChanges(base.form, cur.form), real: false });
    const t = strip(html);
    expect(t).toContain("Dépenses nettes annuelles : 100000 → 115000");
    expect(t).toContain("dollars courants");
    expect(html.split("<svg").length - 1).toBe(2);
    expect(html.split("cmp-cur").length - 1).toBeGreaterThan(1);
    expect(/[+−]\d/.test(t.replace(/ /g, ""))).toBe(true);
  });
  it("prévient quand les fonds s'épuisent avec les changements", () => {
    const base = view(() => {}), cur = view((f) => { f.spending = "400000"; });
    const t = strip(comparePanel({ base: base.v, cur: cur.v, changes: describeChanges(base.form, cur.form), real: true }));
    expect(t).toContain("les fonds s'épuisent en");
  });
  it("les dollars courants donnent des montants plus élevés que les dollars constants", () => {
    const a = view(() => {});
    const c = comparePanel({ base: a.v, cur: a.v, changes: [], real: true });
    const n = comparePanel({ base: a.v, cur: a.v, changes: [], real: false });
    expect(c).not.toBe(n);
    expect(strip(n)).toContain("les soldes de fin sont en dollars de 2057");
  });
  it("signale une comparaison en dollars constants sur des bases différentes", () => {
    const base = view(() => {}), cur = view((f) => { f.assumptions.inflation = "3"; f.spending = "101000"; });
    const t = strip(comparePanel({ base: base.v, cur: cur.v, changes: describeChanges(base.form, cur.form), real: true }));
    expect(t).toContain("n'est pas sur la même base");
  });
});

describe("espérance de vie et comparaison des durées de vie", () => {
  it("l'espérance de vie a une valeur par défaut, validée entre 8 et 35 ans", () => {
    const ok = toScenario(defaultForm());
    expect(ok.lifeExpectancy).toEqual([21, 21]);
    const f = defaultForm();
    f.spouses[1].lifeExpectancy = "60";
    const bad = toScenario(f);
    expect(bad.errors.some((e) => e.includes("Sam : espérance de vie à 65 ans"))).toBe(true);
  });
  it("un ancien fichier sans espérance de vie reprend la valeur par défaut", () => {
    const f = formFromJson(JSON.stringify({ form: { spending: "80000", spouses: [{ name: "Lou" }, {}] } }));
    expect(f.spouses[0].lifeExpectancy).toBe("21");
    expect(toScenario(f).errors).toEqual([]);
  });
  it("le changement d'espérance de vie apparaît dans la liste des changements", () => {
    const a = defaultForm(), b = JSON.parse(JSON.stringify(a)) as typeof a;
    b.spouses[0].lifeExpectancy = "24";
    expect(describeChanges(a, b)).toEqual(["Alex, espérance de vie à 65 ans : 21 → 24"]);
  });
  it("le tableau des durées de vie montre le risque de manquer de fonds et des colonnes courtes", () => {
    const sc = toScenario(defaultForm()).scenario!;
    const r = compareLongevity(sc, tax, [{ label: "REER d'abord", strategy: { kind: "reer-first" } }], { lifeExpectancy65: [21, 21], states: 3 });
    const withRisk = deathRankTable(r, true, 8, true);
    expect(withRisk).toContain("Cas sans fonds suffisants");
    expect(withRisk).toContain("0 %");
    expect(deathRankTable(r, true)).not.toContain("Cas sans fonds suffisants");
    const matrix = deathMatrix(r, true);
    expect(matrix).not.toContain("décède");
    expect(matrix).toContain("Alex ");
    expect(matrix.split("<th scope=\"col\" class=\"num\">").length - 1).toBe(9);
  });
});

describe("changement de nom : migration des données", () => {
  const fake = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { m, getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  };
  it("copie les anciennes clés vers les nouvelles, puis les supprime", () => {
    const st = fake({ "retraite-planner.form.v1": "F", "retraite-planner.base.v1": "B", "retraite-planner.prefs.v1": "P" });
    const moved = migrateLegacyKeys(st);
    expect(moved.length).toBe(3);
    expect(st.getItem(KEYS.form)).toBe("F");
    expect(st.getItem(KEYS.base)).toBe("B");
    expect(st.getItem(KEYS.prefs)).toBe("P");
    expect([...st.m.keys()].some((k) => k.startsWith("retraite-planner."))).toBe(false);
  });
  it("ne remplace pas une nouvelle clé déjà présente", () => {
    const st = fake({ "retraite-planner.form.v1": "ancien", [KEYS.form]: "récent" });
    expect(migrateLegacyKeys(st)).toEqual([]);
    expect(st.getItem(KEYS.form)).toBe("récent");
    expect(st.getItem("retraite-planner.form.v1")).toBe(null);
  });
  it("ne fait rien sans anciennes clés, et deux appels donnent le même résultat", () => {
    const st = fake({ [KEYS.form]: "x" });
    expect(migrateLegacyKeys(st)).toEqual([]);
    const old = fake({ "retraite-planner.form.v1": "F" });
    migrateLegacyKeys(old);
    expect(migrateLegacyKeys(old)).toEqual([]);
    expect(old.getItem(KEYS.form)).toBe("F");
  });
  it("tolère un stockage qui échoue", () => {
    const broken = { getItem: () => { throw new Error("indisponible"); }, setItem: () => {}, removeItem: () => {} };
    expect(migrateLegacyKeys(broken)).toEqual([]);
  });
  it("un fichier de scénario enregistré sous l'ancien nom s'ouvre toujours", () => {
    const legacy = JSON.stringify({ application: "retraite-planner", form: { ...defaultForm(), spending: "88000" } });
    expect(fileFromJson(legacy).form.spending).toBe("88000");
    expect(JSON.parse(fileToJson(defaultForm(), null)).application).toBe("decumulation");
  });
});

