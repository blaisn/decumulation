import type { Scenario, YearResult } from "../../src/index";
import { esc, fmtCompact, fmtNum } from "./format";

// Graphiques en SVG (chaînes de texte). Les couleurs viennent des classes CSS, jamais d'attributs en ligne.

const W = 900;
const M = { l: 58, r: 14, t: 6, b: 26 };
const PLOT_W = W - M.l - M.r;

function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

const deflate = (s: Scenario, real: boolean) => (year: number, x: number) => (real ? x / Math.pow(1 + s.assumptions.inflation, year - s.assumptions.startYear) : x);
const total = (y: YearResult, pick: (sp: YearResult["spouses"][0]) => number) => pick(y.spouses[0]) + pick(y.spouses[1]);

function axes(y0: number, y1: number, top: number, h: number, max: number, xs: (year: number) => number, ys: (v: number) => number): string {
  let out = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    out += `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${ys(v).toFixed(1)}" y2="${ys(v).toFixed(1)}"/>`;
    out += `<text class="tick" x="${M.l - 6}" y="${(ys(v) + 3.5).toFixed(1)}" text-anchor="end">${esc(fmtCompact(v))}</text>`;
  }
  for (let y = Math.ceil(y0 / 5) * 5; y <= y1; y += 5) {
    out += `<text class="tick" x="${xs(y).toFixed(1)}" y="${top + h + 17}" text-anchor="middle">${y}</text>`;
  }
  return out;
}

interface Milestone { year: number; label: string; detail: string; death?: boolean }

function milestones(s: Scenario, i: number, y0: number, y1: number): Milestone[] {
  const sp = s.spouses[i];
  const list: Milestone[] = [];
  const add = (age: number, label: string, detail: string, death = false) => {
    const year = sp.birthYear + age;
    if (year >= y0 && year <= y1) list.push({ year, label, detail: `${detail} : ${sp.name}, ${year} (${age} ans)`, death });
  };
  sp.dbPensions.forEach((p) => add(p.startAge, "RPA", `Début de la rente « ${p.label} »`));
  add(sp.rrq.startAge, "RRQ", "Début de la RRQ");
  add(sp.psv.startAge, "PSV", "Début de la PSV");
  add(71, "FERR", "Conversion du REER en FERR");
  if (sp.deathAge !== undefined) add(sp.deathAge, "décès", "Décès prévu", true);
  return list.sort((a, b) => a.year - b.year);
}

const short = (n: string) => (n.length > 9 ? n.slice(0, 8) + "…" : n);

/** Soldes des comptes au fil des années, sous une ligne de vie par conjoint (début des rentes, FERR, décès). */
export function balancesChart(s: Scenario, rows: YearResult[], real: boolean): string {
  if (!rows.length) return "";
  const d = deflate(s, real);
  const y0 = rows[0].year, y1 = rows[rows.length - 1].year;
  const xs = (year: number) => M.l + ((year - y0) / Math.max(1, y1 - y0)) * PLOT_W;

  const LH = 34;
  const lifeH = LH * 2;
  const top = M.t + lifeH + 8;
  const H = 230;
  const height = top + H + M.b;

  const reer = rows.map((y) => d(y.year, total(y, (p) => p.reerBalanceEnd)));
  const nonReg = rows.map((y) => d(y.year, total(y, (p) => p.nonRegBalanceEnd)));
  const celi = rows.map((y) => d(y.year, total(y, (p) => p.celiBalanceEnd)));
  const stack = rows.map((_, k) => reer[k] + celi[k] + nonReg[k]);
  const max = niceMax(Math.max(...stack) * 1.04);
  const ys = (v: number) => top + H - (v / max) * H;

  const layers: { cls: string; low: number[]; high: number[] }[] = [
    { cls: "s-reer", low: rows.map(() => 0), high: reer },
    { cls: "s-celi", low: reer, high: reer.map((v, k) => v + celi[k]) },
    { cls: "s-nonreg", low: reer.map((v, k) => v + celi[k]), high: stack },
  ];
  let body = axes(y0, y1, top, H, max, xs, ys);
  for (const L of layers) {
    const up = rows.map((y, k) => `${xs(y.year).toFixed(1)},${ys(L.high[k]).toFixed(1)}`);
    const down = rows.map((y, k) => `${xs(y.year).toFixed(1)},${ys(L.low[k]).toFixed(1)}`).reverse();
    body += `<polygon class="${L.cls}" points="${up.concat(down).join(" ")}"/>`;
  }

  // Ligne de vie
  let life = "";
  [0, 1].forEach((i) => {
    const sp = s.spouses[i];
    const rowTop = M.t + i * LH;
    const lineY = rowTop + 26;
    const end = sp.deathAge !== undefined ? Math.min(y1, sp.birthYear + sp.deathAge) : y1;
    life += `<text class="who" x="0" y="${lineY + 4}">${esc(short(sp.name))}</text>`;
    life += `<line class="life" x1="${xs(y0).toFixed(1)}" x2="${xs(end).toFixed(1)}" y1="${lineY}" y2="${lineY}"/>`;
    milestones(s, i, y0, y1).forEach((m, k) => {
      const x = xs(m.year).toFixed(1);
      const level = k % 2 === 0 ? rowTop + 10 : rowTop + 20;
      life += `<g><title>${esc(m.detail)}</title>` +
        (m.death ? `<rect class="mark death" x="${(+x - 3.5).toFixed(1)}" y="${lineY - 3.5}" width="7" height="7"/>` : `<circle class="mark" cx="${x}" cy="${lineY}" r="3.5"/>`) +
        `<text class="mlabel" x="${x}" y="${level}" text-anchor="middle">${esc(m.label)}</text></g>`;
    });
  });

  // Info-bulles par année
  const step = PLOT_W / Math.max(1, y1 - y0);
  let tips = "";
  rows.forEach((y, k) => {
    tips += `<rect class="hit" x="${(xs(y.year) - step / 2).toFixed(1)}" y="${top}" width="${step.toFixed(1)}" height="${H}"><title>${y.year}, fin d'année : REER/FERR ${esc(fmtNum(reer[k]))} $, CELI ${esc(fmtNum(celi[k]))} $, non enregistré ${esc(fmtNum(nonReg[k]))} $</title></rect>`;
  });

  const label = `Soldes des comptes de ${y0} à ${y1}, de ${fmtNum(stack[0])} $ à ${fmtNum(stack[stack.length - 1])} $ ${real ? `en dollars de ${s.assumptions.startYear}` : "en dollars courants"}.`;
  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)}">${life}${body}${tips}</svg>`;
}

export interface SourcesData {
  keys: { cls: string; name: string; v: (y: YearResult) => number }[];
  stacks: number[]; // total des sources d'argent de chaque année (le dessus des colonnes)
  outflow: number[]; // dépense visée + impôt + PSV récupérée (la ligne), manque compris
  shortfall: number[]; // manque de chaque année
  contributions: number[]; // surplus réinvesti (cotisations au CELI et au compte non enregistré)
}

/**
 * Données du graphique « D'où vient l'argent ». Identité : colonnes + manque = ligne + surplus réinvesti.
 * La ligne est la dépense *visée* plus l'impôt, pas la dépense financée : quand l'argent manque, elle passe au-dessus des colonnes.
 */
export function sourcesData(s: Scenario, rows: YearResult[], real: boolean): SourcesData {
  const d = deflate(s, real);
  const keys: SourcesData["keys"] = [
    { cls: "s-rpa", name: "Rentes de régimes de retraite", v: (y) => total(y, (p) => p.pensionIncome) },
    { cls: "s-rrq", name: "RRQ", v: (y) => total(y, (p) => p.rrqIncome) },
    { cls: "s-psv", name: "PSV", v: (y) => total(y, (p) => p.psvIncome) },
    { cls: "s-reer", name: "Retraits REER/FERR", v: (y) => total(y, (p) => p.reerWithdrawal) },
    { cls: "s-nonreg", name: "Non enregistré", v: (y) => total(y, (p) => p.nonRegIncome + p.nonRegWithdrawal) },
    { cls: "s-celi", name: "Retraits CELI", v: (y) => total(y, (p) => p.celiWithdrawal) },
    { cls: "s-prop", name: "Vente d'immeubles", v: (y) => total(y, (p) => p.propertyProceeds) },
  ];
  return {
    keys,
    stacks: rows.map((y) => keys.reduce((a, k) => a + d(y.year, k.v(y)), 0)),
    outflow: rows.map((y) => d(y.year, y.targetSpending + y.extraSpending + total(y, (p) => p.tax + p.psvClawback))),
    shortfall: rows.map((y) => d(y.year, y.shortfall)),
    contributions: rows.map((y) => d(y.year, total(y, (p) => p.celiContribution + p.nonRegContribution))),
  };
}

/** D'où vient l'argent chaque année, avec la ligne « dépenses visées + dépenses supplémentaires + impôt » : ce qui dépasse est réinvesti, ce qui manque est en rouge. */
export function sourcesChart(s: Scenario, rows: YearResult[], real: boolean): string {
  if (!rows.length) return "";
  const d = deflate(s, real);
  const y0 = rows[0].year, y1 = rows[rows.length - 1].year;
  const H = 240;
  const top = M.t + 4;
  const height = top + H + M.b;
  const xs = (year: number) => M.l + ((year - y0) / Math.max(1, y1 - y0)) * PLOT_W;

  const { keys, stacks, outflow, shortfall } = sourcesData(s, rows, real);
  const max = niceMax(Math.max(...stacks, ...outflow) * 1.04);
  const ys = (v: number) => top + H - (v / max) * H;
  const bw = Math.max(2, (PLOT_W / rows.length) * 0.78);

  let body = axes(y0, y1, top, H, max, xs, ys);
  rows.forEach((y, k) => {
    let acc = 0;
    let tip = `${y.year} : `;
    keys.forEach((key) => {
      const v = d(y.year, key.v(y));
      if (v > 0.5) {
        body += `<rect class="${key.cls}" x="${(xs(y.year) - bw / 2).toFixed(1)}" y="${ys(acc + v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, ys(acc) - ys(acc + v)).toFixed(1)}"/>`;
        tip += `${key.name} ${fmtNum(v)} $; `;
      }
      acc += v;
    });
    // Manque : la zone entre le dessus des colonnes et la ligne, quand les dépenses visées ne sont pas toutes financées.
    if (y.shortfall > 1 && outflow[k] > stacks[k]) {
      body += `<rect class="s-short" x="${(xs(y.year) - bw / 2).toFixed(1)}" y="${ys(outflow[k]).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, ys(stacks[k]) - ys(outflow[k])).toFixed(1)}"/>`;
      tip += `MANQUE ${fmtNum(shortfall[k])} $; `;
    }
    body += `<rect class="hit" x="${(xs(y.year) - PLOT_W / rows.length / 2).toFixed(1)}" y="${top}" width="${(PLOT_W / rows.length).toFixed(1)}" height="${H}"><title>${esc(tip)}dépenses + impôt ${esc(fmtNum(outflow[k]))} $</title></rect>`;
  });
  body += `<polyline class="outflow" fill="none" points="${rows.map((y, k) => `${xs(y.year).toFixed(1)},${ys(outflow[k]).toFixed(1)}`).join(" ")}"/>`;

  const first = rows.find((y) => y.shortfall > 1);
  const label = `Revenus par source de ${y0} à ${y1}, comparés aux dépenses (visées et supplémentaires) et à l'impôt${first ? `; les dépenses visées ne sont pas toutes financées à partir de ${first.year}` : ""}.`;
  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)}">${body}</svg>`;
}

export const BALANCE_LEGEND = [
  { cls: "s-reer", name: "REER/FERR" }, { cls: "s-celi", name: "CELI" }, { cls: "s-nonreg", name: "Non enregistré" },
];
export const SOURCE_LEGEND = [
  { cls: "s-rpa", name: "Rentes de régimes de retraite" }, { cls: "s-rrq", name: "RRQ" }, { cls: "s-psv", name: "PSV" },
  { cls: "s-reer", name: "Retraits REER/FERR" }, { cls: "s-nonreg", name: "Non enregistré" }, { cls: "s-celi", name: "Retraits CELI" },
];

/** Légende de la vente d'immeubles : ajoutée seulement quand le plan en contient une. */
export const PROPERTY_LEGEND = { cls: "s-prop", name: "Vente d'immeubles" };

export function legend(items: { cls: string; name: string }[], extra = ""): string {
  return `<ul class="legend">${items.map((i) => `<li><span class="sw ${i.cls}"></span>${esc(i.name)}</li>`).join("")}${extra}</ul>`;
}

export interface LineSeries { name: string; cls: "cmp-base" | "cmp-cur"; points: [number, number][] }

/** Deux courbes (données de base et situation actuelle) sur le même axe. */
export function compareChart(series: LineSeries[], label: string): string {
  const years = series.flatMap((s) => s.points.map((p) => p[0]));
  if (!years.length) return "";
  const y0 = Math.min(...years), y1 = Math.max(...years);
  const H = 190;
  const top = M.t + 4;
  const height = top + H + M.b;
  const xs = (year: number) => M.l + ((year - y0) / Math.max(1, y1 - y0)) * PLOT_W;
  const max = niceMax(Math.max(...series.flatMap((s) => s.points.map((p) => p[1]))) * 1.04);
  const ys = (v: number) => top + H - (v / max) * H;
  let body = axes(y0, y1, top, H, max, xs, ys);
  for (const s of series) {
    body += `<polyline class="${s.cls}" fill="none" points="${s.points.map(([y, v]) => `${xs(y).toFixed(1)},${ys(v).toFixed(1)}`).join(" ")}"/>`;
  }
  const step = PLOT_W / Math.max(1, y1 - y0);
  for (let y = y0; y <= y1; y++) {
    const tip = series.map((s) => { const p = s.points.find((q) => q[0] === y); return p ? `${s.name} ${fmtNum(p[1])} $` : `${s.name} : sans donnée`; }).join("; ");
    body += `<rect class="hit" x="${(xs(y) - step / 2).toFixed(1)}" y="${top}" width="${step.toFixed(1)}" height="${H}"><title>${y} : ${esc(tip)}</title></rect>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)}">${body}</svg>`;
}
