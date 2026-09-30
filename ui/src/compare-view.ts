import type { Scenario, StrategySummary, YearResult } from "../../src/index";
import { compareChart } from "./charts";
import type { LineSeries } from "./charts";
import { esc, fmtMoney } from "./format";

export interface PlanView { scenario: Scenario; rows: YearResult[]; summary: StrategySummary }

const sign = (x: number) => (Math.abs(x) < 0.5 ? "0 $" : `${x > 0 ? "+" : "−"}${fmtMoney(Math.abs(x))}`);
const deflate = (s: Scenario, real: boolean) => (year: number, x: number) => (real ? x / Math.pow(1 + s.assumptions.inflation, year - s.assumptions.startYear) : x);
const firstShortfall = (v: PlanView) => v.rows.find((y) => y.shortfall > 1)?.year;

function series(v: PlanView, cls: LineSeries["cls"], name: string, real: boolean, pick: (y: YearResult) => number): LineSeries {
  const d = deflate(v.scenario, real);
  return { name, cls, points: v.rows.map((y) => [y.year, d(y.year, pick(y))]) };
}

/** Effet des changements : plan des données de base à côté du plan actuel. */
export function comparePanel(a: { base: PlanView; cur: PlanView; changes: string[]; real: boolean }): string {
  const { base, cur, changes, real } = a;
  const b = real ? base.summary : base.summary.nominal;
  const c = real ? cur.summary : cur.summary.nominal;
  const fsB = firstShortfall(base), fsC = firstShortfall(cur);
  const bs = base.scenario.assumptions, cs = cur.scenario.assumptions;
  const lastB = base.rows[base.rows.length - 1].year, lastC = cur.rows[cur.rows.length - 1].year;

  const rel = (d: number, more: string, less: string) => `${fmtMoney(Math.abs(d))} ${d >= 0 ? more : less}`;
  const dEstate = c.afterTaxEstate - b.afterTaxEstate, dTax = c.totalTax - b.totalTax;
  let verdict: string;
  if (!changes.length) verdict = "Aucun champ ne diffère des données de base : les deux plans sont identiques.";
  else {
    verdict = Math.abs(dEstate) < 1 && Math.abs(dTax) < 1
      ? "Ces changements ne modifient ni l'impôt ni la succession."
      : `Avec ces changements, il reste <strong>${rel(dEstate, "de plus", "de moins")}</strong> après impôt à la fin, et le couple paie <strong>${rel(dTax, "de plus", "de moins")}</strong> d'impôt sur l'ensemble du plan.`;
    if (fsC !== undefined && fsB === undefined) verdict += ` <strong>Attention : les fonds s'épuisent en ${fsC}</strong>, alors que les données de base finançaient toutes les années.`;
    else if (fsC === undefined && fsB !== undefined) verdict += ` Les fonds ne s'épuisent plus : dans les données de base, ils manquaient dès ${fsB}.`;
    else if (fsC !== undefined && fsB !== undefined && fsC !== fsB) verdict += ` Les fonds s'épuisent en ${fsC} au lieu de ${fsB}.`;
  }

  const unit = real
    ? `Montants en dollars de ${cs.startYear}, sans l'effet de l'inflation.`
    : `Montants en dollars courants, avec l'inflation : les soldes de fin sont en dollars de ${lastC}.`;
  const mismatch = real && (bs.startYear !== cs.startYear || bs.inflation !== cs.inflation)
    ? `<p class="alert soft" role="status">L'année de départ ou l'inflation diffère entre les deux plans : la comparaison en dollars constants n'est pas sur la même base. Choisissez plutôt les dollars courants.</p>`
    : !real && lastB !== lastC
      ? `<p class="alert soft" role="status">Les deux plans ne se terminent pas la même année (${lastB} et ${lastC}) : les soldes de fin ne sont pas exprimés en dollars de la même année.</p>`
      : "";

  const money: [string, number, number][] = [
    ["Impôt cumulé", b.totalTax, c.totalTax],
    ["PSV récupérée par l'impôt", b.totalClawback, c.totalClawback],
    ["Dépenses non financées", b.totalShortfall, c.totalShortfall],
    ["REER/FERR restant à la fin", b.finalReer, c.finalReer],
    ["CELI restant à la fin", b.finalCeli, c.finalCeli],
    ["Non enregistré restant à la fin", b.finalNonReg, c.finalNonReg],
    ["Succession après impôt", b.afterTaxEstate, c.afterTaxEstate],
  ];
  const yearCell = (y?: number) => (y === undefined ? "Aucune" : String(y));
  const yearDiff = fsB === undefined || fsC === undefined ? "—" : fsC === fsB ? "0 an" : `${fsC > fsB ? "+" : "−"}${Math.abs(fsC - fsB)} an${Math.abs(fsC - fsB) > 1 ? "s" : ""}`;
  const rows = money.map(([label, x, y], i) => `<tr${i === money.length - 1 ? ' class="total"' : ""}><th scope="row">${esc(label)}</th><td>${fmtMoney(x)}</td><td>${fmtMoney(y)}</td><td class="delta">${sign(y - x)}</td></tr>`)
    .concat(`<tr><th scope="row">Première année sans fonds</th><td>${yearCell(fsB)}</td><td>${yearCell(fsC)}</td><td class="delta">${yearDiff}</td></tr>`);

  const shown = changes.slice(0, 6);
  const changeList = changes.length
    ? `<h2>Ce qui change</h2><ul class="changelist">${shown.map((t) => `<li>${esc(t)}</li>`).join("")}${changes.length > shown.length ? `<li>et ${changes.length - shown.length} autre${changes.length - shown.length > 1 ? "s" : ""} (liste complète à gauche)</li>` : ""}</ul>`
    : "";

  const lg = `<ul class="legend"><li><span class="sw line dashed"></span>Données de base</li><li><span class="sw line cur"></span>Situation actuelle</li></ul>`;
  const total = (y: YearResult) => y.spouses[0].reerBalanceEnd + y.spouses[1].reerBalanceEnd + y.spouses[0].celiBalanceEnd + y.spouses[1].celiBalanceEnd + y.spouses[0].nonRegBalanceEnd + y.spouses[1].nonRegBalanceEnd;
  const paid = (y: YearResult) => y.spouses[0].tax + y.spouses[1].tax + y.spouses[0].psvClawback + y.spouses[1].psvClawback;
  const pair = (fn: (y: YearResult) => number, label: string) => compareChart([series(base, "cmp-base", "Base", real, fn), series(cur, "cmp-cur", "Actuel", real, fn)], label);

  return `<p class="lede">${verdict}<span class="small">${esc(unit)}</span></p>
    ${mismatch}
    ${changeList}
    <h2>Résultats côte à côte</h2>
    <div class="scroll"><table class="data wide"><thead><tr><th scope="col">Mesure</th><th scope="col" class="num">Données de base</th><th scope="col" class="num">Situation actuelle</th><th scope="col" class="num">Écart</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
    <h2>Actifs totaux</h2>${lg}${pair(total, "Actifs totaux à la fin de chaque année, données de base et situation actuelle")}
    <h2>Impôt payé chaque année</h2>${lg}${pair(paid, "Impôt et PSV récupérée chaque année, données de base et situation actuelle")}
    <p class="note">L'impôt inclut la PSV récupérée par l'impôt. Les stratégies de retrait sont comparées dans l'onglet Stratégies.</p>`;
}
