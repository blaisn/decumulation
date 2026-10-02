import type { DeathOrderComparison, Scenario, StrategySummary, YearResult } from "../../src/index";
import { esc, fmtMoney, fmtNum, fmtPct } from "./format";

const deflate = (s: Scenario, real: boolean) => (year: number, x: number) => (real ? x / Math.pow(1 + s.assumptions.inflation, year - s.assumptions.startYear) : x);

type Sp = YearResult["spouses"][0];

/**
 * Détail du plan, une ligne par année pour le ménage. Le bouton « › » à gauche de l'année déplie le détail de chaque
 * conjoint (mêmes colonnes, même structure que le CSV) : revenu imposable, taux marginal, impôt, soldes, etc.
 * Les lignes des conjoints sont toujours dans le tableau, masquées (`hidden`) : déplier ne réaffiche rien et le tableau
 * garde sa position de défilement. `expanded` donne les années dépliées au départ. « — » : conjoint décédé.
 */
export function yearTable(s: Scenario, rows: YearResult[], real: boolean, expanded: ReadonlySet<number> = new Set()): string {
  const d = deflate(s, real);
  const sum = (y: YearResult, pick: (p: Sp) => number) => (y.spouses[0] ? pick(y.spouses[0]) + pick(y.spouses[1]) : 0);
  const sales = rows.some((y) => y.spouses[0].propertyProceeds + y.spouses[1].propertyProceeds > 0);      // colonnes ajoutées seulement si un immeuble est vendu

  // Une seule définition des colonnes sert à la ligne du ménage et à celle de chaque conjoint.
  interface Col { label: string; total: (y: YearResult) => string | number; spouse: (y: YearResult, p: Sp) => string | number }
  const col = (label: string, pick: (p: Sp) => number): Col => ({ label, total: (y) => d(y.year, sum(y, pick)), spouse: (y, p) => d(y.year, pick(p)) });
  const columns: Col[] = [
    col("Rentes de régimes", (p) => p.pensionIncome), col("RRQ", (p) => p.rrqIncome), col("PSV", (p) => p.psvIncome),
    col("Retraits REER/FERR", (p) => p.reerWithdrawal), col("Retraits CELI", (p) => p.celiWithdrawal), col("Retraits non enr.", (p) => p.nonRegWithdrawal),
    ...(sales ? [col("Vente d'immeubles", (p) => p.propertyProceeds), col("Gain en capital imposable", (p) => p.taxableCapitalGain)] : []),
    col("Cotisation CELI", (p) => p.celiContribution), col("Cotisation non enr.", (p) => p.nonRegContribution),
    // De la récupération de la PSV à l'impôt, dans l'ordre du calcul : récupération et fractionnement, revenu imposable, taux marginal, impôt.
    col("PSV récupérée", (p) => p.psvClawback),
    // Ménage : montant transféré; conjoint : signé, comme dans le CSV (+ reçu, − cédé).
    { label: "Pension fractionnée", total: (y) => d(y.year, Math.max(y.spouses[0].pensionSplit, y.spouses[1].pensionSplit)), spouse: (y, p) => d(y.year, p.pensionSplit) },
    col("Revenu imposable", (p) => p.taxableIncome),
    // Le taux marginal est propre à chaque personne : rien pour le ménage.
    { label: "Taux marginal", total: () => "", spouse: (_y, p) => fmtPct(p.marginalRate) },
    col("Impôt", (p) => p.tax),
    // Conjoint : sa part de la dépense visée et du manque (réparti selon cette part).
    col("Dépenses visées", (p) => p.spending), col("Manque", (p) => p.shortfall),
    col("Solde REER/FERR", (p) => p.reerBalanceEnd), col("Solde CELI", (p) => p.celiBalanceEnd), col("Solde non enr.", (p) => p.nonRegBalanceEnd),
  ];
  const cell = (c: string | number) => `<td>${typeof c === "number" ? fmtNum(c) : esc(c)}</td>`;
  const chevron = `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const body = rows.map((y) => {
    const open = expanded.has(y.year);
    const ids = [`y${y.year}-0`, `y${y.year}-1`];
    const button = `<button type="button" class="expander" data-action="toggle-year" data-year="${y.year}" aria-expanded="${open}" aria-controls="${ids.join(" ")}" aria-label="${open ? "Masquer" : "Afficher"} le détail par conjoint de ${y.year}">${chevron}</button>`;
    const ages = y.spouses.map((p) => (p.alive ? String(p.age) : "†")).join(" / ");
    const parent = `<tr${y.shortfall > 1 ? ' class="short"' : ""} data-year="${y.year}"><th scope="row">${button}<span class="yr">${y.year}</span></th><th scope="row" class="ages">${esc(ages)}</th>${columns.map((c) => cell(c.total(y))).join("")}</tr>`;
    const subs = y.spouses.map((p, i) => {
      const name = s.spouses[i].name;
      return `<tr class="sub" id="${ids[i]}" data-year="${y.year}"${open ? "" : " hidden"}><th scope="row" class="who" title="${esc(name)}">${esc(name)}<span class="sr-only"> en ${y.year}</span></th><th scope="row" class="ages">${p.alive ? p.age : "†"}</th>${columns.map((c) => cell(p.alive ? c.spouse(y, p) : "—")).join("")}</tr>`;
    });
    return parent + subs.join("");
  });
  const head = [{ label: "Année" }, { label: "Âges" }, ...columns];
  const th = (h: { label: string }, i: number) => `<th scope="col"${i > 1 ? ' class="num"' : ""}>${esc(h.label)}</th>`;
  return `<div class="scroll"><table class="data year"><thead><tr>${head.map(th).join("")}</tr></thead><tbody>${body.join("")}</tbody></table></div>`;
}

/** Regroupe les lignes dont la clé est identique : garde la première et compte les équivalentes. */
function groupSame<T>(list: T[], key: (x: T) => string): { item: T; index: number; same: number }[] {
  const out: { item: T; index: number; same: number }[] = [];
  const seen = new Map<string, number>();
  list.forEach((item, index) => {
    const k = key(item);
    const at = seen.get(k);
    if (at === undefined) { seen.set(k, out.length); out.push({ item, index, same: 0 }); } else out[at].same++;
  });
  return out;
}
const sameNote = (n: number) => (n > 0 ? `<span class="same">+ ${n} autre${n > 1 ? "s" : ""} stratégie${n > 1 ? "s" : ""} au même résultat</span>` : "");

/** Comparaison des stratégies. Le bouton « Appliquer » recharge la stratégie dans le formulaire. */
export function strategiesTable(list: StrategySummary[], real: boolean): string {
  const groups = groupSame(list, (r) => [r.totalTax, r.totalClawback, r.afterTaxEstate, r.totalShortfall].map((v) => Math.round(v)).join("|"));
  const rows = groups.map(({ item: r, index: i, same }, g) => {
    const ok = r.totalShortfall <= 100;
    const v = real ? r : r.nominal;
    return `<tr class="${g === 0 && ok ? "best" : ""}"><th scope="row">${esc(r.label)}${sameNote(same)}</th><td>${fmtMoney(v.totalTax)}</td><td>${fmtMoney(v.totalClawback)}</td><td>${fmtMoney(v.afterTaxEstate)}</td><td>${ok ? "Aucun" : `${r.yearsWithShortfall} an${r.yearsWithShortfall > 1 ? "s" : ""}`}</td><td><button type="button" class="link" data-action="apply-strategy" data-index="${i}">Appliquer</button></td></tr>`;
  });
  return `<div class="scroll"><table class="data wide"><thead><tr><th scope="col">Stratégie</th><th scope="col" class="num">Impôt cumulé</th><th scope="col" class="num">PSV récupérée</th><th scope="col" class="num">Succession après impôt</th><th scope="col" class="num">Dépenses non financées</th><th scope="col"><span class="sr">Action</span></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

const shortCase = (label: string) => (label.startsWith("Les deux") ? "Aucun décès" : label.replace(" décède à ", " ").replace(/ ans/g, "").replace(/ jusqu'à la fin du plan/g, " fin"));

export function deathBestTable(c: DeathOrderComparison, real: boolean): string {
  const rows = c.bestPerScenario.map((b) => `<tr><th scope="row">${esc(b.scenario)}</th><td class="txt">${esc(b.label)}</td><td class="num">${fmtMoney(real ? b.estate : b.estateNominal)}</td></tr>`);
  return `<div class="scroll"><table class="data wide"><thead><tr><th scope="col">Cas de décès</th><th scope="col">Meilleure stratégie</th><th scope="col" class="num">Succession après impôt</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

export function deathRankTable(c: DeathOrderComparison, real: boolean, limit = 8, showRisk = false): string {
  const groups = groupSame(c.rows, (r) => [r.average, r.worst, r.maxRegret].map((v) => Math.round(v)).join("|")).slice(0, limit);
  const rows = groups.map(({ item: r, index: i, same }, g) => `<tr class="${g === 0 && r.totalShortfall <= 100 ? "best" : ""}"><th scope="row">${esc(r.label)}${sameNote(same)}</th><td>${fmtMoney((real ? r : r.nominal).average)}</td><td>${fmtMoney((real ? r : r.nominal).worst)}</td><td>${fmtMoney((real ? r : r.nominal).maxRegret)}</td>${showRisk ? `<td>${Math.round(r.shortfallProbability * 100)} %</td>` : ""}<td><button type="button" class="link" data-action="apply-death-strategy" data-index="${i}">Appliquer</button></td></tr>`);
  return `<div class="scroll"><table class="data wide"><thead><tr><th scope="col">Stratégie</th><th scope="col" class="num">Succession moyenne</th><th scope="col" class="num">Pire cas</th><th scope="col" class="num">Regret maximal</th>${showRisk ? '<th scope="col" class="num">Cas sans fonds suffisants</th>' : ""}<th scope="col"><span class="sr">Action</span></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

export function deathMatrix(c: DeathOrderComparison, real: boolean): string {
  const best = c.bestPerScenario.map((b) => (real ? b.estate : b.estateNominal));
  const head = c.scenarios.map((d) => `<th scope="col" class="num">${esc(shortCase(d.label))}</th>`).join("");
  const rows = c.rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th>${(real ? r.estates : r.nominal.estates).map((e, j) => `<td class="${e >= best[j] - 0.5 ? "bestcell" : ""}">${fmtNum(e / 1000)}</td>`).join("")}</tr>`);
  return `<div class="scroll"><table class="data"><thead><tr><th scope="col">Stratégie (succession en k$)</th>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
