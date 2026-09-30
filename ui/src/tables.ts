import type { DeathOrderComparison, Scenario, StrategySummary, YearResult } from "../../src/index";
import { esc, fmtMoney, fmtNum } from "./format";

const deflate = (s: Scenario, real: boolean) => (year: number, x: number) => (real ? x / Math.pow(1 + s.assumptions.inflation, year - s.assumptions.startYear) : x);

/** Détail du plan, une ligne par année, pour le ménage. */
export function yearTable(s: Scenario, rows: YearResult[], real: boolean): string {
  const d = deflate(s, real);
  const sum = (y: YearResult, pick: (p: YearResult["spouses"][0]) => number) => y.spouses[0] ? pick(y.spouses[0]) + pick(y.spouses[1]) : 0;
  const head = ["Année", "Âges", "Rentes de régimes", "RRQ", "PSV", "Retraits REER/FERR", "Retraits CELI et non enr.", "Impôt", "PSV récupérée", "Pension fractionnée", "Dépenses visées", "Manque", "Solde REER/FERR", "Solde CELI", "Solde non enr."];
  const body = rows.map((y) => {
    const ages = y.spouses.map((p) => (p.alive ? String(p.age) : "†")).join(" / ");
    const split = Math.max(y.spouses[0].pensionSplit, y.spouses[1].pensionSplit);
    const cells = [
      String(y.year), ages,
      d(y.year, sum(y, (p) => p.pensionIncome)), d(y.year, sum(y, (p) => p.rrqIncome)), d(y.year, sum(y, (p) => p.psvIncome)),
      d(y.year, sum(y, (p) => p.reerWithdrawal)),
      d(y.year, sum(y, (p) => p.celiWithdrawal + p.nonRegWithdrawal)), d(y.year, sum(y, (p) => p.tax)), d(y.year, sum(y, (p) => p.psvClawback)),
      d(y.year, split), d(y.year, y.targetSpending), d(y.year, y.shortfall),
      d(y.year, sum(y, (p) => p.reerBalanceEnd)), d(y.year, sum(y, (p) => p.celiBalanceEnd)), d(y.year, sum(y, (p) => p.nonRegBalanceEnd)),
    ];
    const cls = y.shortfall > 1 ? ' class="short"' : "";
    return `<tr${cls}>${cells.map((c, i) => (i < 2 ? `<th scope="row"${i === 1 ? ' class="ages"' : ""}>${esc(String(c))}</th>` : `<td>${typeof c === "number" ? fmtNum(c) : esc(c)}</td>`)).join("")}</tr>`;
  });
  return `<div class="scroll"><table class="data year"><thead><tr>${head.map((h, i) => `<th scope="col"${i > 1 ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${body.join("")}</tbody></table></div>`;
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
