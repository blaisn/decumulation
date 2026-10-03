import { describe, it, expect } from "vitest";
import table2026 from "../src/engine/data/tax-2026.json";
import { runProjection } from "../src/index";
import type { StrategySummary, TaxYearTable } from "../src/index";
import { changedPaths, defaultForm, describeChanges, fileFromJson, fileToJson, formFromJson, formToJson, parseNumber, strategyToForm, toScenario } from "../ui/src/model";
import { planToCsv } from "../ui/src/csv";
import { INCOME_LEGEND, balancesChart, sourcesChart, sourcesData } from "../ui/src/charts";
import { strategiesTable, yearTable } from "../ui/src/tables";
import { comparePanel } from "../ui/src/compare-view";
import { renderForm } from "../ui/src/form";
import { parsePrefs } from "../ui/src/prefs";
import { shareComplement } from "../ui/src/model";
import { deathMatrix, deathRankTable } from "../ui/src/tables";
import { compareLongevity } from "../src/index";
import { summarize } from "../src/index";
import { ALL_FREE, benefitRanges, choiceKey, currentChoice, enumerateChoices, evaluateChoices, rankResults } from "../src/index";
import type { BenefitChoice, ChoiceResult, OptimizationResult, Scenario } from "../src/index";
import { RRQ_MAX_AT_65, applyBenefitChoice, benefitHint, extraExpenseHint, incomeHint, newExtraExpense, newIncome, newProperty, principalResidenceCount, propertyHint, CAPITAL_GAINS_INCLUSION } from "../ui/src/model";
import type { ExtraExpenseForm, FormState, IncomeForm, PropertyForm } from "../ui/src/model";
import { fmtMoney } from "../ui/src/format";
import { choiceText, durationText, estimateSeconds, optionRows, plannedCount, progressText, resultsTable, verdictHtml } from "../ui/src/optimize-view";
import { OptimizationCancelled, chunkChoices, runChoices, workerCount } from "../ui/src/optimize-run";
import type { PoolWorker } from "../ui/src/optimize-run";
import { runJob } from "../ui/src/compute";
import type { Job } from "../ui/src/compute";

const tax = table2026 as unknown as TaxYearTable;
const has = (text: string, part: string) => text.includes(part);

/** Analyse le HTML du tableau annuel : en-têtes, et pour chaque ligne le type (ménage ou conjoint), l'année, l'âge et les cellules (texte affiché). */
interface ParsedRow { sub: boolean; hidden: boolean; year: number; who: string; ages: string; short: boolean; cells: string[] }
const decodeText = (t: string) => t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/[\u00a0\u202f]/g, " ");
function parseYearTable(html: string): { headers: string[]; rows: ParsedRow[] } {
  const headers = [...html.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => decodeText(m[1]));
  const rows = html.split("<tbody>")[1].split("</tr>").filter((r) => r.includes("<tr")).map((r): ParsedRow => ({
    sub: /<tr class="sub"/.test(r),
    hidden: /<tr[^>]* hidden/.test(r),
    year: Number(/data-year="(\d+)"/.exec(r)![1]),
    who: decodeText(/<th scope="row" class="who"[^>]*>([^<]*)</.exec(r)?.[1] ?? ""),
    ages: decodeText(/<th scope="row" class="ages">([^<]*)<\/th>/.exec(r)![1]),
    short: /<tr class="short"/.test(r),
    cells: [...r.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => decodeText(m[1])),
  }));
  return { headers, rows };
}
const digitsOf = (t: string) => (/\d/.test(t) ? Number(t.replace(/[^\d-]/g, "")) : 0);       // « — » et vide valent 0

/** CSV analysé : en-têtes et lignes; `col(ligne, nom)` lit une valeur par le nom de sa colonne, sans dépendre de l'ordre. */
function parseCsv(csv: string) {
  const [head, ...body] = csv.replace(/^\uFEFF/, "").trim().split("\r\n");
  const headers = head.split(";");
  const rows = body.map((l) => l.split(";"));
  return { headers, rows, col: (row: string[], name: string) => { const k = headers.indexOf(name); if (k < 0) throw new Error(`colonne absente du CSV : ${name}`); return row[k]; } };
}
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
    const t = parseCsv(csv);
    expect(t.headers.length).toBe(31);
    expect(new Set(t.rows.map((r) => r.length))).toEqual(new Set([31]));
    expect(t.col(t.rows[0], "Indice d'inflation (départ = 1)")).toBe("1,0000");                   // indice d'inflation de l'année de départ
    expect(t.col(t.rows[0], "Taux marginal (%)")).toBe((rows[0].spouses[0].marginalRate * 100).toFixed(2).replace(".", ","));
    expect(t.col(t.rows[2], "Indice d'inflation (départ = 1)")).toBe("1,0200");
    expect(t.headers[t.headers.length - 1]).toBe("Indice d'inflation (départ = 1)");               // colonne de référence : à la fin
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
    const { headers, rows: lines } = parseYearTable(yearTable(s, rows, false));
    expect(headers.slice(0, 7)).toEqual(["Année", "Âges", "Rentes de régimes", "RRQ", "PSV", "Retraits REER/FERR", "Retraits CELI"]);
    expect(headers.includes("Revenus garantis")).toBe(false);
    // 2033 : les deux conjoints touchent leurs rentes, la RRQ et la PSV
    const y = rows.find((r) => r.year === 2033)!;
    const cells = lines.find((l) => !l.sub && l.year === 2033)!.cells.map(digitsOf);
    const pick = (f: (p: (typeof y.spouses)[0]) => number) => Math.round(f(y.spouses[0]) + f(y.spouses[1]));
    expect(cells[0]).toBe(pick((p) => p.pensionIncome));
    expect(cells[1]).toBe(pick((p) => p.rrqIncome));
    expect(cells[2]).toBe(pick((p) => p.psvIncome));
    expect(cells[0] + cells[1] + cells[2]).toBeCloseTo(pick((p) => p.guaranteedIncome), -1);
  });
  it("le tableau annuel n'a plus de colonnes par conjoint : « Revenu imposable » et « Taux marginal » une seule fois chacune", () => {
    const { headers } = parseYearTable(yearTable(s, rows, false));
    expect(headers.filter((h) => h === "Revenu imposable").length).toBe(1);
    expect(headers.filter((h) => h === "Taux marginal").length).toBe(1);
    expect(headers.length).toBe(20);
    expect(headers.some((h) => /Alex|Sam/.test(h))).toBe(false);
    expect(headers.indexOf("Revenu imposable")).toBe(headers.indexOf("Pension fractionnée") + 1);
    expect(headers.indexOf("Taux marginal")).toBe(headers.indexOf("Revenu imposable") + 1);
    expect(headers.indexOf("Impôt")).toBe(headers.indexOf("Taux marginal") + 1);
  });
  it("ligne du ménage : revenu imposable total, taux marginal vide (il est propre à chaque personne)", () => {
    const { headers, rows: lines } = parseYearTable(yearTable(s, rows, false));
    const iTax = headers.indexOf("Revenu imposable") - 2, iRate = headers.indexOf("Taux marginal") - 2;
    const y = rows.find((r) => r.year === 2033)!;
    const parent = lines.find((l) => !l.sub && l.year === 2033)!;
    expect(digitsOf(parent.cells[iTax])).toBe(Math.round(y.spouses[0].taxableIncome + y.spouses[1].taxableIncome));
    expect(parent.cells[iRate]).toBe("");
  });
  it("chaque année a une ligne de ménage suivie d'une ligne par conjoint, masquées par défaut, avec le prénom et l'âge", () => {
    const { rows: lines } = parseYearTable(yearTable(s, rows, false));
    expect(lines.length).toBe(rows.length * 3);
    expect(lines.filter((l) => !l.sub).length).toBe(rows.length);
    for (let k = 0; k < lines.length; k += 3) {
      expect([lines[k].sub, lines[k + 1].sub, lines[k + 2].sub]).toEqual([false, true, true]);
      expect([lines[k + 1].year, lines[k + 2].year]).toEqual([lines[k].year, lines[k].year]);
      expect([lines[k + 1].hidden, lines[k + 2].hidden]).toEqual([true, true]);
    }
    const y2033 = lines.filter((l) => l.year === 2033);
    expect(y2033.map((l) => l.who)).toEqual(["", '<b>"Alex"</b>', "Sam"]);
    expect(y2033.map((l) => l.ages)).toEqual(["73 / 71", "73", "71"]);
  });
  it("ligne d'un conjoint : son revenu imposable, son taux marginal, sa part des dépenses et ses soldes", () => {
    const { headers, rows: lines } = parseYearTable(yearTable(s, rows, false));
    const at = (name: string) => headers.indexOf(name) - 2;
    const y = rows.find((r) => r.year === 2033)!;
    const [a, b] = lines.filter((l) => l.year === 2033 && l.sub);
    expect(digitsOf(a.cells[at("Revenu imposable")])).toBe(Math.round(y.spouses[0].taxableIncome));
    expect(digitsOf(b.cells[at("Revenu imposable")])).toBe(Math.round(y.spouses[1].taxableIncome));
    expect(a.cells[at("Taux marginal")]).toMatch(/^\d{2},\d{2} %$/);
    expect(b.cells[at("Taux marginal")]).toMatch(/^\d{2},\d{2} %$/);
    expect(digitsOf(a.cells[at("Dépenses visées")])).toBe(Math.round(y.spouses[0].spending));
    expect(digitsOf(b.cells[at("Solde REER/FERR")])).toBe(Math.round(y.spouses[1].reerBalanceEnd));
    expect(digitsOf(a.cells[at("Manque")])).toBe(Math.round(y.spouses[0].shortfall));       // sa part du manque (ici nulle : tout est financé)
  });
  it("ligne d'un conjoint : la pension fractionnée est signée (+ reçue, − cédée), comme dans le CSV", () => {
    const { headers, rows: lines } = parseYearTable(yearTable(s, rows, false));
    const i = headers.indexOf("Pension fractionnée") - 2;
    const y = rows.find((r) => r.year === 2033)!;
    expect(y.spouses[0].pensionSplit).not.toBe(0);
    const [a, b] = lines.filter((l) => l.year === 2033 && l.sub);
    expect(digitsOf(a.cells[i])).toBe(Math.round(y.spouses[0].pensionSplit));
    expect(digitsOf(b.cells[i])).toBe(Math.round(y.spouses[1].pensionSplit));
    expect(Math.sign(digitsOf(a.cells[i])) * Math.sign(digitsOf(b.cells[i]))).toBe(-1);     // l'un cède, l'autre reçoit
    const parent = lines.find((l) => !l.sub && l.year === 2033)!;
    expect(digitsOf(parent.cells[i])).toBe(Math.round(Math.max(y.spouses[0].pensionSplit, y.spouses[1].pensionSplit)));
  });
  it("après un décès, la ligne du conjoint décédé affiche † et « — »", () => {
    const { headers, rows: lines } = parseYearTable(yearTable(s, rows, false));
    const at = (name: string) => headers.indexOf(name) - 2;
    const [a, b] = lines.filter((l) => l.year === 2050 && l.sub);     // Alex est décédé depuis 2042
    expect(a.ages).toBe("†");
    expect(a.cells.every((c) => c === "—")).toBe(true);
    expect(b.ages).toMatch(/^\d+$/);
    expect(b.cells[at("Taux marginal")]).toMatch(/^\d{2},\d{2} %$/);
    expect(lines.find((l) => !l.sub && l.year === 2050)!.ages).toMatch(/^† \/ \d+$/);
  });
  it("le total du ménage est la somme des deux conjoints, colonne par colonne et année par année", () => {
    const { headers, rows: lines } = parseYearTable(yearTable(s, rows, false));
    const additive = ["Rentes de régimes", "RRQ", "PSV", "Retraits REER/FERR", "Retraits CELI", "Retraits non enr.", "Cotisation CELI", "Cotisation non enr.", "Impôt", "PSV récupérée", "Revenu imposable", "Dépenses visées", "Manque", "Solde REER/FERR", "Solde CELI", "Solde non enr."];
    expect(additive.every((h) => headers.includes(h))).toBe(true);
    let compared = 0;
    for (const parent of lines.filter((l) => !l.sub)) {
      const [a, b] = lines.filter((l) => l.sub && l.year === parent.year);
      for (const h of additive) {
        const i = headers.indexOf(h) - 2;
        expect(Math.abs(digitsOf(parent.cells[i]) - digitsOf(a.cells[i]) - digitsOf(b.cells[i]))).toBeLessThanOrEqual(1);       // arrondis
        compared++;
      }
    }
    expect(compared).toBe(rows.length * additive.length);
  });
  it("les années dépliées au départ n'ont plus l'attribut « hidden »; le bouton annonce son état", () => {
    const { rows: lines } = parseYearTable(yearTable(s, rows, false, new Set([2033])));
    expect(lines.filter((l) => l.sub && !l.hidden).map((l) => l.year)).toEqual([2033, 2033]);
    const html = yearTable(s, rows, false, new Set([2033]));
    expect(html).toContain('data-year="2033" aria-expanded="true"');
    expect(html).toContain('aria-label="Masquer le détail par conjoint de 2033"');
    expect(html).toContain('data-year="2034" aria-expanded="false"');
    expect(html).toContain('aria-label="Afficher le détail par conjoint de 2034"');
  });
  it("accessibilité : chaque bouton désigne ses deux lignes, qui existent, et le prénom est complété par l'année", () => {
    const html = yearTable(s, rows, false);
    const buttons = [...html.matchAll(/<button type="button" class="expander" data-action="toggle-year" data-year="(\d+)" aria-expanded="(true|false)" aria-controls="([^"]+)"/g)];
    expect(buttons.length).toBe(rows.length);
    for (const [, year, , controls] of buttons) {
      const ids = controls.split(" ");
      expect(ids).toEqual([`y${year}-0`, `y${year}-1`]);
      for (const id of ids) expect(html).toContain(`<tr class="sub" id="${id}"`);
    }
    expect(html).toContain('<span class="sr-only"> en 2033</span>');
    expect(html).toContain('title="Sam"');
  });
  it("le tableau annuel a une ligne de ménage par année et marque les décès", () => {
    const t = yearTable(s, rows, true);
    expect(parseYearTable(t).rows.filter((l) => !l.sub).length).toBe(rows.length);
    expect(has(t, "†")).toBe(true);
    expect(parseYearTable(t).rows.some((l) => l.short)).toBe(false);          // ce scénario finance toutes les dépenses
  });
  it("en dollars constants, les lignes des conjoints sont ramenées aux dollars de départ comme celles du ménage", () => {
    const nominal = parseYearTable(yearTable(s, rows, false)), real = parseYearTable(yearTable(s, rows, true));
    const i = nominal.headers.indexOf("Revenu imposable") - 2;
    const f = Math.pow(1 + s.assumptions.inflation, 2033 - s.assumptions.startYear);
    for (const idx of [0, 1, 2]) {
      const n = digitsOf(nominal.rows.filter((l) => l.year === 2033)[idx].cells[i]), r = digitsOf(real.rows.filter((l) => l.year === 2033)[idx].cells[i]);
      expect(Math.abs(r - n / f)).toBeLessThanOrEqual(1);
    }
  });
  it("les prénoms sont échappés dans les lignes des conjoints", () => {
    const html = yearTable(s, rows, false);
    expect(html).not.toContain('<b>"Alex"</b>');
    expect(html).toContain("&lt;b&gt;&quot;Alex&quot;&lt;/b&gt;");
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

describe("part des dépenses du couple", () => {
  const lines = (csv: string) => csv.trim().split("\r\n").slice(1).map((l) => l.split(";"));
  it("le premier conjoint a 50 % par défaut; le second n'a pas de champ saisi", () => {
    const f = defaultForm();
    expect(f.spouses[0].expenseShare).toBe("50");
    expect(f.spouses[1].expenseShare).toBe(undefined);
    expect(toScenario(f).scenario!.firstSpouseSpendingShare).toBe(0.5);
  });
  it("convertit le pourcentage saisi en fraction, virgule décimale comprise", () => {
    const f = defaultForm();
    f.spouses[0].expenseShare = "62,5";
    expect(toScenario(f).scenario!.firstSpouseSpendingShare).toBeCloseTo(0.625, 10);
    f.spouses[0].expenseShare = "0";
    expect(toScenario(f).scenario!.firstSpouseSpendingShare).toBe(0);
    f.spouses[0].expenseShare = "100";
    expect(toScenario(f).scenario!.firstSpouseSpendingShare).toBe(1);
  });
  it("refuse une part invalide ou hors de 0 à 100, avec le prénom", () => {
    for (const bad of ["abc", "-5", "101", ""]) {
      const f = defaultForm(); f.spouses[0].expenseShare = bad;
      const r = toScenario(f);
      expect(r.scenario).toBe(undefined);
      expect(r.errors.some((e) => e.includes("Alex : part des dépenses du couple"))).toBe(true);
    }
  });
  it("shareComplement : 100 moins la part, ou « — » si la saisie n'est pas valide", () => {
    expect(shareComplement("50")).toBe("50");
    expect(shareComplement("70")).toBe("30");
    expect(shareComplement("33,33")).toBe("66,67");
    expect(shareComplement("0")).toBe("100");
    expect(shareComplement("100")).toBe("0");
    for (const bad of ["", "abc", "-1", "120", undefined]) expect(shareComplement(bad)).toBe("—");
  });
  it("le formulaire : champ modifiable pour le premier conjoint, lecture seule (sans chemin de saisie) pour le second", () => {
    const f = defaultForm(); f.spouses[0].expenseShare = "70";
    const html = renderForm(f, new Set(["spouse0", "spouse1"]));
    expect(/data-path="spouses\.0\.expenseShare" value="70"/.test(html)).toBe(true);
    expect(html).not.toContain('data-path="spouses.1.expenseShare"');
    const ro = /<input type="text" readonly aria-readonly="true" tabindex="-1" data-share-complement value="([^"]*)">/.exec(html)!;
    expect(ro[1]).toBe("30");
    expect(html).toContain("affichage seulement");
    expect(html.split("Part des dépenses du couple dont il a la charge").length - 1).toBe(2);
  });
  it("le second conjoint se met à jour avec la part du premier, et indique « — » si elle est invalide", () => {
    const f = defaultForm(); f.spouses[0].expenseShare = "abc";
    expect(/data-share-complement value="—"/.test(renderForm(f, new Set(["spouse1"])))).toBe(true);
  });
  it("suit les changements depuis la base, avec le prénom", () => {
    const a = defaultForm(), b = JSON.parse(JSON.stringify(a)) as typeof a;
    b.spouses[0].expenseShare = "60";
    expect(describeChanges(a, b)).toEqual(["Alex, part des dépenses du couple : 50 → 60"]);
  });
  it("un ancien fichier sans ce champ reprend 50 %; l'aller-retour par fichier le conserve", () => {
    const old = JSON.parse(JSON.stringify(defaultForm())); delete old.spouses[0].expenseShare;
    expect(formFromJson(JSON.stringify({ form: old })).spouses[0].expenseShare).toBe("50");
    const f = defaultForm(); f.spouses[0].expenseShare = "65";
    expect(fileFromJson(fileToJson(f, null)).form.spouses[0].expenseShare).toBe("65");
  });
  it("CSV : la dépense visée et la part de chaque conjoint, qui totalisent la dépense du ménage", () => {
    const f = defaultForm(); f.spouses[0].expenseShare = "70"; f.spouses[0].deathAge = "";
    f.spouses[1].deathAge = "";
    const sc = toScenario(f).scenario!;
    const rows = runProjection(sc, tax);
    const t = parseCsv(planToCsv(sc, rows));
    const [a, b] = t.rows;                                   // 2026 : Alex puis Sam
    expect(t.col(a, "Dépenses visées")).toBe("70000");
    expect(t.col(b, "Dépenses visées")).toBe("30000");
    expect(t.col(a, "Part des dépenses (%)")).toBe("70,00");
    expect(t.col(b, "Part des dépenses (%)")).toBe("30,00");
    expect(Number(t.col(a, "Dépenses visées")) + Number(t.col(b, "Dépenses visées"))).toBe(Math.round(rows[0].targetSpending));
    // en 2030 : indexé à l'inflation, toujours 70 / 30
    const y = rows.find((r) => r.year === 2030)!;
    const r2030 = t.rows.filter((l) => t.col(l, "Année") === "2030");
    expect(Number(t.col(r2030[0], "Dépenses visées"))).toBe(Math.round(0.7 * y.targetSpending));
    expect(Number(t.col(r2030[1], "Dépenses visées"))).toBe(Math.round(0.3 * y.targetSpending));
  });
  it("CSV après un décès : le survivant a 100 % de la dépense réduite, le défunt 0", () => {
    const f = defaultForm(); f.spouses[0].expenseShare = "70"; f.spouses[0].deathAge = "80"; f.spouses[1].deathAge = "";
    const sc = toScenario(f).scenario!;
    const rows = runProjection(sc, tax);
    const t = parseCsv(planToCsv(sc, rows));
    const apres = t.rows.filter((l) => t.col(l, "Année") === "2041");        // Alex est né en 1960 : décès fin 2040
    expect(t.col(apres[0], "Dépenses visées")).toBe("0");
    expect(t.col(apres[0], "Part des dépenses (%)")).toBe("0,00");
    expect(t.col(apres[1], "Part des dépenses (%)")).toBe("100,00");
    expect(Number(t.col(apres[1], "Dépenses visées"))).toBe(Math.round(rows.find((r) => r.year === 2041)!.targetSpending));
  });
});

describe("graphique « D'où vient l'argent » : le manque de fonds", () => {
  const plan = (spending: string) => {
    const f = defaultForm(); f.spending = spending;
    const sc = toScenario(f).scenario!;
    return { sc, rows: runProjection(sc, tax) };
  };
  const SHORT = plan("150000");        // les actifs s'épuisent à partir de 2046
  const FINE = plan("100000");         // toutes les dépenses sont financées

  it("le scénario d'essai a bien des années en manque, et pas toutes", () => {
    const years = SHORT.rows.filter((y) => y.shortfall > 1).map((y) => y.year);
    expect(years.length).toBeGreaterThan(5);
    expect(years.length).toBeLessThan(SHORT.rows.length);
    expect(FINE.rows.every((y) => y.shortfall < 1)).toBe(true);
  });
  it("identité des données : colonnes + manque = ligne + surplus réinvesti, chaque année, dollars courants et constants", () => {
    for (const { sc, rows } of [SHORT, FINE]) for (const real of [false, true]) {
      const d = sourcesData(sc, rows, real);
      rows.forEach((_, k) => expect(Math.abs(d.stacks[k] + d.shortfall[k] - d.outflow[k] - d.contributions[k])).toBeLessThan(1e-6));
    }
  });
  it("en manque, la ligne passe au-dessus des colonnes d'exactement le manque (c'était le bogue : elle les suivait)", () => {
    const d = sourcesData(SHORT.sc, SHORT.rows, false);
    let vus = 0;
    SHORT.rows.forEach((y, k) => {
      if (y.shortfall > 1) {
        vus++;
        expect(d.outflow[k] - d.stacks[k]).toBeCloseTo(y.shortfall, 4);
        expect(d.outflow[k]).toBeGreaterThan(d.stacks[k] + 1);
        expect(d.contributions[k]).toBe(0);
      }
    });
    expect(vus).toBeGreaterThan(5);
  });
  it("la ligne représente la dépense visée : elle ne soustrait jamais le manque", () => {
    const d = sourcesData(SHORT.sc, SHORT.rows, false);
    const y = SHORT.rows[SHORT.rows.length - 1];
    const k = SHORT.rows.length - 1;
    expect(d.outflow[k]).toBeCloseTo(y.targetSpending + y.spouses[0].tax + y.spouses[1].tax + y.spouses[0].psvClawback + y.spouses[1].psvClawback, 4);
  });
  it("sans manque, la ligne ne dépasse jamais les colonnes (l'excédent est réinvesti)", () => {
    const d = sourcesData(FINE.sc, FINE.rows, false);
    FINE.rows.forEach((_, k) => expect(d.stacks[k]).toBeGreaterThanOrEqual(d.outflow[k] - 1e-6));
  });
  it("une zone rouge par année en manque, et seulement celles-là", () => {
    const n = SHORT.rows.filter((y) => y.shortfall > 1).length;
    const svg = sourcesChart(SHORT.sc, SHORT.rows, false);
    expect(svg.split('class="s-short"').length - 1).toBe(n);
    expect(svg).toContain("MANQUE");
    expect(svg).toContain("les dépenses visées ne sont pas toutes financées à partir de 2046");
    const fine = sourcesChart(FINE.sc, FINE.rows, false);
    expect(fine.split('class="s-short"').length - 1).toBe(0);
    expect(fine).not.toContain("MANQUE");
    expect(fine).not.toContain("pas toutes financées");
  });
  it("la zone rouge relie le dessus des colonnes à la ligne (hauteur proportionnelle au manque)", () => {
    const svg = sourcesChart(SHORT.sc, SHORT.rows, false);
    const hs = [...svg.matchAll(/class="s-short" [^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(hs.length).toBeGreaterThan(5);
    expect(hs.every((h) => h > 0)).toBe(true);
    expect(hs[hs.length - 1]).toBeGreaterThan(hs[0]);     // le manque grandit à mesure que les actifs s'épuisent
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("formulaire : RRQ et PSV au montant de 65 ans", () => {
  const plain = (t: string) => t.replace(/[\u00a0\u202f]/g, " ");
  it("l'aperçu de la rente ajustée : 65 ans, sans ajustement", () => {
    expect(benefitHint("rrq", "14000", "65")).toBe("À 65 ans : le montant de 65 ans, sans réduction ni bonification.");
    expect(benefitHint("psv", "8700", "65")).toBe("À 65 ans : le montant de 65 ans, sans réduction ni bonification.");
  });
  it("RRQ reportée : montant bonifié et pourcentage", () => {
    const t = plain(benefitHint("rrq", "14000", "70"));
    expect(t).toContain("19 880 $");           // 14 000 x 1,42
    expect(t).toContain("+42,0 %");
    expect(plain(benefitHint("rrq", "14000", "72"))).toContain("+58,8 %");
  });
  it("RRQ anticipée : réduction de 36 % pour la rente maximale à 60 ans, moindre pour une plus petite rente", () => {
    const max = plain(benefitHint("rrq", String(RRQ_MAX_AT_65), "60"));
    expect(max).toContain("−36,0 %");
    expect(max).toContain("11 579 $");         // 18 091,80 x 0,64
    const small = plain(benefitHint("rrq", "9000", "60"));
    expect(small).toMatch(/−3[0-5],\d %/);
    expect(small).not.toContain("−36,0 %");
  });
  it("PSV reportée de cinq ans : +36 %", () => {
    const t = plain(benefitHint("psv", "8700", "70"));
    expect(t).toContain("11 832 $");
    expect(t).toContain("+36,0 %");
  });
  it("aucun aperçu si le montant ou l'âge n'est pas valide ou hors des limites", () => {
    for (const [k, a, age] of [["rrq", "abc", "65"], ["rrq", "14000", ""], ["rrq", "-5", "65"], ["rrq", "14000", "59"], ["rrq", "14000", "73"], ["psv", "8700", "64"], ["psv", "8700", "71"], ["psv", "8700", "66,5"]] as const) {
      expect(benefitHint(k, a, age)).toBe("");
    }
  });
  it("le formulaire demande les montants à 65 ans et affiche l'aperçu sous chaque rente", () => {
    const f = defaultForm();
    f.spouses[1].rrqStartAge = "70";
    const html = plain(renderForm(f, new Set(["spouse0", "spouse1"])));
    expect(html).toContain("RRQ, montant annuel à 65 ans");
    expect(html).toContain("PSV, montant annuel à 65 ans");
    expect(html).toContain("De 60 à 72 ans");
    expect(html).toContain("De 65 à 70 ans");
    expect(html).toContain('data-benefit-hint="spouses.0.rrq"');
    expect(html).toContain('data-benefit-hint="spouses.1.psv"');
    const hint = /data-benefit-hint="spouses\.1\.rrq"[^>]*>([^<]*)</.exec(html)![1];
    expect(hint).toContain("+42,0 %");
  });
  it("le suivi des changements nomme les montants « à 65 ans »", () => {
    const a = defaultForm(), b = JSON.parse(JSON.stringify(a)) as typeof a;
    b.spouses[0].rrqAmount = "15000"; b.spouses[0].psvStartAge = "68";
    expect(describeChanges(a, b)).toEqual(["Alex, RRQ, montant à 65 ans : 14000 → 15000", "Alex, PSV, début : 65 → 68"]);
  });
  it("appliquer une combinaison met à jour les quatre âges de début et rien d'autre", () => {
    const f = defaultForm();
    const before = JSON.stringify({ ...f, spouses: f.spouses.map((s) => ({ ...s, rrqStartAge: 0, psvStartAge: 0 })) });
    applyBenefitChoice(f, { rrq: [66, 70], psv: [67, 69] });
    expect([f.spouses[0].rrqStartAge, f.spouses[1].rrqStartAge, f.spouses[0].psvStartAge, f.spouses[1].psvStartAge]).toEqual(["66", "70", "67", "69"]);
    expect(JSON.stringify({ ...f, spouses: f.spouses.map((s) => ({ ...s, rrqStartAge: 0, psvStartAge: 0 })) })).toBe(before);
    const sc = toScenario(f).scenario!;
    expect(currentChoice(sc)).toEqual({ rrq: [66, 70], psv: [67, 69] });
  });
});

describe("onglet Optimisation PSV/RRQ : vue", () => {
  const scenario = toScenario(defaultForm()).scenario!;      // Alex 66 ans (rentes commencées), Sam 64 ans
  const choices = enumerateChoices(benefitRanges(scenario, ALL_FREE));
  const mk = (choice: BenefitChoice, estate: number, shortfall = 0): ChoiceResult => ({
    choice, key: choiceKey(choice), afterTaxEstate: estate, totalShortfall: shortfall, yearsWithShortfall: shortfall > 0 ? 3 : 0, totalTax: 100000, totalClawback: 0,
    nominal: { afterTaxEstate: estate * 1.5, totalShortfall: shortfall * 1.5, totalTax: 150000, totalClawback: 0 },
  });
  const cur = choiceKey(currentChoice(scenario));
  /** La succession augmente avec le rang du tableau `choices`, sauf pour les choix actuels qui reçoivent `currentEstate`. */
  const results = (currentEstate: number, shortfallOf: (k: number) => number = () => 0) =>
    choices.map((c, k) => (choiceKey(c) === cur ? mk(c, currentEstate, shortfallOf(-1)) : mk(c, 1_000_000 + k * 1000, shortfallOf(k))));
  const plain = (t: string) => t.replace(/[\u00a0\u202f]/g, " ");
  const visible = (t: string) => plain(t.replace(/<[^>]+>/g, ""));       // texte affiché, sans les balises

  it("le scénario d'essai : 54 combinaisons, Alex n'a rien à choisir", () => {
    expect(choices.length).toBe(54);
    expect(plannedCount(scenario, ALL_FREE)).toBe(54);
    expect(plannedCount(scenario, { rrq: [true, false], psv: [true, true] })).toBe(6);
    expect(plannedCount(scenario, { rrq: [false, false], psv: [false, false] })).toBe(1);
  });
  it("les cases à cocher : une par rente à explorer, et les rentes déjà commencées sont grisées avec la raison", () => {
    const html = plain(optionRows(scenario, ALL_FREE));
    expect(html).toContain('data-free="rrq:1"');
    expect(html).toContain('data-free="psv:1"');
    expect(html).not.toContain('data-free="rrq:0"');
    expect(html).toContain("RRQ : déjà commencée à 65 ans");
    expect(html).toContain("PSV : déjà commencée à 65 ans");
    expect(html).toContain("RRQ : essayer de 64 à 72 ans");
    expect(html).toContain("(9 choix)");
    expect(html).toContain("PSV : essayer de 65 à 70 ans");
    expect((html.match(/ disabled/g) ?? []).length).toBe(2);
    expect((html.match(/ checked/g) ?? []).length).toBe(2);
  });
  it("une case décochée n'est plus cochée", () => {
    const html = optionRows(scenario, { rrq: [true, false], psv: [true, true] });
    expect(/data-free="rrq:1" checked/.test(html)).toBe(false);
    expect(/data-free="psv:1" checked/.test(html)).toBe(true);
  });
  it("les prénoms sont échappés", () => {
    const sc = { ...scenario, spouses: [{ ...scenario.spouses[0], name: "<b>Zoé</b>" }, scenario.spouses[1]] } as Scenario;
    expect(optionRows(sc, ALL_FREE)).toContain("&lt;b&gt;Zoé&lt;/b&gt;");
    expect(optionRows(sc, ALL_FREE)).not.toContain("<b>Zoé</b>");
    expect(choiceText(sc, currentChoice(sc))).not.toContain("<b>Zoé</b>");
  });
  it("estimation de la durée : proportionnelle aux combinaisons, divisée par les workers", () => {
    expect(estimateSeconds(1000, 50, 1)).toBeCloseTo(57.5, 6);
    expect(estimateSeconds(1000, 50, 5)).toBeCloseTo(11.5, 6);
    expect(estimateSeconds(10, 0, 0)).toBeGreaterThan(0);
    expect(durationText(2)).toBe("quelques secondes");
    expect(durationText(12)).toBe("environ 10 secondes");
    expect(durationText(47)).toBe("environ 45 secondes");
    expect(durationText(150)).toBe("environ 3 minutes");
  });
  it("texte de progression, avec le temps restant", () => {
    expect(progressText(0, 480, 0)).toBe("0 sur 480 combinaisons essayées…");
    expect(plain(progressText(120, 480, 10000))).toBe("120 sur 480 combinaisons essayées, il reste environ 30 secondes.");
    expect(plain(progressText(480, 480, 40000))).toBe("480 sur 480 combinaisons essayées.");
  });

  const rank = (r: ChoiceResult[]): OptimizationResult => rankResults(scenario, r);
  it("verdict : les choix actuels sont déjà les meilleurs", () => {
    const res = rank(results(9_999_999));
    const t = plain(verdictHtml(scenario, res, true));
    expect(t).toContain("Vos choix actuels sont déjà les meilleurs parmi les 54 combinaisons essayées");
    expect(t).toContain("9 999 999 $");
  });
  it("verdict : la meilleure combinaison laisse X de plus, avec les âges de chaque conjoint", () => {
    const res = rank(results(1_000_000));
    const best = res.best.afterTaxEstate;
    const t = plain(verdictHtml(scenario, res, true));
    expect(t).toContain("La meilleure combinaison, parmi les 54 essayées, laisse");
    expect(t).toContain(`${plain(String(Math.round(best - 1_000_000)).replace(/\B(?=(\d{3})+(?!\d))/g, " "))} $ de plus`);
    expect(t).toContain("Alex</strong> : RRQ à 65 ans, PSV à 65 ans");
    expect(t).toContain("Sam</strong> : RRQ à");
    expect(t).toContain("L'écart entre la meilleure et la pire combinaison");
  });
  it("verdict : les montants suivent l'unité choisie (dollars courants = x 1,5 dans ce jeu d'essai)", () => {
    const res = rank(results(1_000_000));
    const reel = plain(verdictHtml(scenario, res, true)), nominal = plain(verdictHtml(scenario, res, false));
    expect(reel).not.toBe(nominal);
    expect(nominal).toContain("1 500 000 $");
  });
  it("verdict : les choix actuels manquent d'argent, la meilleure combinaison finance tout", () => {
    const res = rank(results(500_000, (k) => (k === -1 ? 25_000 : 0)));
    const t = visible(verdictHtml(scenario, res, true));
    expect(t).toContain("Avec vos choix actuels, il manque 25 000 $ au total (3 années)");
    expect(t).toContain("finance toutes les dépenses");
  });
  it("verdict : aucune combinaison ne finance tout", () => {
    const res = rank(results(100, (k) => (k === -1 ? 90_000 : 40_000 - k)));
    expect(res.anyFeasible).toBe(false);
    const t = plain(verdictHtml(scenario, res, true));
    expect(t).toContain("Aucune des 54 combinaisons ne finance toutes les dépenses");
    expect(t).toContain("90 000 $");
  });
  it("tableau : dix meilleures combinaisons, puis les choix actuels s'ils sont plus bas", () => {
    const res = rank(results(1_000_000));
    const html = resultsTable(scenario, res, true);
    const rows = html.split("<tbody>")[1].split("</tr>").filter((r) => r.includes("<tr"));
    expect(rows.length).toBe(11);
    expect(rows[0]).toContain('class="best"');
    expect(rows[0]).toContain("n° 1");
    expect(rows[10]).toContain('class="current"');
    expect(visible(rows[10])).toContain("Vos choix actuels (n° 54)");
    expect(rows[10]).not.toContain("apply-benefits");
    const buttons = [...html.matchAll(/data-action="apply-benefits" data-index="(\d+)"/g)].map((m) => Number(m[1]));
    expect(buttons).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it("tableau : les choix actuels dans les dix premiers sont repérés sans bouton, et les âges modifiés sont en évidence", () => {
    const res = rank(results(9_999_999));
    const html = resultsTable(scenario, res, true);
    const rows = html.split("<tbody>")[1].split("</tr>").filter((r) => r.includes("<tr"));
    expect(rows.length).toBe(10);
    expect(rows[0]).toContain('class="current best"');
    expect((rows[0].match(/class="chg"/g) ?? []).length).toBe(0);                         // aucun âge ne diffère des choix actuels
    expect((rows[1].match(/class="chg"/g) ?? []).length).toBeGreaterThan(0);
    expect((html.match(/apply-benefits/g) ?? []).length).toBe(9);
  });
  it("tableau : écart de succession avec signe, manque cumulé et en-têtes avec les prénoms", () => {
    const res = rank(results(1_000_000));
    const html = plain(resultsTable(scenario, res, true));
    expect(html).toContain("+53 000 $");                  // meilleure (1 053 000 $) moins choix actuels (1 000 000 $)
    expect(html).toContain("Aucun");
    expect(html).toContain('<span class="sub">Alex</span>');
    expect(html).toContain('<span class="sub">Sam</span>');
    const bad = rank(results(100, (k) => (k === -1 ? 90_000 : 40_000 - k)));
    const t = plain(resultsTable(scenario, bad, true));
    expect(t).toContain("90 000 $");
    expect(t).not.toContain("Aucun");
    expect(t).not.toContain('class="best"');             // aucune combinaison ne finance tout : pas de mise en évidence « meilleure »
  });
});

describe("onglet Optimisation PSV/RRQ : calcul parallèle", () => {
  const scenario = toScenario(defaultForm()).scenario!;
  const choices = enumerateChoices(benefitRanges(scenario, ALL_FREE)).slice(0, 20);      // 20 combinaisons
  const expected = evaluateChoices(scenario, tax, choices);                                // calculées une seule fois
  const lookup = new Map(expected.map((r) => [r.key, r]));
  const fastEval = (job: Job) => (job as Extract<Job, { kind: "choices" }>).choices.map((c) => lookup.get(choiceKey(c))!);
  const sameAsExpected = (r: ChoiceResult[]) => JSON.stringify(r) === JSON.stringify(expected);

  /** Faux worker : répond de façon asynchrone, comme un vrai, avec diverses pannes possibles. */
  class FakeWorker implements PoolWorker {
    static all: FakeWorker[] = []; static inFlight = 0; static maxInFlight = 0;
    onmessage: PoolWorker["onmessage"] = null; onerror: PoolWorker["onerror"] = null;
    terminated = false; handled = 0;
    constructor(private mode: "ok" | "load-error" | "bad-result" | "dies-after-first" = "ok", private compute: (j: Job) => unknown = fastEval) { FakeWorker.all.push(this); }
    static reset() { FakeWorker.all = []; FakeWorker.inFlight = 0; FakeWorker.maxInFlight = 0; }
    postMessage(m: { id: number; job: Job }) {
      FakeWorker.inFlight++; FakeWorker.maxInFlight = Math.max(FakeWorker.maxInFlight, FakeWorker.inFlight);
      setTimeout(() => {
        FakeWorker.inFlight--;
        if (this.terminated) return;
        this.handled++;
        if (this.mode === "load-error" || (this.mode === "dies-after-first" && this.handled > 1)) { this.onerror?.({}); return; }
        if (this.mode === "bad-result") { this.onmessage?.({ data: { id: m.id, ok: false, error: "échec simulé" } }); return; }
        this.onmessage?.({ data: { id: m.id, ok: true, result: this.compute(m.job) } });
      }, 2);
    }
    terminate() { this.terminated = true; }
  }
  const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

  it("découpe en lots et choisit le nombre de workers en laissant un cœur libre", () => {
    expect(chunkChoices([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(chunkChoices([], 3)).toEqual([]);
    expect([undefined, 1, 2, 4, 8, 32].map(workerCount)).toEqual([3, 1, 1, 3, 7, 8]);
  });
  it("répartit le travail entre plusieurs workers et rend les résultats dans l'ordre", async () => {
    FakeWorker.reset();
    const progress: [number, number][] = [];
    const run = runChoices(scenario, {}, choices, (d, t) => progress.push([d, t]), { createWorker: () => new FakeWorker(), workers: 3, chunkSize: 4, evaluate: fastEval });
    const res = await run.promise;
    expect(sameAsExpected(res)).toBe(true);
    expect(FakeWorker.all.length).toBe(3);
    expect(FakeWorker.maxInFlight).toBe(3);                      // trois lots en parallèle
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
    expect(progress[0]).toEqual([0, 20]);
    expect(progress[progress.length - 1]).toEqual([20, 20]);
    for (let k = 1; k < progress.length; k++) expect(progress[k][0]).toBeGreaterThan(progress[k - 1][0]);
    expect(FakeWorker.all.reduce((n, w) => n + w.handled, 0)).toBe(5);          // 20 combinaisons en lots de 4
  });
  it("n'utilise pas plus de workers qu'il n'y a de lots", async () => {
    FakeWorker.reset();
    await runChoices(scenario, {}, choices.slice(0, 5), () => {}, { createWorker: () => new FakeWorker(), workers: 8, chunkSize: 4, evaluate: fastEval }).promise;
    expect(FakeWorker.all.length).toBe(2);
  });
  it("avec le vrai calcul : mêmes résultats qu'une évaluation directe", async () => {
    FakeWorker.reset();
    const few = choices.slice(0, 6);
    const res = await runChoices(scenario, {}, few, () => {}, { createWorker: () => new FakeWorker("ok", (j) => runJob(j)), workers: 2, chunkSize: 3, evaluate: runJob }).promise;
    expect(JSON.stringify(res)).toBe(JSON.stringify(evaluateChoices(scenario, tax, few)));
  });
  it("sans worker, le calcul se fait dans le fil principal, une combinaison à la fois, en rendant la main à l'interface entre chacune", async () => {
    let yields = 0, calls = 0;
    const progress: number[] = [];
    const res = await runChoices(scenario, {}, choices, (d) => progress.push(d), {
      chunkSize: 4, evaluate: (j) => { calls++; return fastEval(j); }, yieldToUi: async () => { yields++; },
    }).promise;
    expect(sameAsExpected(res)).toBe(true);
    expect(yields).toBe(20);                 // une pause avant chaque combinaison
    expect(calls).toBe(20);
    expect(progress.length).toBe(26);        // 0, puis une mise à jour par combinaison (20) et une par lot terminé (5)
    for (let k = 1; k < progress.length; k++) expect(progress[k]).toBeGreaterThanOrEqual(progress[k - 1]);
    expect(progress[progress.length - 1]).toBe(20);
  });
  it("le lot par défaut est petit (4 combinaisons) pour que les workers répondent souvent", async () => {
    FakeWorker.reset();
    await runChoices(scenario, {}, choices, () => {}, { createWorker: () => new FakeWorker(), workers: 2, evaluate: fastEval }).promise;
    expect(FakeWorker.all.reduce((n, w) => n + w.handled, 0)).toBe(5);       // 20 combinaisons : 5 lots de 4
  });
  it("si la création du worker échoue, le calcul continue dans le fil principal", async () => {
    const res = await runChoices(scenario, {}, choices, () => {}, { createWorker: () => { throw new Error("pas de worker"); }, workers: 3, chunkSize: 4, evaluate: fastEval }).promise;
    expect(sameAsExpected(res)).toBe(true);
  });
  it("si un worker ne se charge pas, le calcul continue dans le fil principal et les workers sont arrêtés", async () => {
    FakeWorker.reset();
    const res = await runChoices(scenario, {}, choices, () => {}, { createWorker: () => new FakeWorker("load-error"), workers: 3, chunkSize: 4, evaluate: fastEval }).promise;
    expect(sameAsExpected(res)).toBe(true);
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
  });
  it("si un worker répond par une erreur, le calcul continue dans le fil principal", async () => {
    FakeWorker.reset();
    const res = await runChoices(scenario, {}, choices, () => {}, { createWorker: () => new FakeWorker("bad-result"), workers: 2, chunkSize: 4, evaluate: fastEval }).promise;
    expect(sameAsExpected(res)).toBe(true);
  });
  it("si un worker tombe en panne en cours de route, seuls les lots manquants sont recalculés, sans doublon", async () => {
    FakeWorker.reset();
    let inline = 0;
    let n = 0;
    const res = await runChoices(scenario, {}, choices, () => {}, {
      createWorker: () => new FakeWorker(n++ === 0 ? "ok" : "dies-after-first"), workers: 2, chunkSize: 2,
      evaluate: (j) => { inline++; return fastEval(j); },
    }).promise;
    expect(sameAsExpected(res)).toBe(true);
    expect(res.length).toBe(20);
    expect(inline).toBeLessThan(20);              // 20 combinaisons : une partie a été calculée par les workers
    expect(inline % 2).toBe(0);                    // et le calcul de secours ne refait que des lots entiers (lots de 2)
  });
  it("annuler rejette avec OptimizationCancelled, arrête les workers et ignore les réponses tardives", async () => {
    FakeWorker.reset();
    const progress: number[] = [];
    const run = runChoices(scenario, {}, choices, (d) => progress.push(d), { createWorker: () => new FakeWorker(), workers: 2, chunkSize: 4, evaluate: fastEval });
    run.cancel();
    let error: unknown = null;
    try { await run.promise; } catch (e) { error = e; }
    expect(error instanceof OptimizationCancelled).toBe(true);
    expect((error as Error).message).toBe("Optimisation annulée");
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
    await tick();
    expect(Math.max(...progress)).toBe(0);        // rien n'a été compté après l'annulation
  });
  it("annuler pendant un calcul dans le fil principal l'arrête", async () => {
    let done = 0;
    const run = runChoices(scenario, {}, choices, (d) => { done = d; }, { chunkSize: 2, evaluate: fastEval, yieldToUi: () => tick(4) });
    await tick(14);
    run.cancel();
    let cancelled = false;
    try { await run.promise; } catch (e) { cancelled = e instanceof OptimizationCancelled; }
    expect(cancelled).toBe(true);
    const at = done;
    await tick(40);
    expect(done).toBe(at);                          // plus aucun lot calculé après l'annulation
    expect(at).toBeLessThan(20);
  });
  it("annuler après la fin ne change rien", async () => {
    const run = runChoices(scenario, {}, choices.slice(0, 4), () => {}, { chunkSize: 4, evaluate: fastEval });
    const res = await run.promise;
    run.cancel();
    expect(res.length).toBe(4);
  });
  it("sans combinaison, le résultat est vide tout de suite", async () => {
    const calls: [number, number][] = [];
    const res = await runChoices(scenario, {}, [], (d, t) => calls.push([d, t]), { evaluate: fastEval }).promise;
    expect(res).toEqual([]);
    expect(calls).toEqual([[0, 0]]);
  });
  it("une erreur du calcul de secours est rapportée", async () => {
    let message = "";
    try { await runChoices(scenario, {}, choices, () => {}, { chunkSize: 4, evaluate: () => { throw new Error("calcul impossible"); } }).promise; } catch (e) { message = (e as Error).message; }
    expect(message).toBe("calcul impossible");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("immeubles : formulaire et scénario", () => {
  const chalet = (o: Partial<PropertyForm> = {}): PropertyForm => ({ label: "Chalet", owner: "both", principalResidence: false, purchaseYear: "2000", purchasePrice: "200000", saleYear: "2030", salePrice: "600000", ...o });
  const withProps = (...ps: PropertyForm[]): FormState => { const f = defaultForm(); f.properties = ps; return f; };
  const errorsOf = (f: FormState) => toScenario(f).errors;
  const plain = (t: string) => t.replace(/[\u00a0\u202f]/g, " ").replace(/&#39;/g, "'");       // texte affiché : espaces insécables et apostrophes décodés

  it("par défaut : aucun immeuble, et le scénario n'a pas de champ « properties »", () => {
    const f = defaultForm();
    expect(f.properties).toEqual([]);
    const sc = toScenario(f).scenario!;
    expect("properties" in sc).toBe(false);
  });
  it("un nouvel immeuble : acheté 15 ans avant le début du plan, sans vente, valide, et sans effet sur le plan", () => {
    const n = newProperty("2026");
    expect(n).toEqual({ label: "", owner: "both", principalResidence: false, purchaseYear: "2011", purchasePrice: "", saleYear: "", salePrice: "" });
    expect(newProperty("abc").purchaseYear).toBe("2011");
    const f = withProps(n);
    const r = toScenario(f);
    expect(r.errors).toEqual([]);
    expect(r.scenario!.properties).toEqual([{ label: "Immeuble 1", owner: "both", purchaseYear: 2011, purchasePrice: 0, principalResidence: false }]);
    expect(JSON.stringify(runProjection(r.scenario!, tax))).toBe(JSON.stringify(runProjection(toScenario(defaultForm()).scenario!, tax)));
  });
  it("convertit la saisie : propriétaire, résidence principale, nombres avec espaces et virgule", () => {
    const f = withProps(chalet({ owner: "0", salePrice: "600 000,50", purchasePrice: "200 000" }), chalet({ label: "", owner: "1", principalResidence: true, purchasePrice: "" }), chalet({ owner: "both" }));
    const p = toScenario(f).scenario!.properties!;
    expect(p[0]).toEqual({ label: "Chalet", owner: 0, purchaseYear: 2000, purchasePrice: 200000, saleYear: 2030, salePrice: 600000.5, principalResidence: false });
    expect(p[1].owner).toBe(1);
    expect(p[1].principalResidence).toBe(true);
    expect(p[1].purchasePrice).toBe(0);              // facultatif pour une résidence principale
    expect(p[1].label).toBe("Immeuble 2");
    expect(p[2].owner).toBe("both");
  });
  it("l'achat doit précéder le début du plan : l'achat pendant le plan n'est pas encore pris en charge", () => {
    for (const year of ["2026", "2030"]) {
      const e = errorsOf(withProps(chalet({ purchaseYear: year })));
      expect(e.some((x) => x.includes("Immeuble 1 (Chalet) : année d'achat") && x.includes("doit précéder le début du plan (2026)") && x.includes("pas encore pris en charge"))).toBe(true);
    }
    expect(errorsOf(withProps(chalet({ purchaseYear: "2025" })))).toEqual([]);
  });
  it("la vente doit avoir lieu à partir du début du plan", () => {
    expect(errorsOf(withProps(chalet({ saleYear: "2025" }))).some((x) => x.includes("année de vente 2025") && x.includes("début du plan (2026)"))).toBe(true);
    expect(errorsOf(withProps(chalet({ saleYear: "2026" })))).toEqual([]);
  });
  it("avec une vente, le prix de vente est obligatoire, et le prix d'achat aussi sauf pour une résidence principale", () => {
    expect(errorsOf(withProps(chalet({ salePrice: "" })))).toEqual(["Immeuble 1 (Chalet) : prix de vente : entrez une valeur."]);
    expect(errorsOf(withProps(chalet({ purchasePrice: "" })))).toEqual(["Immeuble 1 (Chalet) : prix d'achat : entrez une valeur."]);
    expect(errorsOf(withProps(chalet({ purchasePrice: "", principalResidence: true })))).toEqual([]);
  });
  it("sans vente, les prix sont facultatifs mais doivent être valides s'ils sont saisis", () => {
    expect(errorsOf(withProps(chalet({ saleYear: "", salePrice: "", purchasePrice: "" })))).toEqual([]);
    expect(errorsOf(withProps(chalet({ saleYear: "", salePrice: "abc" }))).length).toBe(1);
    expect(errorsOf(withProps(chalet({ saleYear: "", purchasePrice: "-5" }))).some((x) => x.includes("prix d'achat"))).toBe(true);
  });
  it("refuse des années non entières et des prix négatifs, en nommant l'immeuble", () => {
    expect(errorsOf(withProps(chalet({ purchaseYear: "2000,5" }))).some((x) => x.includes("Immeuble 1 (Chalet) : année d'achat : entrez un nombre entier"))).toBe(true);
    expect(errorsOf(withProps(chalet({ saleYear: "abc" }))).some((x) => x.includes("année de vente") && x.includes("n'est pas un nombre"))).toBe(true);
    expect(errorsOf(withProps(chalet({ salePrice: "-1" }))).some((x) => x.includes("prix de vente"))).toBe(true);
    const e = errorsOf(withProps(chalet(), chalet({ label: "", salePrice: "" })));
    expect(e).toEqual(["Immeuble 2 : prix de vente : entrez une valeur."]);
  });
  it("principalResidenceCount compte les résidences principales cochées", () => {
    expect(principalResidenceCount(withProps())).toBe(0);
    expect(principalResidenceCount(withProps(chalet({ principalResidence: true }), chalet(), chalet({ principalResidence: true })))).toBe(2);
  });

  // ---- aperçu
  it("aperçu sans vente : l'immeuble n'a aucun effet", () => {
    expect(propertyHint(withProps(chalet({ saleYear: "", salePrice: "" })), 0)).toContain("n'a aucun effet sur les calculs");
    expect(propertyHint(withProps(), 3)).toBe("");
  });
  it("aperçu d'une vente : prix en dollars de départ, gain en capital et part imposable", () => {
    const t = plain(propertyHint(withProps(chalet()), 0));
    const deflated = plain(fmtMoney(600000 / Math.pow(1.02, 4)));
    expect(t).toContain(`Prix de vente de ${deflated} en dollars de 2026`);
    expect(t).toContain("gain en capital de 400 000 $, dont 200 000 $ imposables");
    expect(CAPITAL_GAINS_INCLUSION).toBe(0.5);
  });
  it("aperçu : résidence principale exonérée, perte en capital, aucun gain", () => {
    expect(plain(propertyHint(withProps(chalet({ principalResidence: true })), 0))).toContain("résidence principale : gain exonéré d'impôt");
    expect(plain(propertyHint(withProps(chalet({ purchasePrice: "700000" })), 0))).toContain("perte en capital de 100 000 $ (sans effet sur l'impôt)");
    expect(plain(propertyHint(withProps(chalet({ purchasePrice: "600000" })), 0))).toContain("aucun gain en capital");
  });
  it("aperçu : avertit quand la vente a lieu après la fin du plan", () => {
    const t = plain(propertyHint(withProps(chalet({ saleYear: "2060" })), 0));
    expect(t).toContain("après la fin du plan (2057)");         // le plus jeune (1962) a 95 ans en 2057
    expect(plain(propertyHint(withProps(chalet({ saleYear: "2057" })), 0))).not.toContain("après la fin du plan");
  });
  it("aperçu vide tant que l'année ou le prix de vente n'est pas valide", () => {
    expect(propertyHint(withProps(chalet({ salePrice: "" })), 0)).toBe("");
    expect(propertyHint(withProps(chalet({ saleYear: "abc" })), 0)).toBe("");
    expect(propertyHint(withProps(chalet({ salePrice: "-4" })), 0)).toBe("");
  });

  // ---- formulaire
  it("la section « Immeubles » : message vide, bouton d'ajout, puis un bloc par immeuble avec le compte dans le titre", () => {
    const empty = renderForm(defaultForm(), new Set(["properties"]));
    expect(empty).toContain("Aucun immeuble");
    expect(empty).toContain('data-action="add-property"');
    expect(empty).toContain("<summary>Immeubles</summary>");
    expect(empty).toContain("sans hypothèque");
    const f = withProps(chalet(), chalet({ label: "Maison" }));
    const html = renderForm(f, new Set(["properties"]));
    expect(html).toContain("<summary>Immeubles (2)</summary>");
    expect((html.match(/class="property"/g) ?? []).length).toBe(2);
    expect((html.match(/data-action="remove-property"/g) ?? []).length).toBe(2);
    for (const k of ["label", "owner", "principalResidence", "purchaseYear", "purchasePrice", "saleYear", "salePrice"]) expect(html).toContain(`data-path="properties.1.${k}"`);
  });
  it("le propriétaire se choisit parmi « les deux » et les prénoms, avec la valeur actuelle sélectionnée", () => {
    const html = renderForm(withProps(chalet({ owner: "1" })), new Set(["properties"]));
    const sel = /<select data-path="properties\.0\.owner">(.*?)<\/select>/.exec(html)![1];
    expect(sel).toContain('<option value="both">Les deux, à parts égales</option>');
    expect(sel).toContain('<option value="0" data-name-opt="0">Alex</option>');
    expect(sel).toContain('<option value="1" selected data-name-opt="1">Sam</option>');
  });
  it("la case « résidence principale » est cochée selon l'état, et change l'indication du prix d'achat", () => {
    const off = renderForm(withProps(chalet()), new Set(["properties"]));
    expect(/data-path="properties\.0\.principalResidence" data-rerender="1"( checked)?>/.exec(off)![1]).toBe(undefined);
    expect(plain(off)).toContain("Coût fiscal, en dollars de l'année d'achat");
    const on = renderForm(withProps(chalet({ principalResidence: true })), new Set(["properties"]));
    expect(/data-path="properties\.0\.principalResidence" data-rerender="1"( checked)?>/.exec(on)![1]).toBe(" checked");
    expect(plain(on)).toContain("Sans effet : gain exonéré");
  });
  it("l'aperçu est affiché dans le bloc, et un avertissement apparaît si plusieurs résidences principales sont cochées", () => {
    const one = plain(renderForm(withProps(chalet({ principalResidence: true })), new Set(["properties"])));
    expect(/data-property-hint="0"[^>]*>[^<]*exonéré/.test(one)).toBe(true);
    expect(one).not.toContain("Plusieurs résidences principales");
    const two = plain(renderForm(withProps(chalet({ principalResidence: true }), chalet({ principalResidence: true })), new Set(["properties"])));
    expect(two).toContain("Plusieurs résidences principales sont cochées");
    expect(two).toContain("une famille ne peut en désigner qu'une par année".replace("une", "Une"));
  });
  it("les valeurs saisies sont échappées", () => {
    const html = renderForm(withProps(chalet({ label: '<img src=x onerror=1>' })), new Set(["properties"]));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  // ---- changements, fichiers
  it("le suivi des changements : ajout, retrait, champs et propriétaire en clair", () => {
    const a = defaultForm();
    const b = JSON.parse(JSON.stringify(a)) as FormState;
    b.properties = [chalet()];
    expect(describeChanges(a, b)).toEqual(["Immeuble 1 ajouté"]);
    expect(describeChanges(b, a)).toEqual(["Immeuble 1 retiré"]);
    const c = JSON.parse(JSON.stringify(b)) as FormState;
    c.properties[0].salePrice = "650000"; c.properties[0].owner = "0"; c.properties[0].principalResidence = true;
    expect(describeChanges(b, c)).toEqual(["Immeuble 1 (propriétaire) : les deux → Alex", "Immeuble 1 (résidence principale) : non → oui", "Immeuble 1 (prix de vente) : 600000 → 650000"]);
  });
  it("les champs modifiés d'un immeuble sont repérés par leur chemin", () => {
    const a = withProps(chalet()), b = JSON.parse(JSON.stringify(a)) as FormState;
    b.properties[0].saleYear = "2031";
    expect([...changedPaths(a, b)]).toEqual(["properties.0.saleYear"]);
  });
  it("l'aller-retour par fichier conserve les immeubles", () => {
    const f = withProps(chalet({ owner: "1", principalResidence: true }), chalet({ label: "Maison", saleYear: "" }));
    const back = fileFromJson(fileToJson(f, null)).form;
    expect(back.properties).toEqual(f.properties);
  });
  it("un ancien fichier sans immeuble s'ouvre sans immeuble; un propriétaire invalide devient « les deux »", () => {
    const old = JSON.parse(JSON.stringify(defaultForm())); delete old.properties;
    expect(formFromJson(JSON.stringify({ form: old })).properties).toEqual([]);
    const odd = JSON.parse(JSON.stringify(withProps(chalet()))); odd.properties[0].owner = "n'importe quoi";
    expect(formFromJson(JSON.stringify({ form: odd })).properties[0].owner).toBe("both");
    const partial = JSON.parse(JSON.stringify(defaultForm())); partial.properties = [{ label: "X", salePrice: 5 }];
    const p = formFromJson(JSON.stringify({ form: partial })).properties[0];
    expect(p.salePrice).toBe("5");
    expect(p.owner).toBe("both");
    expect(p.purchaseYear).toBe("2011");
  });
});

describe("immeubles : résultats", () => {
  const sc = (...ps: PropertyForm[]) => { const f = defaultForm(); f.properties = ps; return toScenario(f).scenario!; };
  const chalet = (o: Partial<PropertyForm> = {}): PropertyForm => ({ label: "Chalet", owner: "both", principalResidence: false, purchaseYear: "2000", purchasePrice: "200000", saleYear: "2030", salePrice: "600000", ...o });
  const scenario = sc(chalet());
  const rows = runProjection(scenario, tax);
  const lines = (csv: string) => csv.trim().split("\r\n").slice(1).map((l) => l.split(";"));
  const plain = (t: string) => t.replace(/[\u00a0\u202f]/g, " ").replace(/&#39;/g, "'");

  it("CSV : le produit de la vente et le gain imposable de chaque conjoint, dans l'année de la vente seulement", () => {
    const t = parseCsv(planToCsv(scenario, rows));
    const row = (year: number, who: string) => t.rows.find((l) => t.col(l, "Année") === String(year) && t.col(l, "Conjoint") === who)!;
    expect(t.col(row(2030, "Alex"), "Vente d'immeubles")).toBe("300000");
    expect(t.col(row(2030, "Alex"), "Gain en capital imposable")).toBe("100000");
    expect(t.col(row(2030, "Sam"), "Vente d'immeubles")).toBe("300000");
    expect(t.col(row(2029, "Alex"), "Vente d'immeubles")).toBe("0");
    expect(t.col(row(2031, "Sam"), "Gain en capital imposable")).toBe("0");
    expect(Number(t.col(row(2030, "Alex"), "Revenu imposable"))).toBeGreaterThanOrEqual(100000);       // le revenu imposable comprend le gain
  });
  it("CSV : les deux colonnes sont à zéro quand il n'y a pas d'immeuble", () => {
    const none = sc();
    const t = parseCsv(planToCsv(none, runProjection(none, tax)));
    expect(t.rows.every((l) => t.col(l, "Vente d'immeubles") === "0" && t.col(l, "Gain en capital imposable") === "0")).toBe(true);
  });
  it("CSV : un immeuble à un seul propriétaire donne tout à ce conjoint", () => {
    const one = sc(chalet({ owner: "1" }));
    const t = parseCsv(planToCsv(one, runProjection(one, tax)));
    const row = (who: string) => t.rows.find((l) => t.col(l, "Année") === "2030" && t.col(l, "Conjoint") === who)!;
    expect(t.col(row("Alex"), "Vente d'immeubles")).toBe("0");
    expect(t.col(row("Sam"), "Vente d'immeubles")).toBe("600000");
    expect(t.col(row("Sam"), "Gain en capital imposable")).toBe("200000");
  });

  const heads = (html: string) => parseYearTable(html).headers;

  it("tableau annuel : sans vente, aucune colonne ajoutée", () => {
    const none = sc();
    const h = heads(yearTable(none, runProjection(none, tax), false));
    expect(h).not.toContain("Vente d'immeubles");
    expect(h).not.toContain("Gain en capital imposable");
    expect(h.length).toBe(20);
  });
  it("tableau annuel : avec une vente, deux colonnes après les retraits, avec les montants de l'année de la vente", () => {
    const { headers: h, rows: lines } = parseYearTable(yearTable(scenario, rows, false));
    expect(h.length).toBe(22);
    const i = h.indexOf("Vente d'immeubles");
    expect(i).toBe(h.indexOf("Retraits non enr.") + 1);
    expect(h[i + 1]).toBe("Gain en capital imposable");
    const at = (year: number, k: number) => lines.filter((l) => l.year === year)[k];
    // ménage, puis chaque conjoint
    expect([at(2030, 0).cells[i - 2], at(2030, 0).cells[i - 1]]).toEqual(["600 000", "200 000"]);
    expect([at(2030, 1).cells[i - 2], at(2030, 1).cells[i - 1]]).toEqual(["300 000", "100 000"]);
    expect([at(2030, 2).cells[i - 2], at(2030, 2).cells[i - 1]]).toEqual(["300 000", "100 000"]);
    expect(at(2031, 0).cells[i - 2]).toBe("0");
  });
  it("tableau annuel : un seul propriétaire reçoit tout le produit sur sa ligne, l'autre conjoint 0", () => {
    const one = sc(chalet({ owner: "1" }));
    const { headers: h, rows: lines } = parseYearTable(yearTable(one, runProjection(one, tax), false));
    const i = h.indexOf("Vente d'immeubles") - 2;
    const [parent, a, b] = lines.filter((l) => l.year === 2030);
    expect([parent.cells[i], a.cells[i], b.cells[i]]).toEqual(["600 000", "0", "600 000"]);
  });
  it("tableau annuel : en dollars constants, le produit de la vente est ramené aux dollars de départ", () => {
    const { headers: h, rows: lines } = parseYearTable(yearTable(scenario, rows, true));
    const i = h.indexOf("Vente d'immeubles") - 2;
    const f = Math.pow(1.02, 4);
    const [parent, a] = lines.filter((l) => l.year === 2030);
    expect(Math.abs(digitsOf(parent.cells[i]) - Math.round(600000 / f))).toBeLessThanOrEqual(1);
    expect(Math.abs(digitsOf(a.cells[i]) - Math.round(300000 / f))).toBeLessThanOrEqual(1);
  });
  it("graphique « D'où vient l'argent » : le produit de la vente est une source, dans l'année de la vente seulement", () => {
    const d = sourcesData(scenario, rows, false);
    const key = d.keys.find((k) => k.cls === "s-prop")!;
    expect(key.name).toBe("Vente d'immeubles");
    const k2030 = rows.findIndex((y) => y.year === 2030);
    expect(key.v(rows[k2030])).toBe(600000);
    expect(key.v(rows[k2030 + 1])).toBe(0);
    const svg = sourcesChart(scenario, rows, false);
    expect((svg.match(/class="s-prop"/g) ?? []).length).toBe(1);
    expect(sourcesChart(sc(), runProjection(sc(), tax), false)).not.toContain('class="s-prop"');
  });
  it("graphique : la conservation de l'argent tient avec une vente (colonnes + manque = ligne + surplus réinvesti)", () => {
    for (const s of [scenario, sc(chalet({ principalResidence: true })), sc(chalet({ owner: "0" }))]) {
      const r = runProjection(s, tax);
      for (const real of [false, true]) {
        const d = sourcesData(s, r, real);
        r.forEach((_, k) => expect(Math.abs(d.stacks[k] + d.shortfall[k] - d.outflow[k] - d.contributions[k])).toBeLessThan(1e-6));
      }
    }
  });
});

describe("colonnes : tableau et CSV dans le même ordre", () => {
  const sc = (spending: string, mutate?: (f: FormState) => void) => {
    const f = defaultForm(); f.spending = spending; mutate?.(f);
    const scenario = toScenario(f).scenario!;
    return { scenario, rows: runProjection(scenario, tax) };
  };
  const withSale = (spending = "100000") => sc(spending, (f) => { f.properties = [{ label: "Chalet", owner: "both", principalResidence: false, purchaseYear: "2000", purchasePrice: "200000", saleYear: "2030", salePrice: "600000" }]; });
  /** Toutes les colonnes possibles du tableau : une vente d'immeuble et une dépense supplémentaire. */
  const withAll = () => sc("100000", (f) => { f.properties = [{ label: "Chalet", owner: "both", principalResidence: false, purchaseYear: "2000", purchasePrice: "200000", saleYear: "2030", salePrice: "600000" }]; f.extraExpenses = [{ label: "Voiture", year: "2029", amount: "40000" }]; f.spouses[0].incomes = [{ label: "Salaire", amount: "60000", frequency: "annual", taxable: true, startYear: "2027", endYear: "2029", indexation: "3", year: "2027" }, { label: "Héritage", amount: "30000", frequency: "once", taxable: false, startYear: "2026", endYear: "", indexation: "2", year: "2028" }]; });
  // Correspondance entre les colonnes du tableau et celles du CSV (le CSV garde des libellés complets).
  const CSV_NAME: Record<string, string> = {
    "Année": "Année", "Âges": "Âge", "Rentes de régimes": "Rente de régime de retraite", "RRQ": "RRQ", "PSV": "PSV",
    "Retraits REER/FERR": "Retraits REER/FERR", "Retraits CELI": "Retraits CELI", "Retraits non enr.": "Retraits non enregistré",
    "Vente d'immeubles": "Vente d'immeubles", "Gain en capital imposable": "Gain en capital imposable",
    "Cotisation CELI": "Cotisation CELI", "Cotisation non enr.": "Cotisation non enregistré", "PSV récupérée": "Récupération de la PSV",
    "Pension fractionnée": "Fractionnement (reçu + / cédé −)", "Revenu imposable": "Revenu imposable", "Taux marginal": "Taux marginal (%)", "Impôt": "Impôt",
    "Revenus imposables": "Revenus imposables", "Revenus non imposables": "Revenus non imposables", "Dépenses visées": "Dépenses visées", "Dépenses supp.": "Dépenses supp.", "Manque": "Manque", "Solde REER/FERR": "Solde REER/FERR", "Solde CELI": "Solde CELI", "Solde non enr.": "Solde non enregistré",
  };

  it("tableau : l'ordre des colonnes, sans vente d'immeubles", () => {
    const { scenario, rows } = sc("100000");
    expect(parseYearTable(yearTable(scenario, rows, false)).headers).toEqual([
      "Année", "Âges", "Rentes de régimes", "RRQ", "PSV", "Retraits REER/FERR", "Retraits CELI", "Retraits non enr.", "Cotisation CELI", "Cotisation non enr.",
      "PSV récupérée", "Pension fractionnée", "Revenu imposable", "Taux marginal", "Impôt", "Dépenses visées", "Manque", "Solde REER/FERR", "Solde CELI", "Solde non enr.",
    ]);
  });
  it("tableau : avec une vente d'immeubles, ses deux colonnes s'insèrent après les retraits et avant les cotisations", () => {
    const { scenario, rows } = withSale();
    const h = parseYearTable(yearTable(scenario, rows, false)).headers;
    expect(h.length).toBe(22);
    expect(h.slice(5, 12)).toEqual(["Retraits REER/FERR", "Retraits CELI", "Retraits non enr.", "Vente d'immeubles", "Gain en capital imposable", "Cotisation CELI", "Cotisation non enr."]);
    expect(h.indexOf("Impôt")).toBe(h.indexOf("Taux marginal") + 1);          // l'impôt suit le taux marginal
  });
  it("CSV : l'ordre exact des 31 colonnes", () => {
    const { scenario, rows } = sc("100000");
    expect(parseCsv(planToCsv(scenario, rows)).headers).toEqual([
      "Année", "Conjoint", "Âge", "En vie", "Rente de régime de retraite", "RRQ", "PSV", "Retraits REER/FERR", "Retraits CELI", "Retraits non enregistré",
      "Rendement imposable non enregistré", "Vente d'immeubles", "Gain en capital imposable", "Revenus imposables", "Revenus non imposables", "Espace CELI", "Cotisation CELI", "Cotisation non enregistré", "Récupération de la PSV",
      "Fractionnement (reçu + / cédé −)", "Revenu imposable", "Taux marginal (%)", "Impôt", "Dépenses visées", "Dépenses supp.", "Part des dépenses (%)", "Manque",
      "Solde REER/FERR", "Solde CELI", "Solde non enregistré", "Indice d'inflation (départ = 1)",
    ]);
  });
  it("le CSV contient toutes les colonnes du tableau, dans le même ordre", () => {
    const { scenario, rows } = withAll();                      // avec une vente : le tableau a alors toutes ses colonnes possibles
    const ui = parseYearTable(yearTable(scenario, rows, false)).headers;
    const csv = parseCsv(planToCsv(scenario, rows)).headers;
    const positions = ui.map((h) => { expect(CSV_NAME[h]).toBeDefined(); return csv.indexOf(CSV_NAME[h]); });
    expect(positions.every((p) => p >= 0)).toBe(true);           // aucune colonne du tableau ne manque au CSV
    for (let k = 1; k < positions.length; k++) expect(positions[k]).toBeGreaterThan(positions[k - 1]);       // même ordre
  });
  it("les colonnes propres au CSV sont à côté de ce à quoi elles se rapportent", () => {
    const h = parseCsv(planToCsv(...(() => { const { scenario, rows } = sc("100000"); return [scenario, rows] as const; })())).headers;
    expect(h.indexOf("Conjoint")).toBe(h.indexOf("Année") + 1);
    expect(h.indexOf("En vie")).toBe(h.indexOf("Âge") + 1);
    expect(h.indexOf("Rendement imposable non enregistré")).toBe(h.indexOf("Retraits non enregistré") + 1);
    expect(h.indexOf("Espace CELI")).toBe(h.indexOf("Cotisation CELI") - 1);                  // l'espace disponible, juste avant la cotisation
    expect(h.indexOf("Dépenses supp.")).toBe(h.indexOf("Dépenses visées") + 1);              // demandé : juste après « Dépenses visées »
    expect(h.indexOf("Part des dépenses (%)")).toBe(h.indexOf("Dépenses supp.") + 1);
    expect(h.indexOf("Manque")).toBe(h.indexOf("Part des dépenses (%)") + 1);
    expect(h[h.length - 1]).toBe("Indice d'inflation (départ = 1)");
  });
  it("chaque ligne de conjoint du tableau a les mêmes valeurs que sa ligne du CSV, pour toutes les colonnes", () => {
    for (const { scenario, rows } of [withAll(), withSale(), sc("100000"), sc("170000")]) {
      const t = parseYearTable(yearTable(scenario, rows, false));
      const csv = parseCsv(planToCsv(scenario, rows));
      let compared = 0;
      for (const sub of t.rows.filter((r) => r.sub)) {
        if (sub.ages === "†") continue;
        const line = csv.rows.find((l) => csv.col(l, "Année") === String(sub.year) && decodeText(csv.col(l, "Conjoint")) === sub.who)!;
        expect(line).toBeDefined();
        t.headers.slice(2).forEach((h, k) => {
          const shown = sub.cells[k], inCsv = csv.col(line, CSV_NAME[h]);
          if (h === "Taux marginal") expect(shown.replace(" %", "")).toBe(inCsv);
          else expect(digitsOf(shown)).toBe(Math.round(Number(inCsv)));
          compared++;
        });
        expect(sub.ages).toBe(csv.col(line, "Âge"));
      }
      expect(compared).toBeGreaterThan(rows.length * 2 * 15);
    }
  });
  it("retraits : « Retraits CELI » et « Retraits non enr. » sont deux colonnes, avec chacune sa valeur", () => {
    const { scenario, rows } = sc("150000", (f) => { f.strategy.kind = "celi-first"; f.spouses[0].nonReg = "300000"; f.spouses[1].nonReg = "300000"; });
    const t = parseYearTable(yearTable(scenario, rows, false));
    const iC = t.headers.indexOf("Retraits CELI") - 2, iN = t.headers.indexOf("Retraits non enr.") - 2;
    const y = rows.find((r) => r.spouses[0].celiWithdrawal + r.spouses[1].celiWithdrawal > 0 && r.spouses[0].nonRegWithdrawal + r.spouses[1].nonRegWithdrawal > 0)!;
    expect(y).toBeDefined();                                      // une année avec les deux types de retraits (2029)
    expect(rows.some((r) => r.spouses[0].celiWithdrawal + r.spouses[1].celiWithdrawal > 0)).toBe(true);        // le scénario d'essai a bien les deux types de retraits
    expect(rows.some((r) => r.spouses[0].nonRegWithdrawal + r.spouses[1].nonRegWithdrawal > 0)).toBe(true);
    const parent = t.rows.find((r) => !r.sub && r.year === y.year)!;
    expect(digitsOf(parent.cells[iC])).toBe(Math.round(y.spouses[0].celiWithdrawal + y.spouses[1].celiWithdrawal));
    expect(digitsOf(parent.cells[iN])).toBe(Math.round(y.spouses[0].nonRegWithdrawal + y.spouses[1].nonRegWithdrawal));
    const subs = t.rows.filter((r) => r.sub && r.year === y.year);
    expect(subs.map((r) => digitsOf(r.cells[iC]))).toEqual(y.spouses.map((p) => Math.round(p.celiWithdrawal)));
    expect(subs.map((r) => digitsOf(r.cells[iN]))).toEqual(y.spouses.map((p) => Math.round(p.nonRegWithdrawal)));
  });
  it("sur l'ensemble du plan, les deux colonnes de retraits additionnées donnent l'ancienne colonne combinée", () => {
    const { scenario, rows } = sc("150000", (f) => { f.strategy.kind = "celi-first"; f.spouses[0].nonReg = "300000"; f.spouses[1].nonReg = "300000"; });
    const t = parseYearTable(yearTable(scenario, rows, false));
    const iC = t.headers.indexOf("Retraits CELI") - 2, iN = t.headers.indexOf("Retraits non enr.") - 2;
    let any = false;
    for (const parent of t.rows.filter((r) => !r.sub)) {
      const y = rows.find((r) => r.year === parent.year)!;
      const combined = y.spouses[0].celiWithdrawal + y.spouses[0].nonRegWithdrawal + y.spouses[1].celiWithdrawal + y.spouses[1].nonRegWithdrawal;
      expect(Math.abs(digitsOf(parent.cells[iC]) + digitsOf(parent.cells[iN]) - combined)).toBeLessThanOrEqual(1);
      if (combined > 0) any = true;
    }
    expect(any).toBe(true);
  });
  it("cotisations : « Cotisation CELI » et « Cotisation non enr. » donnent l'argent placé, par conjoint et pour le ménage", () => {
    const { scenario, rows } = withSale();
    const t = parseYearTable(yearTable(scenario, rows, false));
    const iC = t.headers.indexOf("Cotisation CELI") - 2, iN = t.headers.indexOf("Cotisation non enr.") - 2;
    const y = rows.find((r) => r.year === 2030)!;
    const [parent, a, b] = t.rows.filter((r) => r.year === 2030);
    expect(digitsOf(parent.cells[iC])).toBe(Math.round(y.spouses[0].celiContribution + y.spouses[1].celiContribution));
    expect(digitsOf(parent.cells[iN])).toBe(Math.round(y.spouses[0].nonRegContribution + y.spouses[1].nonRegContribution));
    expect(digitsOf(a.cells[iC])).toBe(Math.round(y.spouses[0].celiContribution));
    expect(digitsOf(b.cells[iN])).toBe(Math.round(y.spouses[1].nonRegContribution));
    expect(digitsOf(parent.cells[iC])).toBeGreaterThan(0);
    expect(digitsOf(parent.cells[iN])).toBeGreaterThan(0);
    const other = t.rows.find((r) => !r.sub && r.year === 2029)!;
    expect(digitsOf(other.cells[iC]) + digitsOf(other.cells[iN])).toBe(0);
  });

  // ---- manque par conjoint
  it("le manque de chaque conjoint est sa part du manque du ménage, selon sa part des dépenses", () => {
    const { scenario, rows } = sc("170000", (f) => { f.spouses[0].expenseShare = "70"; });
    const late = rows.filter((y) => y.shortfall > 1);
    expect(late.length).toBeGreaterThan(5);
    for (const y of late) {
      expect(y.spouses[0].shortfall).toBeCloseTo(0.7 * y.shortfall, 6);
      expect(y.spouses[1].shortfall).toBeCloseTo(0.3 * y.shortfall, 6);
      expect(y.spouses[0].shortfall + y.spouses[1].shortfall).toBeCloseTo(y.shortfall, 6);
    }
    expect(rows.filter((y) => y.shortfall < 1).every((y) => y.spouses[0].shortfall + y.spouses[1].shortfall < 1e-9)).toBe(true);
    expect(scenario.firstSpouseSpendingShare).toBeCloseTo(0.7, 10);
  });
  it("manque dans le tableau : le ménage affiche le total, chaque conjoint sa part, et les lignes s'additionnent", () => {
    const { scenario, rows } = sc("170000", (f) => { f.spouses[0].expenseShare = "70"; });
    const t = parseYearTable(yearTable(scenario, rows, false));
    const i = t.headers.indexOf("Manque") - 2;
    const y = rows[rows.length - 1];
    expect(y.shortfall).toBeGreaterThan(1000);
    const [parent, a, b] = t.rows.filter((r) => r.year === y.year);
    expect(digitsOf(parent.cells[i])).toBe(Math.round(y.shortfall));
    expect(digitsOf(a.cells[i])).toBe(Math.round(0.7 * y.shortfall));
    expect(digitsOf(b.cells[i])).toBe(Math.round(0.3 * y.shortfall));
    expect(Math.abs(digitsOf(a.cells[i]) + digitsOf(b.cells[i]) - digitsOf(parent.cells[i]))).toBeLessThanOrEqual(1);
    expect(parent.short).toBe(true);
  });
  it("manque dans le CSV : même valeur que dans le tableau, répartie selon la part des dépenses, et 0 sans manque", () => {
    const { scenario, rows } = sc("170000", (f) => { f.spouses[0].expenseShare = "70"; });
    const t = parseCsv(planToCsv(scenario, rows));
    const last = rows[rows.length - 1];
    const [a, b] = t.rows.filter((l) => t.col(l, "Année") === String(last.year));
    expect(t.col(a, "Manque")).toBe(String(Math.round(0.7 * last.shortfall)));
    expect(t.col(b, "Manque")).toBe(String(Math.round(0.3 * last.shortfall)));
    expect(Math.abs(Number(t.col(a, "Manque")) + Number(t.col(b, "Manque")) - Math.round(last.shortfall))).toBeLessThanOrEqual(1);
    const first = t.rows.filter((l) => t.col(l, "Année") === String(rows[0].year));
    expect(first.map((l) => t.col(l, "Manque"))).toEqual(["0", "0"]);
  });
  it("après un décès, tout le manque revient au survivant", () => {
    const { rows } = sc("150000", (f) => { f.spouses[0].deathAge = "80"; f.spouses[0].expenseShare = "70"; });
    const y = rows.find((r) => r.year > 2040 && r.shortfall > 1)!;
    expect(y).toBeDefined();
    expect(y.spouses[0].shortfall).toBe(0);
    expect(y.spouses[1].shortfall).toBeCloseTo(y.shortfall, 6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("dépenses supplémentaires : formulaire et scénario", () => {
  const voiture = (o: Partial<ExtraExpenseForm> = {}): ExtraExpenseForm => ({ label: "Voiture", year: "2030", amount: "40000", ...o });
  const withExtras = (...es: ExtraExpenseForm[]): FormState => { const f = defaultForm(); f.extraExpenses = es; return f; };
  const errorsOf = (f: FormState) => toScenario(f).errors;
  const plain = (t: string) => t.replace(/[\u00a0\u202f]/g, " ").replace(/&#39;/g, "'");

  it("par défaut : aucune dépense supplémentaire, et le scénario n'a pas de champ « extraExpenses »", () => {
    const f = defaultForm();
    expect(f.extraExpenses).toEqual([]);
    expect("extraExpenses" in toScenario(f).scenario!).toBe(false);
  });
  it("une nouvelle dépense : cinq ans après le début du plan, montant nul, valide et sans effet sur le plan", () => {
    expect(newExtraExpense("2026")).toEqual({ label: "", year: "2031", amount: "0" });
    expect(newExtraExpense("abc").year).toBe("2031");
    const r = toScenario(withExtras(newExtraExpense()));
    expect(r.errors).toEqual([]);
    expect(r.scenario!.extraExpenses).toEqual([{ label: "Dépense 1", year: 2031, amount: 0 }]);
    expect(JSON.stringify(runProjection(r.scenario!, tax))).toBe(JSON.stringify(runProjection(toScenario(defaultForm()).scenario!, tax)));
  });
  it("convertit la saisie : nombres avec espaces et virgule, nom nettoyé, nom par défaut", () => {
    const p = toScenario(withExtras(voiture({ amount: "40 000,50", label: "  Voiture  " }), voiture({ label: "" }))).scenario!.extraExpenses!;
    expect(p[0]).toEqual({ label: "Voiture", year: 2030, amount: 40000.5 });
    expect(p[1].label).toBe("Dépense 2");
  });
  it("l'année doit être à partir du début du plan", () => {
    const e = errorsOf(withExtras(voiture({ year: "2025" })));
    expect(e).toEqual(["Dépense supplémentaire 1 (Voiture) : année 2025 : elle doit être à partir du début du plan (2026)."]);
    expect(errorsOf(withExtras(voiture({ year: "2026" })))).toEqual([]);
  });
  it("refuse un montant ou une année invalide, en nommant la dépense", () => {
    expect(errorsOf(withExtras(voiture({ amount: "" })))).toEqual(["Dépense supplémentaire 1 (Voiture) : montant : entrez une valeur."]);
    expect(errorsOf(withExtras(voiture({ amount: "abc" }))).some((x) => x.includes("montant") && x.includes("n'est pas un nombre"))).toBe(true);
    expect(errorsOf(withExtras(voiture({ amount: "-5" }))).some((x) => x.includes("montant"))).toBe(true);
    expect(errorsOf(withExtras(voiture({ year: "2030,5" }))).some((x) => x.includes("année : entrez un nombre entier"))).toBe(true);
    expect(errorsOf(withExtras(voiture({ year: "" }))).some((x) => x.includes("année"))).toBe(true);
    expect(errorsOf(withExtras(voiture(), voiture({ label: "", amount: "" })))).toEqual(["Dépense supplémentaire 2 : montant : entrez une valeur."]);
  });

  // ---- aperçu
  it("aperçu : le montant en dollars courants de l'année, après impôt", () => {
    const t = plain(extraExpenseHint(withExtras(voiture()), 0));
    expect(t).toBe(`Soit ${plain(fmtMoney(40000 * Math.pow(1.02, 4)))} en dollars courants de 2030, après impôt.`);
  });
  it("aperçu : montant nul sans effet; avertissement après la fin du plan; vide si invalide", () => {
    expect(extraExpenseHint(withExtras(voiture({ amount: "0" })), 0)).toContain("n'a aucun effet");
    expect(plain(extraExpenseHint(withExtras(voiture({ year: "2060" })), 0))).toContain("après la fin du plan (2057)");
    expect(plain(extraExpenseHint(withExtras(voiture({ year: "2057" })), 0))).not.toContain("après la fin du plan");
    for (const bad of [{ amount: "" }, { amount: "abc" }, { amount: "-3" }, { year: "" }, { year: "2020" }, { year: "2030,5" }]) expect(extraExpenseHint(withExtras(voiture(bad)), 0)).toBe("");
    expect(extraExpenseHint(withExtras(), 4)).toBe("");
  });

  // ---- formulaire
  it("la section : message vide, bouton d'ajout, puis un bloc par dépense avec le compte dans le titre", () => {
    const empty = renderForm(defaultForm(), new Set(["extras"]));
    expect(empty).toContain("<summary>Dépenses supplémentaires</summary>");
    expect(empty).toContain("Aucune dépense supplémentaire");
    expect(empty).toContain('data-action="add-extra"');
    expect(plain(empty)).toContain("le revenu requis de cette année-là est la somme des deux");
    const html = renderForm(withExtras(voiture(), voiture({ label: "Toit" })), new Set(["extras"]));
    expect(html).toContain("<summary>Dépenses supplémentaires (2)</summary>");
    expect((html.match(/class="extra"/g) ?? []).length).toBe(2);
    expect((html.match(/data-action="remove-extra"/g) ?? []).length).toBe(2);
    for (const k of ["label", "year", "amount"]) expect(html).toContain(`data-path="extraExpenses.1.${k}"`);
    expect(plain(html)).toContain("Après impôt, en dollars de 2026");
    expect(/data-extra-hint="0"[^>]*>Soit /.test(plain(html))).toBe(true);
  });
  it("la section est placée après les immeubles et avant la stratégie, et les valeurs sont échappées", () => {
    const html = renderForm(withExtras(voiture({ label: "<img src=x onerror=1>" })), new Set(["extras"]));
    expect(html.indexOf('data-sec="properties"')).toBeLessThan(html.indexOf('data-sec="extras"'));
    expect(html.indexOf('data-sec="extras"')).toBeLessThan(html.indexOf('data-sec="strategy"'));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  // ---- changements, fichiers
  it("le suivi des changements : ajout, retrait et champs, avec le numéro de la dépense", () => {
    const a = defaultForm(), b = JSON.parse(JSON.stringify(a)) as FormState;
    b.extraExpenses = [voiture()];
    expect(describeChanges(a, b)).toEqual(["Dépense supplémentaire 1 ajoutée"]);
    expect(describeChanges(b, a)).toEqual(["Dépense supplémentaire 1 retirée"]);
    const c = JSON.parse(JSON.stringify(b)) as FormState;
    c.extraExpenses[0].amount = "45000"; c.extraExpenses[0].year = "2031"; c.extraExpenses[0].label = "Auto";
    expect(describeChanges(b, c)).toEqual(["Dépense supplémentaire 1 (nom) : Voiture → Auto", "Dépense supplémentaire 1 (année) : 2030 → 2031", "Dépense supplémentaire 1 (montant) : 40000 → 45000"]);
    expect([...changedPaths(b, c)].sort()).toEqual(["extraExpenses.0.amount", "extraExpenses.0.label", "extraExpenses.0.year"]);
  });
  it("l'aller-retour par fichier conserve les dépenses; un ancien fichier s'ouvre sans dépense; les champs manquants reprennent leur défaut", () => {
    const f = withExtras(voiture(), voiture({ label: "Toit", year: "2033", amount: "25000" }));
    expect(fileFromJson(fileToJson(f, null)).form.extraExpenses).toEqual(f.extraExpenses);
    const old = JSON.parse(JSON.stringify(defaultForm())); delete old.extraExpenses;
    expect(formFromJson(JSON.stringify({ form: old })).extraExpenses).toEqual([]);
    const partial = JSON.parse(JSON.stringify(defaultForm())); partial.extraExpenses = [{ label: "X", amount: 5 }];
    const e = formFromJson(JSON.stringify({ form: partial })).extraExpenses[0];
    expect(e).toEqual({ label: "X", year: "2031", amount: "5" });
  });
});

describe("dépenses supplémentaires : résultats", () => {
  const fx = (year: string, amount: string, label = "Voiture"): ExtraExpenseForm => ({ label, year, amount });
  const sc = (extras: ExtraExpenseForm[], mutate?: (f: FormState) => void) => {
    const f = defaultForm(); f.extraExpenses = extras; mutate?.(f);
    const scenario = toScenario(f).scenario!;
    return { scenario, rows: runProjection(scenario, tax) };
  };
  const plain = (t: string) => t.replace(/[\u00a0\u202f]/g, " ").replace(/&#39;/g, "'");

  it("CSV : « Dépenses supp. » juste après « Dépenses visées », avec la part de chaque conjoint", () => {
    const { scenario, rows } = sc([fx("2030", "40000")], (f) => { f.spouses[0].expenseShare = "70"; });
    const t = parseCsv(planToCsv(scenario, rows));
    expect(t.headers.indexOf("Dépenses supp.")).toBe(t.headers.indexOf("Dépenses visées") + 1);
    const [a, b] = t.rows.filter((l) => t.col(l, "Année") === "2030");
    const nominal = 40000 * Math.pow(1.02, 4);
    expect(t.col(a, "Dépenses supp.")).toBe(String(Math.round(0.7 * nominal)));
    expect(t.col(b, "Dépenses supp.")).toBe(String(Math.round(0.3 * nominal)));
    expect(Math.abs(Number(t.col(a, "Dépenses supp.")) + Number(t.col(b, "Dépenses supp.")) - Math.round(nominal))).toBeLessThanOrEqual(1);
    const autre = t.rows.filter((l) => t.col(l, "Année") === "2031");
    expect(autre.every((l) => t.col(l, "Dépenses supp.") === "0")).toBe(true);
  });
  it("CSV : la colonne existe toujours, à zéro sans dépense supplémentaire", () => {
    const { scenario, rows } = sc([]);
    const t = parseCsv(planToCsv(scenario, rows));
    expect(t.headers).toContain("Dépenses supp.");
    expect(t.rows.every((l) => t.col(l, "Dépenses supp.") === "0")).toBe(true);
  });
  it("tableau : sans dépense supplémentaire, aucune colonne ajoutée", () => {
    const { scenario, rows } = sc([]);
    const h = parseYearTable(yearTable(scenario, rows, false)).headers;
    expect(h).not.toContain("Dépenses supp.");
    expect(h.length).toBe(20);
  });
  it("tableau : avec une dépense, la colonne s'insère entre « Dépenses visées » et « Manque »", () => {
    const { scenario, rows } = sc([fx("2030", "40000")]);
    const t = parseYearTable(yearTable(scenario, rows, false));
    expect(t.headers.length).toBe(21);
    expect(t.headers.slice(t.headers.indexOf("Dépenses visées"), t.headers.indexOf("Dépenses visées") + 3)).toEqual(["Dépenses visées", "Dépenses supp.", "Manque"]);
    const i = t.headers.indexOf("Dépenses supp.") - 2;
    const [parent, a, b] = t.rows.filter((r) => r.year === 2030);
    const nominal = Math.round(40000 * Math.pow(1.02, 4));
    expect(digitsOf(parent.cells[i])).toBe(nominal);
    expect(Math.abs(digitsOf(a.cells[i]) + digitsOf(b.cells[i]) - nominal)).toBeLessThanOrEqual(1);
    expect(digitsOf(t.rows.find((r) => !r.sub && r.year === 2031)!.cells[i])).toBe(0);
  });
  it("tableau : en dollars constants, la dépense apparaît à son montant saisi (en dollars de départ)", () => {
    const { scenario, rows } = sc([fx("2030", "40000")]);
    const t = parseYearTable(yearTable(scenario, rows, true));
    const i = t.headers.indexOf("Dépenses supp.") - 2;
    expect(Math.abs(digitsOf(t.rows.find((r) => !r.sub && r.year === 2030)!.cells[i]) - 40000)).toBeLessThanOrEqual(1);
  });
  it("tableau et CSV : les lignes de conjoint concordent avec la dépense supplémentaire, et le décès n'en réduit pas le montant", () => {
    const { scenario, rows } = sc([fx("2040", "30000")], (f) => { f.spouses[0].deathAge = "75"; });
    const t = parseYearTable(yearTable(scenario, rows, false)), csv = parseCsv(planToCsv(scenario, rows));
    const i = t.headers.indexOf("Dépenses supp.") - 2;
    const nominal = Math.round(30000 * Math.pow(1.02, 14));
    const [parent, dead, live] = t.rows.filter((r) => r.year === 2040);
    expect(dead.cells[i]).toBe("—");
    expect(digitsOf(live.cells[i])).toBe(nominal);
    expect(digitsOf(parent.cells[i])).toBe(nominal);
    const lines = csv.rows.filter((l) => csv.col(l, "Année") === "2040");
    expect(csv.col(lines[0], "Dépenses supp.")).toBe("0");
    expect(csv.col(lines[1], "Dépenses supp.")).toBe(String(nominal));
  });
  it("tableau avec ventes d'immeubles et dépenses : toutes les colonnes possibles, dans l'ordre", () => {
    const { scenario, rows } = sc([fx("2030", "40000")], (f) => { f.properties = [{ label: "Chalet", owner: "both", principalResidence: false, purchaseYear: "2000", purchasePrice: "200000", saleYear: "2030", salePrice: "600000" }]; });
    const h = parseYearTable(yearTable(scenario, rows, false)).headers;
    expect(h.length).toBe(23);
    expect(h.slice(h.indexOf("Impôt"))).toEqual(["Impôt", "Dépenses visées", "Dépenses supp.", "Manque", "Solde REER/FERR", "Solde CELI", "Solde non enr."]);
  });
  it("graphique : la ligne des dépenses inclut les dépenses supplémentaires, et l'argent est conservé", () => {
    const { scenario, rows } = sc([fx("2030", "40000"), fx("2036", "25000", "Toit")]);
    const withoutExtra = sourcesData(sc([]).scenario, sc([]).rows, false);
    const d = sourcesData(scenario, rows, false);
    const k = rows.findIndex((y) => y.year === 2030);
    expect(d.outflow[k] - withoutExtra.outflow[k]).toBeGreaterThan(40000);                         // la dépense (indexée) et l'impôt qu'elle fait payer
    rows.forEach((_, j) => expect(Math.abs(d.stacks[j] + d.shortfall[j] - d.outflow[j] - d.contributions[j])).toBeLessThan(1e-6));
    for (const real of [false, true]) {
      const dd = sourcesData(scenario, rows, real);
      rows.forEach((_, j) => expect(Math.abs(dd.stacks[j] + dd.shortfall[j] - dd.outflow[j] - dd.contributions[j])).toBeLessThan(1e-6));
    }
  });
  it("graphique : le texte accessible et l'info-bulle parlent des dépenses, et un manque dû à une dépense est signalé", () => {
    const { scenario, rows } = sc([fx("2030", "900000")]);
    const svg = plain(sourcesChart(scenario, rows, false));
    expect(svg).toContain("comparés aux dépenses (visées et supplémentaires) et à l'impôt");
    expect(svg).toContain("dépenses + impôt");
    expect(svg).toContain("MANQUE");
    expect(svg).toContain("les dépenses visées ne sont pas toutes financées à partir de 2030");
  });
  it("un plan qui finance tout sans dépense peut manquer avec une dépense trop élevée, et le manque est celui du ménage", () => {
    const { rows } = sc([fx("2030", "900000")]);
    const y = rows.find((r) => r.year === 2030)!;
    expect(y.shortfall).toBeGreaterThan(100000);
    expect(y.netIncome).toBeCloseTo(y.targetSpending + y.extraSpending - y.shortfall, 6);
    expect(sc([]).rows.every((r) => r.shortfall < 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("espace CELI : colonne du CSV seulement", () => {
  const sc = (mutate?: (f: FormState) => void) => {
    const f = defaultForm(); mutate?.(f);
    const scenario = toScenario(f).scenario!;
    return { scenario, rows: runProjection(scenario, tax) };
  };
  const withSale = (f: FormState) => { f.properties = [{ label: "Chalet", owner: "both", principalResidence: false, purchaseYear: "2000", purchasePrice: "200000", saleYear: "2030", salePrice: "600000" }]; };
  const limit = (n: number) => Math.round((7000 * Math.pow(1.02, n)) / 500) * 500;

  it("« Espace CELI » est dans le CSV, juste avant « Cotisation CELI » (l'espace, puis la cotisation qui l'utilise)", () => {
    const { scenario, rows } = sc();
    const h = parseCsv(planToCsv(scenario, rows)).headers;
    expect(h.indexOf("Cotisation CELI")).toBe(h.indexOf("Espace CELI") + 1);
    expect(h.indexOf("Espace CELI")).toBe(h.indexOf("Revenus non imposables") + 1);              // après les revenus, collé à la cotisation
    expect(h.length).toBe(31);
  });
  it("il n'est pas dans le tableau du Détail annuel, même avec toutes les colonnes possibles", () => {
    const { scenario, rows } = sc((f) => { withSale(f); f.extraExpenses = [{ label: "Voiture", year: "2029", amount: "40000" }]; });
    const headers = parseYearTable(yearTable(scenario, rows, false)).headers;
    expect(headers.length).toBe(23);
    expect(headers.some((x) => /espace/i.test(x))).toBe(false);
    expect(parseCsv(planToCsv(scenario, rows)).headers).toContain("Espace CELI");
  });
  it("la première année : les droits de cotisation saisis pour chaque conjoint; ensuite le plafond annuel s'ajoute", () => {
    const { scenario, rows } = sc((f) => { f.spouses[1].celiRoom = "12345"; });
    const t = parseCsv(planToCsv(scenario, rows));
    const row = (year: number, who: string) => t.rows.find((l) => t.col(l, "Année") === String(year) && t.col(l, "Conjoint") === who)!;
    expect(t.col(row(2026, "Alex"), "Espace CELI")).toBe("40000");
    expect(t.col(row(2026, "Sam"), "Espace CELI")).toBe("12345");
    expect(t.col(row(2027, "Alex"), "Espace CELI")).toBe(String(40000 + limit(1)));        // 47 000 $ : sans cotisation ni retrait en 2026
    expect(t.col(row(2027, "Sam"), "Espace CELI")).toBe(String(12345 + limit(1)));
  });
  it("les valeurs du CSV sont celles du moteur, arrondies, pour chaque conjoint et chaque année", () => {
    const { scenario, rows } = sc(withSale);
    const t = parseCsv(planToCsv(scenario, rows));
    rows.forEach((y) => y.spouses.forEach((p, i) => {
      const line = t.rows.find((l) => t.col(l, "Année") === String(y.year) && t.col(l, "Conjoint") === scenario.spouses[i].name)!;
      expect(t.col(line, "Espace CELI")).toBe(String(Math.round(p.celiRoom)));
    }));
  });
  it("la cotisation ne dépasse jamais l'espace, et l'espace de l'année suivante en tient compte (valeurs du CSV)", () => {
    const { scenario, rows } = sc(withSale);
    const t = parseCsv(planToCsv(scenario, rows));
    let contributions = 0, chained = 0;
    for (const who of ["Alex", "Sam"]) {
      const lines = t.rows.filter((l) => t.col(l, "Conjoint") === who);
      lines.forEach((l, k) => {
        const room = Number(t.col(l, "Espace CELI")), contribution = Number(t.col(l, "Cotisation CELI"));
        expect(contribution).toBeLessThanOrEqual(room + 1);
        if (contribution > 0) contributions++;
        if (k > 0) {
          const prev = lines[k - 1];
          if (t.col(prev, "En vie") === "oui" && t.col(l, "En vie") === "oui") {
            const expected = Number(t.col(prev, "Espace CELI")) - Number(t.col(prev, "Cotisation CELI")) + limit(k) + Number(t.col(prev, "Retraits CELI"));
            expect(Math.abs(Number(t.col(l, "Espace CELI")) - expected)).toBeLessThanOrEqual(2);        // arrondis
            chained++;
          }
        }
      });
    }
    expect(contributions).toBeGreaterThan(5);                // la vente de l'immeuble donne lieu à de grosses cotisations
    expect(chained).toBeGreaterThan(50);
  });
  it("après un décès, l'espace du défunt est 0 dans le CSV", () => {
    const { scenario, rows } = sc((f) => { f.spouses[0].deathAge = "75"; });
    const t = parseCsv(planToCsv(scenario, rows));
    const apres = t.rows.filter((l) => t.col(l, "Conjoint") === "Alex" && Number(t.col(l, "Année")) > 2035);
    expect(apres.length).toBeGreaterThan(10);
    expect(apres.every((l) => t.col(l, "En vie") === "non" && t.col(l, "Espace CELI") === "0")).toBe(true);
  });
  it("sans droits au départ ni plafond, l'espace est 0 partout", () => {
    const { scenario, rows } = sc((f) => { f.spouses[0].celiRoom = "0"; f.spouses[1].celiRoom = "0"; f.assumptions.celiAnnualLimit = "0"; });
    const t = parseCsv(planToCsv(scenario, rows));
    expect(t.rows.every((l) => t.col(l, "Espace CELI") === "0")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("revenus des conjoints : formulaire et scénario", () => {
  const inc = (o: Partial<IncomeForm> = {}): IncomeForm => ({ label: "Salaire", amount: "60000", frequency: "annual", taxable: true, startYear: "2027", endYear: "2029", indexation: "3", year: "2027", ...o });
  const lump = (o: Partial<IncomeForm> = {}): IncomeForm => inc({ label: "Héritage", amount: "300000", frequency: "once", taxable: false, year: "2028", ...o });
  const withIncomes = (a: IncomeForm[], b: IncomeForm[] = []): FormState => { const f = defaultForm(); f.spouses[0].incomes = a; f.spouses[1].incomes = b; return f; };
  const errorsOf = (f: FormState) => toScenario(f).errors;
  const plain = (t: string) => t.replace(/[\u00a0\u202f]/g, " ").replace(/&#39;/g, "'");

  it("par défaut : aucun revenu, et les conjoints du scénario n'ont pas de champ « otherIncomes »", () => {
    const f = defaultForm();
    expect(f.spouses.map((s) => s.incomes)).toEqual([[], []]);
    expect(toScenario(f).scenario!.spouses.some((s) => "otherIncomes" in s)).toBe(false);
  });
  it("un nouveau revenu : annuel, imposable, dès le début du plan, indexé de 2 %, de montant nul — valide et sans effet", () => {
    expect(newIncome("2026")).toEqual({ label: "", amount: "0", frequency: "annual", taxable: true, startYear: "2026", endYear: "", indexation: "2", year: "2026" });
    expect(newIncome("2030").startYear).toBe("2030");
    expect(newIncome("").startYear).toBe("2026");
    const r = toScenario(withIncomes([newIncome()]));
    expect(r.errors).toEqual([]);
    expect(JSON.stringify(runProjection(r.scenario!, tax))).toBe(JSON.stringify(runProjection(toScenario(defaultForm()).scenario!, tax)));
  });
  it("convertit un revenu annuel et un revenu ponctuel, chacun chez le bon conjoint", () => {
    const sc = toScenario(withIncomes([inc(), lump({ label: "" })], [inc({ label: "  Location  ", amount: "12 000,50", endYear: "", taxable: false, indexation: "-5" })])).scenario!;
    expect(sc.spouses[0].otherIncomes).toEqual([
      { label: "Salaire", amount: 60000, taxable: true, frequency: "annual", startYear: 2027, endYear: 2029, indexation: 0.03 },
      { label: "Revenu 2", amount: 300000, taxable: false, frequency: "once", year: 2028 },
    ]);
    expect(sc.spouses[1].otherIncomes).toEqual([{ label: "Location", amount: 12000.5, taxable: false, frequency: "annual", startYear: 2027, indexation: -0.05 }]);       // fin vide : pas d'année de fin
    expect("endYear" in sc.spouses[1].otherIncomes![0]).toBe(false);
  });
  it("un revenu annuel qui commence avant le début du plan est refusé, avec l'explication", () => {
    expect(errorsOf(withIncomes([inc({ startYear: "2025" })]))).toEqual(["Alex : revenu 1 (Salaire), année de début 2025 : elle doit être à partir du début du plan (2026). Pour un revenu déjà en cours, entrez l'année de départ du plan et le montant actuel."]);
    expect(errorsOf(withIncomes([inc({ startYear: "2026" })]))).toEqual([]);
  });
  it("un revenu ponctuel doit avoir lieu à partir du début du plan", () => {
    expect(errorsOf(withIncomes([lump({ year: "2020" })])).some((x) => x.includes("Alex : revenu 1 (Héritage), année 2020 : elle doit être à partir du début du plan (2026)"))).toBe(true);
    expect(errorsOf(withIncomes([lump({ year: "2026" })]))).toEqual([]);
  });
  it("l'année de fin doit être au moins l'année de début; vide, elle vaut la fin du plan", () => {
    expect(errorsOf(withIncomes([inc({ endYear: "2026" })]))).toEqual(["Alex : revenu 1 (Salaire), année de fin 2026 : elle doit être au moins l'année de début (2027)."]);
    expect(errorsOf(withIncomes([inc({ endYear: "2027" })]))).toEqual([]);
    expect(errorsOf(withIncomes([inc({ endYear: "" })]))).toEqual([]);
  });
  it("refuse un montant manquant ou négatif, une indexation hors de −20 % à 20 %, des années non entières — en nommant le conjoint et le revenu", () => {
    expect(errorsOf(withIncomes([inc({ amount: "" })]))).toEqual(["Alex : revenu 1 (Salaire), montant : entrez une valeur."]);
    expect(errorsOf(withIncomes([inc({ amount: "-5" })])).some((x) => x.includes("montant"))).toBe(true);
    expect(errorsOf(withIncomes([inc({ indexation: "25" })])).some((x) => x.includes("indexation"))).toBe(true);
    expect(errorsOf(withIncomes([inc({ indexation: "-25" })])).some((x) => x.includes("indexation"))).toBe(true);
    expect(errorsOf(withIncomes([inc({ indexation: "-20" })]))).toEqual([]);
    expect(errorsOf(withIncomes([inc({ startYear: "2027,5" })])).some((x) => x.includes("année de début : entrez un nombre entier"))).toBe(true);
    expect(errorsOf(withIncomes([], [inc({ label: "", amount: "" })]))).toEqual(["Sam : revenu 1, montant : entrez une valeur."]);
  });
  it("seuls les champs de la fréquence choisie sont vérifiés", () => {
    expect(errorsOf(withIncomes([lump({ startYear: "abc", endYear: "xyz", indexation: "nul" })]))).toEqual([]);
    expect(errorsOf(withIncomes([inc({ year: "abc" })]))).toEqual([]);
  });

  // ---- aperçu
  it("aperçu d'un revenu annuel : premier et dernier montants, total dans le plan et nature fiscale", () => {
    const t = plain(incomeHint(withIncomes([inc()]), 0, 0));
    expect(t).toBe(`${plain(fmtMoney(60000))} en 2027, ${plain(fmtMoney(63654))} en 2029; ${plain(fmtMoney(185454))} au total dans le plan; imposable, comme un salaire (non fractionnable).`);
  });
  it("aperçu sans année de fin : jusqu'à la fin du plan (2057); revenu non imposable", () => {
    let total = 0; for (let y = 2027; y <= 2057; y++) total += 12000 * Math.pow(1.02, y - 2027);
    const t = plain(incomeHint(withIncomes([inc({ amount: "12000", endYear: "", indexation: "2", taxable: false })]), 0, 0));
    expect(t).toContain(`${plain(fmtMoney(12000))} en 2027, ${plain(fmtMoney(12000 * Math.pow(1.02, 30)))} en 2057`);
    expect(t).toContain(`${plain(fmtMoney(total))} au total dans le plan; non imposable.`);
  });
  it("aperçu d'un revenu ponctuel : montant en dollars de son année", () => {
    expect(plain(incomeHint(withIncomes([lump()]), 0, 0))).toBe(`Reçu en 2028 : ${plain(fmtMoney(300000))} (dollars de 2028), non imposable.`);
    expect(plain(incomeHint(withIncomes([lump({ taxable: true })]), 0, 0))).toContain("imposable, comme un salaire (non fractionnable)");
  });
  it("aperçu : montant nul sans effet; avertissements après la fin du plan ou après le décès prévu; vide si invalide", () => {
    expect(incomeHint(withIncomes([inc({ amount: "0" })]), 0, 0)).toContain("n'a aucun effet");
    expect(incomeHint(withIncomes([lump({ amount: "0" })]), 0, 0)).toContain("n'a aucun effet");
    expect(plain(incomeHint(withIncomes([lump({ year: "2060" })]), 0, 0))).toContain("après la fin du plan (2057)");
    expect(plain(incomeHint(withIncomes([inc({ startYear: "2060", endYear: "" })]), 0, 0))).toContain("commence après la fin du plan (2057)");
    const f = withIncomes([lump({ year: "2031" }), inc({ startYear: "2031", endYear: "" }), inc({ startYear: "2027", endYear: "2040" })]);
    f.spouses[0].deathAge = "70";                                    // né en 1960 : décès fin 2030
    expect(plain(incomeHint(f, 0, 0))).toContain("après le décès prévu (2030)");
    expect(plain(incomeHint(f, 0, 1))).toContain("commence après le décès prévu (2030)");
    expect(plain(incomeHint(f, 0, 2))).toContain("Arrêté au décès prévu (2030)");
    for (const bad of [{ amount: "" }, { amount: "abc" }, { amount: "-3" }, { startYear: "" }, { startYear: "2020" }, { endYear: "2020" }, { indexation: "x" }]) expect(incomeHint(withIncomes([inc(bad)]), 0, 0)).toBe("");
    expect(incomeHint(withIncomes([lump({ year: "" })]), 0, 0)).toBe("");
    expect(incomeHint(withIncomes([]), 0, 3)).toBe("");
  });

  // ---- formulaire
  it("chaque conjoint a une section « Revenus » avec son message vide et son bouton d'ajout", () => {
    const html = renderForm(defaultForm(), new Set(["spouse0", "spouse1"]));
    expect((html.match(/<legend>Revenus<\/legend>/g) ?? []).length).toBe(2);
    expect((html.match(/Aucun revenu : ajoutez un salaire/g) ?? []).length).toBe(2);
    expect(html).toContain('data-action="add-income" data-spouse="0"');
    expect(html).toContain('data-action="add-income" data-spouse="1"');
    expect(html.indexOf("Rentes de régimes à prestations déterminées")).toBeLessThan(html.indexOf("<legend>Revenus</legend>"));       // après les rentes de régime
    expect(plain(html)).toContain("Un revenu cesse au décès de ce conjoint");
  });
  it("revenu annuel : fréquence, montant, case imposable, début, fin et indexation; pas d'année ponctuelle", () => {
    const html = renderForm(withIncomes([inc()]), new Set(["spouse0"]));
    for (const k of ["label", "frequency", "amount", "taxable", "startYear", "endYear", "indexation"]) expect(html).toContain(`data-path="spouses.0.incomes.0.${k}"`);
    expect(html).not.toContain('data-path="spouses.0.incomes.0.year"');
    expect(html).toContain('<option value="annual" selected>Annuel</option><option value="once">Ponctuel</option>');
    expect(plain(html)).toContain("Montant de l'année de début");
    expect(/data-path="spouses\.0\.incomes\.0\.taxable" checked>/.test(html)).toBe(true);
    expect(html).toContain('data-action="remove-income" data-spouse="0" data-index="0"');
    expect(/data-income-hint="0\.0"[^>]*>[^<]*imposable/.test(plain(html))).toBe(true);
  });
  it("revenu ponctuel : seulement l'année; case imposable décochée selon l'état; le changement de fréquence réaffiche le formulaire", () => {
    const html = renderForm(withIncomes([], [lump()]), new Set(["spouse1"]));
    expect(html).toContain('data-path="spouses.1.incomes.0.year"');
    for (const k of ["startYear", "endYear", "indexation"]) expect(html).not.toContain(`data-path="spouses.1.incomes.0.${k}"`);
    expect(html).toContain('<option value="annual">Annuel</option><option value="once" selected>Ponctuel</option>');
    expect(plain(html)).toContain("En dollars de l'année du revenu");
    expect(/data-path="spouses\.1\.incomes\.0\.taxable"( checked)?>/.exec(html)![1]).toBe(undefined);
    expect(html).toContain('data-path="spouses.1.incomes.0.frequency" data-rerender="1"');
  });
  it("les valeurs saisies sont échappées", () => {
    const html = renderForm(withIncomes([inc({ label: "<img src=x onerror=1>" })]), new Set(["spouse0"]));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  // ---- changements, fichiers
  it("le suivi des changements : ajout, retrait et champs, avec le prénom et le numéro du revenu", () => {
    const a = defaultForm(), b = JSON.parse(JSON.stringify(a)) as FormState;
    b.spouses[0].incomes = [inc()];
    expect(describeChanges(a, b)).toEqual(["Alex : revenu 1 ajouté"]);
    expect(describeChanges(b, a)).toEqual(["Alex : revenu 1 retiré"]);
    const c = JSON.parse(JSON.stringify(b)) as FormState;
    c.spouses[0].incomes[0].amount = "65000"; c.spouses[0].incomes[0].frequency = "once"; c.spouses[0].incomes[0].taxable = false;
    expect(describeChanges(b, c)).toEqual(["Alex, revenu 1 (montant) : 60000 → 65000", "Alex, revenu 1 (fréquence) : annuel → ponctuel", "Alex, revenu 1 (imposable) : oui → non"]);
    expect([...changedPaths(b, c)].sort()).toEqual(["spouses.0.incomes.0.amount", "spouses.0.incomes.0.frequency", "spouses.0.incomes.0.taxable"]);
    const d = JSON.parse(JSON.stringify(a)) as FormState; d.spouses[1].incomes = [lump()];
    expect(describeChanges(a, d)).toEqual(["Sam : revenu 1 ajouté"]);
  });
  it("l'aller-retour par fichier conserve les revenus; un ancien fichier s'ouvre sans revenu", () => {
    const f = withIncomes([inc(), lump()], [inc({ taxable: false })]);
    expect(fileFromJson(fileToJson(f, null)).form.spouses.map((s) => s.incomes)).toEqual(f.spouses.map((s) => s.incomes));
    const old = JSON.parse(JSON.stringify(defaultForm())); delete old.spouses[0].incomes; delete old.spouses[1].incomes;
    expect(formFromJson(JSON.stringify({ form: old })).spouses.map((s) => s.incomes)).toEqual([[], []]);
  });
  it("une fréquence invalide devient « annuel »; les champs manquants reprennent leur défaut", () => {
    const odd = JSON.parse(JSON.stringify(withIncomes([inc()]))); odd.spouses[0].incomes[0].frequency = "n'importe quoi";
    expect(formFromJson(JSON.stringify({ form: odd })).spouses[0].incomes[0].frequency).toBe("annual");
    const partial = JSON.parse(JSON.stringify(defaultForm())); partial.spouses[1].incomes = [{ label: "X", amount: 5 }];
    expect(formFromJson(JSON.stringify({ form: partial })).spouses[1].incomes[0]).toEqual({ label: "X", amount: "5", frequency: "annual", taxable: true, startYear: "2026", endYear: "", indexation: "2", year: "2026" });
  });
});

describe("revenus des conjoints : résultats", () => {
  const inc = (o: Partial<IncomeForm> = {}): IncomeForm => ({ label: "Salaire", amount: "60000", frequency: "annual", taxable: true, startYear: "2027", endYear: "2029", indexation: "3", year: "2027", ...o });
  const lump = (o: Partial<IncomeForm> = {}): IncomeForm => inc({ label: "Héritage", amount: "300000", frequency: "once", taxable: false, year: "2028", ...o });
  const sc = (a: IncomeForm[], b: IncomeForm[] = [], mutate?: (f: FormState) => void) => {
    const f = defaultForm(); f.spouses[0].incomes = a; f.spouses[1].incomes = b; mutate?.(f);
    const scenario = toScenario(f).scenario!;
    return { scenario, rows: runProjection(scenario, tax) };
  };

  it("tableau : sans revenu, aucune colonne ajoutée", () => {
    const { scenario, rows } = sc([]);
    const h = parseYearTable(yearTable(scenario, rows, false)).headers;
    expect(h).not.toContain("Revenus imposables");
    expect(h).not.toContain("Revenus non imposables");
    expect(h.length).toBe(20);
  });
  it("tableau : avec des revenus, deux colonnes juste avant « Cotisation CELI » (après les ventes d'immeubles, s'il y en a)", () => {
    const { scenario, rows } = sc([inc(), lump()]);
    const h = parseYearTable(yearTable(scenario, rows, false)).headers;
    expect(h.length).toBe(22);
    const i = h.indexOf("Revenus imposables");
    expect(h.slice(i - 1, i + 3)).toEqual(["Retraits non enr.", "Revenus imposables", "Revenus non imposables", "Cotisation CELI"]);
    const f = sc([inc()], [], (form) => { form.properties = [{ label: "Chalet", owner: "both", principalResidence: false, purchaseYear: "2000", purchasePrice: "200000", saleYear: "2030", salePrice: "600000" }]; });
    const h2 = parseYearTable(yearTable(f.scenario, f.rows, false)).headers;
    expect(h2.slice(h2.indexOf("Vente d'immeubles"), h2.indexOf("Cotisation CELI") + 1)).toEqual(["Vente d'immeubles", "Gain en capital imposable", "Revenus imposables", "Revenus non imposables", "Cotisation CELI"]);
  });
  it("tableau : montants du ménage et de chaque conjoint, par type, dans l'année du revenu seulement", () => {
    const { scenario, rows } = sc([inc()], [lump({ amount: "40000", year: "2029" })]);
    const t = parseYearTable(yearTable(scenario, rows, false));
    const iT = t.headers.indexOf("Revenus imposables") - 2, iN = t.headers.indexOf("Revenus non imposables") - 2;
    const [parent, a, b] = t.rows.filter((r) => r.year === 2028);
    expect([parent.cells[iT], a.cells[iT], b.cells[iT]]).toEqual(["61 800", "61 800", "0"]);       // 60 000 $ en 2027, +3 % en 2028
    expect([parent.cells[iN], a.cells[iN], b.cells[iN]]).toEqual(["0", "0", "0"]);
    const [p29, a29, b29] = t.rows.filter((r) => r.year === 2029);
    expect([p29.cells[iN], a29.cells[iN], b29.cells[iN]]).toEqual(["40 000", "0", "40 000"]);      // ponctuel : dollars de son année, sans indexation
    const [p26] = t.rows.filter((r) => r.year === 2026);
    expect(p26.cells[iT]).toBe("0");
    const [p30] = t.rows.filter((r) => r.year === 2030);
    expect(p30.cells[iT]).toBe("0");                                                                // le salaire a pris fin en 2029
  });
  it("tableau : en dollars constants, un revenu annuel est ramené aux dollars de départ, un ponctuel aussi", () => {
    const { scenario, rows } = sc([inc()], [lump({ amount: "40000", year: "2029" })]);
    const t = parseYearTable(yearTable(scenario, rows, true));
    const iT = t.headers.indexOf("Revenus imposables") - 2, iN = t.headers.indexOf("Revenus non imposables") - 2;
    expect(Math.abs(digitsOf(t.rows.find((r) => !r.sub && r.year === 2027)!.cells[iT]) - Math.round(60000 / 1.02))).toBeLessThanOrEqual(1);
    expect(Math.abs(digitsOf(t.rows.find((r) => !r.sub && r.year === 2029)!.cells[iN]) - Math.round(40000 / Math.pow(1.02, 3)))).toBeLessThanOrEqual(1);
  });
  it("tableau : après le décès, la ligne du conjoint décédé affiche « — » et le revenu cesse", () => {
    const { scenario, rows } = sc([inc({ endYear: "" })], [], (f) => { f.spouses[0].deathAge = "70"; });
    const t = parseYearTable(yearTable(scenario, rows, false));
    const iT = t.headers.indexOf("Revenus imposables") - 2;
    const [parent, dead] = t.rows.filter((r) => r.year === 2032);
    expect(dead.cells[iT]).toBe("—");
    expect(parent.cells[iT]).toBe("0");
    expect(t.rows.find((r) => !r.sub && r.year === 2030)!.cells[iT]).not.toBe("0");
  });
  it("CSV : « Revenus imposables » et « Revenus non imposables » juste avant « Espace CELI », qui reste collé à « Cotisation CELI »", () => {
    const { scenario, rows } = sc([inc()]);
    const h = parseCsv(planToCsv(scenario, rows)).headers;
    expect(h.length).toBe(31);
    expect(h.slice(h.indexOf("Revenus imposables"), h.indexOf("Revenus imposables") + 4)).toEqual(["Revenus imposables", "Revenus non imposables", "Espace CELI", "Cotisation CELI"]);
    expect(h.indexOf("Revenus imposables")).toBe(h.indexOf("Gain en capital imposable") + 1);
  });
  it("CSV : les montants de chaque conjoint, par type; les colonnes existent toujours, à zéro sans revenu", () => {
    const { scenario, rows } = sc([inc(), lump({ amount: "7000", year: "2028", taxable: true })], [lump({ amount: "40000", year: "2029" })]);
    const t = parseCsv(planToCsv(scenario, rows));
    const row = (year: number, who: string) => t.rows.find((l) => t.col(l, "Année") === String(year) && t.col(l, "Conjoint") === who)!;
    expect(t.col(row(2028, "Alex"), "Revenus imposables")).toBe("68800");                            // 61 800 $ de salaire + 7 000 $ ponctuels imposables
    expect(t.col(row(2028, "Alex"), "Revenus non imposables")).toBe("0");
    expect(t.col(row(2029, "Sam"), "Revenus non imposables")).toBe("40000");
    expect(t.col(row(2029, "Sam"), "Revenus imposables")).toBe("0");
    expect(t.col(row(2027, "Sam"), "Revenus imposables")).toBe("0");
    const none = sc([]);
    const z = parseCsv(planToCsv(none.scenario, none.rows));
    expect(z.rows.every((l) => z.col(l, "Revenus imposables") === "0" && z.col(l, "Revenus non imposables") === "0")).toBe(true);
  });
  it("graphique : les revenus sont une source d'argent (dans leurs années seulement) et l'argent est conservé", () => {
    const { scenario, rows } = sc([inc()], [lump({ amount: "40000", year: "2029" })]);
    const d = sourcesData(scenario, rows, false);
    const key = d.keys.find((k) => k.cls === "s-income")!;
    expect(key.name).toBe("Revenus (travail et autres)");
    const k = (year: number) => rows.findIndex((y) => y.year === year);
    expect(key.v(rows[k(2028)])).toBeCloseTo(61800, 6);
    expect(key.v(rows[k(2029)])).toBeCloseTo(63654 + 40000, 6);
    expect(key.v(rows[k(2030)])).toBe(0);
    for (const real of [false, true]) {
      const dd = sourcesData(scenario, rows, real);
      rows.forEach((_, j) => expect(Math.abs(dd.stacks[j] + dd.shortfall[j] - dd.outflow[j] - dd.contributions[j])).toBeLessThan(1e-6));
    }
    expect(sourcesChart(scenario, rows, false)).toContain('class="s-income"');
    expect(sourcesChart(sc([]).scenario, sc([]).rows, false)).not.toContain('class="s-income"');
    expect(INCOME_LEGEND).toEqual({ cls: "s-income", name: "Revenus (travail et autres)" });
  });
});
