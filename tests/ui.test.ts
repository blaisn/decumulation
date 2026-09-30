import { describe, it, expect } from "vitest";
import table2026 from "../src/engine/data/tax-2026.json";
import { runProjection } from "../src/index";
import type { StrategySummary, TaxYearTable } from "../src/index";
import { changedPaths, defaultForm, describeChanges, fileFromJson, fileToJson, formFromJson, formToJson, parseNumber, strategyToForm, toScenario } from "../ui/src/model";
import { planToCsv } from "../ui/src/csv";
import { balancesChart, sourcesChart } from "../ui/src/charts";
import { strategiesTable, yearTable } from "../ui/src/tables";
import { comparePanel } from "../ui/src/compare-view";
import { renderForm } from "../ui/src/form";
import { parsePrefs } from "../ui/src/prefs";
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
    f.spouses[0].pensions.push({ label: "Autre", amount: "1000", startAge: "65", indexation: "0", survivorPct: "0", harmonization: false, amountAt65: "" });
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
    const head = csv.split("\r\n")[0].split(";");
    expect(head.length).toBe(22);
    expect(head[20]).toBe("Indice d'inflation (départ = 1)");    // les 21 premières colonnes n'ont pas bougé
    expect(head[21]).toBe("Taux marginal (%)");
    const first = csv.split("\r\n")[1].split(";");
    expect(first[20]).toBe("1,0000");                              // indice d'inflation de l'année de départ
    expect(first[21]).toBe((rows[0].spouses[0].marginalRate * 100).toFixed(2).replace(".", ","));
    const second = csv.split("\r\n")[3].split(";");
    expect(second[20]).toBe("1,0200");
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
  it("le tableau annuel donne le revenu imposable et le taux marginal de chaque conjoint, « — » après un décès", () => {
    const t = yearTable(s, rows, false);
    const headers = [...t.matchAll(/<th scope="col"[^>]*>([^<]*)(?:<span class="sub">([^<]*)<\/span>)?<\/th>/g)].map((m) => (m[2] ? `${m[1]} / ${m[2]}` : m[1]));
    const i = headers.indexOf("Pension fractionnée");
    expect(headers.slice(i + 1, i + 5)).toEqual(["Revenu imposable / &lt;b&gt;&quot;Alex&quot;&lt;/b&gt;", "Revenu imposable / Sam", "Taux marginal / &lt;b&gt;&quot;Alex&quot;&lt;/b&gt;", "Taux marginal / Sam"]);
    const line = (year: number) => t.split("<tbody>")[1].split("</tr>").find((tr) => tr.includes(`<th scope="row">${year}</th>`))!;
    const cells = (year: number) => [...line(year).matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1].replace(/[\u00a0\u202f]/g, " "));
    const a = cells(2033);     // les deux conjoints vivants
    const y = rows.find((r) => r.year === 2033)!;
    const digits = (x: string) => x.replace(/[^\d-]/g, "");
    expect(digits(a[8])).toBe(String(Math.round(y.spouses[0].taxableIncome)));
    expect(digits(a[9])).toBe(String(Math.round(y.spouses[1].taxableIncome)));
    expect(a[10]).toMatch(/^\d{2},\d{2} %$/);
    expect(a[11]).toMatch(/^\d{2},\d{2} %$/);
    const b = cells(2050);     // Alex est décédé depuis 2042
    expect(b[8]).toBe("—");
    expect(b[10]).toBe("—");
    expect(digits(b[9]).length).toBeGreaterThan(0);
    expect(b[11]).toMatch(/^\d{2},\d{2} %$/);
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
    g.spouses[1].pensions.push({ label: "Autre", amount: "500", startAge: "65", indexation: "0", survivorPct: "0", harmonization: false, amountAt65: "" });
    expect(describeChanges(f, g)).toEqual(["Sam : rente 2 ajoutée"]);
    expect(describeChanges(g, f)).toEqual(["Sam : rente 2 retirée"]);
    expect(changedPaths(f, g).size).toBe(7);   // les 5 champs d'une rente + la case d'harmonisation et le montant à 65 ans
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
  it("le verdict mentionne la PSV récupérée quand elle change, même si l'impôt sur le revenu baisse", () => {
    // sans fractionnement, la PSV du conjoint au revenu élevé est en partie récupérée; cette récupération réduit son revenu imposable
    const pens = (f: ReturnType<typeof defaultForm>) => { f.spouses[0].pensions[0].amount = "55000"; f.spouses[1].pensions[0].amount = "8000"; };
    const base = view(pens), cur = view((f) => { pens(f); f.assumptions.applySplitting = false; });
    expect(cur.v.summary.nominal.totalClawback).toBeGreaterThan(base.v.summary.nominal.totalClawback + 1000);
    expect(cur.v.summary.nominal.totalTax).toBeLessThan(base.v.summary.nominal.totalTax);      // le cas trompeur
    const t = strip(comparePanel({ base: base.v, cur: cur.v, changes: describeChanges(base.form, cur.form), real: false }));
    expect(t).toContain("de moins d'impôt");
    expect(t).toContain("de plus de PSV récupérée par l'impôt");
    expect(t).toContain("Fractionnement du revenu de pension : oui → non");
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

describe("fichiers de scénario", () => {
  it("le champ « application » est écrit à l'enregistrement mais pas exigé à l'ouverture", () => {
    expect(JSON.parse(fileToJson(defaultForm(), null)).application).toBe("decumulation");
    const other = JSON.stringify({ application: "autre", form: { ...defaultForm(), spending: "88000" } });
    expect(fileFromJson(other).form.spending).toBe("88000");
    const none = JSON.stringify({ form: { ...defaultForm(), spending: "77000" } });
    expect(fileFromJson(none).form.spending).toBe("77000");
  });
});

describe("case « Appliquer le fractionnement du revenu de pension »", () => {
  it("est cochée par défaut et se retrouve dans le scénario", () => {
    const f = defaultForm();
    expect(f.assumptions.applySplitting).toBe(true);
    expect(toScenario(f).scenario!.assumptions.pensionSplitting).toBe(true);
    f.assumptions.applySplitting = false;
    expect(toScenario(f).scenario!.assumptions.pensionSplitting).toBe(false);
  });
  it("apparaît dans les Hypothèses avancées, cochée ou non selon l'état", () => {
    const f = defaultForm();
    const on = renderForm(f, new Set(["advanced"]));
    const box = /<input type="checkbox" data-path="assumptions\.applySplitting"([^>]*)>/.exec(on)!;
    expect(box[1]).toContain("checked");
    expect(on).toContain("Appliquer le fractionnement du revenu de pension");
    f.assumptions.applySplitting = false;
    const off = /<input type="checkbox" data-path="assumptions\.applySplitting"([^>]*)>/.exec(renderForm(f, new Set(["advanced"])))!;
    expect(off[1]).not.toContain("checked");
    // la case est dans la section « Hypothèses avancées », pas ailleurs
    const adv = on.slice(on.indexOf("Hypothèses avancées"));
    expect(adv.indexOf("assumptions.applySplitting")).toBeGreaterThan(-1);
    expect(on.slice(0, on.indexOf("Hypothèses avancées")).includes("assumptions.applySplitting")).toBe(false);
  });
  it("un ancien fichier ou une ancienne base sans cette case reprennent la valeur par défaut (cochée)", () => {
    const old = JSON.parse(JSON.stringify(defaultForm()));
    delete old.assumptions.applySplitting;
    expect(formFromJson(JSON.stringify({ form: old })).assumptions.applySplitting).toBe(true);
    const stored = { ...old, assumptions: { ...old.assumptions, applySplitting: false } };
    expect(formFromJson(JSON.stringify({ form: stored })).assumptions.applySplitting).toBe(false);
  });
  it("l'aller-retour par fichier conserve l'état de la case", () => {
    const f = defaultForm();
    f.assumptions.applySplitting = false;
    expect(fileFromJson(fileToJson(f, null)).form.assumptions.applySplitting).toBe(false);
  });
  it("le changement apparaît dans la liste des changements depuis les données de base", () => {
    const a = defaultForm(), b = JSON.parse(JSON.stringify(a)) as typeof a;
    b.assumptions.applySplitting = false;
    expect(describeChanges(a, b)).toEqual(["Fractionnement du revenu de pension : oui → non"]);
    expect([...changedPaths(a, b)]).toEqual(["assumptions.applySplitting"]);
  });
});

describe("préférences d'affichage", () => {
  const ALL_OFF = { real: false, hideForm: false, hideDetailNote: false };
  it("lit les trois préférences et met les valeurs par défaut si elles manquent", () => {
    expect(parsePrefs('{"real":true,"hideForm":true,"hideDetailNote":true}')).toEqual({ real: true, hideForm: true, hideDetailNote: true });
    expect(parsePrefs('{"real":false}')).toEqual(ALL_OFF);
    expect(parsePrefs(null)).toEqual(ALL_OFF);
  });
  it("une ancienne préférence garde ce qu'elle contient et laisse le reste visible", () => {
    expect(parsePrefs('{"real":true}')).toEqual({ ...ALL_OFF, real: true });
    expect(parsePrefs('{"real":true,"hideForm":true}')).toEqual({ real: true, hideForm: true, hideDetailNote: false });
  });
  it("chaque préférence est indépendante des autres", () => {
    expect(parsePrefs('{"hideDetailNote":true}')).toEqual({ ...ALL_OFF, hideDetailNote: true });
    expect(parsePrefs('{"hideForm":true}')).toEqual({ ...ALL_OFF, hideForm: true });
  });
  it("ignore les valeurs invalides ou d'un mauvais type", () => {
    expect(parsePrefs("pas du json")).toEqual(ALL_OFF);
    expect(parsePrefs("null")).toEqual(ALL_OFF);
    expect(parsePrefs('{"real":"oui","hideForm":1,"hideDetailNote":"true"}')).toEqual(ALL_OFF);
  });
});

describe("harmonisation RRQ à 65 ans dans le formulaire", () => {
  const withPension = (mutate: (p: ReturnType<typeof defaultForm>["spouses"][0]["pensions"][0]) => void) => {
    const f = defaultForm(); mutate(f.spouses[0].pensions[0]); return f;
  };
  it("désactivée par défaut : aucun montant à 65 ans dans le scénario", () => {
    const f = defaultForm();
    expect(f.spouses[0].pensions[0].harmonization).toBe(false);
    expect(toScenario(f).scenario!.spouses[0].dbPensions[0].amountAt65).toBe(undefined);
  });
  it("cochée avec le montant vide : le montant à 65 ans est le montant annuel", () => {
    const f = withPension((p) => { p.harmonization = true; });
    expect(toScenario(f).scenario!.spouses[0].dbPensions[0].amountAt65).toBe(45000);
    const g = withPension((p) => { p.harmonization = true; p.amount = "52000"; });
    expect(toScenario(g).scenario!.spouses[0].dbPensions[0].amountAt65).toBe(52000);     // suit le montant annuel
  });
  it("cochée avec un montant : il est utilisé; décochée, il est ignoré", () => {
    const f = withPension((p) => { p.harmonization = true; p.amountAt65 = "38 500,50"; });
    expect(toScenario(f).scenario!.spouses[0].dbPensions[0].amountAt65).toBe(38500.5);
    const g = withPension((p) => { p.harmonization = false; p.amountAt65 = "38500"; });
    expect(toScenario(g).scenario!.spouses[0].dbPensions[0].amountAt65).toBe(undefined);
  });
  it("valide le montant à 65 ans, avec le prénom et le numéro de la rente", () => {
    const bad = toScenario(withPension((p) => { p.harmonization = true; p.amountAt65 = "abc"; }));
    expect(bad.errors.some((e) => e.includes("Alex : rente 1, montant à 65 ans"))).toBe(true);
    const neg = toScenario(withPension((p) => { p.harmonization = true; p.amountAt65 = "-5"; }));
    expect(neg.errors.some((e) => e.includes("montant à 65 ans"))).toBe(true);
    // décochée, un texte invalide n'est pas signalé
    expect(toScenario(withPension((p) => { p.amountAt65 = "abc"; })).errors).toEqual([]);
  });
  it("le formulaire montre la case, et le champ du montant seulement quand elle est cochée", () => {
    const f = defaultForm();
    const off = renderForm(f, new Set(["spouse0"]));
    expect(off).toContain('data-path="spouses.0.pensions.0.harmonization"');
    expect(off).toContain("Harmonisation RRQ à 65 ans");
    expect(off).not.toContain('data-path="spouses.0.pensions.0.amountAt65"');
    f.spouses[0].pensions[0].harmonization = true;
    const on = renderForm(f, new Set(["spouse0"]));
    expect(/<input type="checkbox" data-path="spouses\.0\.pensions\.0\.harmonization"[^>]*checked/.test(on)).toBe(true);
    expect(on).toContain("Montant de la pension à 65 ans");
    expect(/data-path="spouses\.0\.pensions\.0\.amountAt65"[^>]*placeholder="45000"/.test(on)).toBe(true);   // le montant annuel, par défaut
    expect(on).toContain("Avant 65 ans");
  });
  it("suit les changements depuis la base, avec un libellé lisible", () => {
    const a = defaultForm(), b = JSON.parse(JSON.stringify(a)) as typeof a;
    b.spouses[0].pensions[0].harmonization = true;
    b.spouses[0].pensions[0].amountAt65 = "38000";
    expect(describeChanges(a, b)).toEqual(["Alex, rente 1 (harmonisation RRQ à 65 ans) : non → oui", "Alex, rente 1 (montant à 65 ans) : vide → 38000"]);
  });
  it("un ancien fichier, ou une ancienne donnée de base, sans ces champs reprend « non » et le montant vide", () => {
    const old = JSON.parse(JSON.stringify(defaultForm()));
    delete old.spouses[0].pensions[0].harmonization; delete old.spouses[0].pensions[0].amountAt65;
    const back = formFromJson(JSON.stringify({ form: old }));
    expect(back.spouses[0].pensions[0].harmonization).toBe(false);
    expect(back.spouses[0].pensions[0].amountAt65).toBe("");
  });
  it("l'aller-retour par fichier conserve la case et le montant", () => {
    const f = withPension((p) => { p.harmonization = true; p.amountAt65 = "36000"; });
    const back = fileFromJson(fileToJson(f, null)).form.spouses[0].pensions[0];
    expect(back.harmonization).toBe(true);
    expect(back.amountAt65).toBe("36000");
  });
});
