import type { Assumptions, Scenario, Strategy, TaxYearTable, YearResult } from "./types";
import { gompertz, representativeDeathAges } from "./mortality";
import { runProjection } from "./projection";

export interface LabeledStrategy { label: string; strategy: Strategy }

/** Montants cumulés sur le plan. */
export interface Amounts {
  totalTax: number;
  totalClawback: number; // récupération fiscale de la PSV
  totalShortfall: number; // dépenses non financées
  finalReer: number;
  finalCeli: number;
  finalNonReg: number;
  afterTaxEstate: number; // CELI + REER x (1 - taux présumé) + non enregistré x (1 - taux présumé)
}

/**
 * Les montants de premier niveau sont en dollars de l'année de départ (déflatés par l'inflation);
 * `nominal` donne les mêmes montants en dollars courants : chaque année en dollars de cette année,
 * et les soldes de fin en dollars de la dernière année.
 */
export interface StrategySummary extends Amounts {
  label: string;
  strategy: Strategy;
  yearsWithShortfall: number;
  nominal: Amounts;
}

export interface CompareOptions {
  estateTaxRate?: number; // impôt présumé sur le REER/FERR restant au dernier décès (défaut 0,45)
  nonRegTaxRate?: number; // impôt présumé sur les gains latents du compte non enregistré (défaut 0,10)
}

function amounts(rows: YearResult[], a: Assumptions, opts: CompareOptions, real: boolean): Amounts {
  const rate = opts.estateTaxRate ?? 0.45;
  const nrRate = opts.nonRegTaxRate ?? 0.1;
  const f = (year: number, x: number) => (real ? x / Math.pow(1 + a.inflation, year - a.startYear) : x);
  let totalTax = 0, totalClawback = 0, totalShortfall = 0;
  for (const y of rows) {
    totalTax += f(y.year, y.spouses[0].tax + y.spouses[1].tax);
    totalClawback += f(y.year, y.spouses[0].psvClawback + y.spouses[1].psvClawback);
    if (y.shortfall > 1) totalShortfall += f(y.year, y.shortfall);
  }
  const last = rows[rows.length - 1];
  const finalReer = f(last.year, last.spouses[0].reerBalanceEnd + last.spouses[1].reerBalanceEnd);
  const finalCeli = f(last.year, last.spouses[0].celiBalanceEnd + last.spouses[1].celiBalanceEnd);
  const finalNonReg = f(last.year, last.spouses[0].nonRegBalanceEnd + last.spouses[1].nonRegBalanceEnd);
  return { totalTax, totalClawback, totalShortfall, finalReer, finalCeli, finalNonReg, afterTaxEstate: finalCeli + finalReer * (1 - rate) + finalNonReg * (1 - nrRate) };
}

export function summarize(label: string, strategy: Strategy, rows: YearResult[], a: Assumptions, opts: CompareOptions = {}): StrategySummary {
  return {
    label, strategy,
    yearsWithShortfall: rows.filter((y) => y.shortfall > 1).length,
    ...amounts(rows, a, opts, true),
    nominal: amounts(rows, a, opts, false),
  };
}

/** Stratégies testées par défaut : deux ordres simples, des plafonds de revenu, et la fonte du REER avec les mêmes plafonds. */
export function defaultCandidates(): LabeledStrategy[] {
  const list: LabeledStrategy[] = [
    { label: "REER d'abord", strategy: { kind: "reer-first" } },
    { label: "CELI d'abord", strategy: { kind: "celi-first" } },
    { label: "REER jusqu'au seuil de la PSV", strategy: { kind: "ceiling", ceiling: "psv-threshold" } },
  ];
  for (let c = 50000; c <= 110000; c += 10000) list.push({ label: `REER jusqu'à ${c.toLocaleString("fr-CA")} $ par conjoint`, strategy: { kind: "ceiling", ceiling: c } });
  list.push({ label: "Fonte du REER jusqu'au seuil de la PSV", strategy: { kind: "meltdown", ceiling: "psv-threshold" } });
  for (let c = 60000; c <= 100000; c += 10000) list.push({ label: `Fonte du REER jusqu'à ${c.toLocaleString("fr-CA")} $ par conjoint`, strategy: { kind: "meltdown", ceiling: c } });
  return list;
}

/**
 * Exécute le scénario avec chaque stratégie et classe les résultats : les stratégies qui
 * financent toutes les dépenses d'abord, puis par valeur après impôt de la succession décroissante.
 */
export function compareStrategies(s: Scenario, tax: TaxYearTable, candidates: LabeledStrategy[] = defaultCandidates(), opts: CompareOptions = {}): StrategySummary[] {
  const out = candidates.map((c) => summarize(c.label, c.strategy, runProjection({ ...s, strategy: c.strategy }, tax), s.assumptions, opts));
  const failed = (x: StrategySummary) => (x.totalShortfall > 100 ? 1 : 0);
  return out.sort((a, b) => failed(a) - failed(b) || b.afterTaxEstate - a.afterTaxEstate);
}

// ---------------------------------------------------------------------------
// Comparaison selon l'ordre et l'âge des décès
// ---------------------------------------------------------------------------

/** Un cas de décès : l'âge au décès de chaque conjoint (`undefined` = vit jusqu'à la fin du plan). */
export interface DeathScenario {
  label: string;
  deathAges: [number | undefined, number | undefined];
}

export interface DeathOrderOptions extends CompareOptions {
  deathAges?: number[]; // âges testés pour le premier décès (défaut 75, 80, 85, 90)
  includeNoDeath?: boolean; // ajoute le cas « les deux vivent jusqu'à la fin du plan » (défaut true)
  weights?: number[]; // pondération de chaque cas, dans l'ordre de `scenarios` (défaut : poids égaux)
}

export interface DeathOrderRow {
  label: string;
  strategy: Strategy;
  estates: number[]; // succession après impôt pour chaque cas de décès
  totalTaxes: number[];
  average: number; // moyenne pondérée des successions
  worst: number; // pire succession
  maxRegret: number; // plus grand écart avec la meilleure stratégie dans un cas de décès
  totalShortfall: number; // dépenses non financées, tous cas confondus
  shortfallProbability: number; // poids des cas où des dépenses ne sont pas financées (0 à 1)
  /** Mêmes mesures en dollars courants (dans chaque cas, les soldes de fin sont en dollars de la dernière année). */
  nominal: { estates: number[]; totalTaxes: number[]; average: number; worst: number; maxRegret: number };
}

export interface DeathOrderComparison {
  scenarios: DeathScenario[];
  probabilities: number[]; // poids normalisé de chaque cas (somme = 1)
  rows: DeathOrderRow[]; // classées : sans manque d'abord, puis par plus petit regret maximal
  bestPerScenario: { scenario: string; label: string; estate: number; estateNominal: number }[];
}

/** Cas de décès à tester : chaque conjoint qui décède en premier à chacun des âges, l'autre vivant jusqu'à la fin du plan. */
export function deathScenarios(s: Scenario, ages: number[] = [75, 80, 85, 90], includeNoDeath = true): DeathScenario[] {
  const list: DeathScenario[] = [];
  for (const i of [0, 1] as const) {
    for (const age of ages) {
      list.push({ label: `${s.spouses[i].name} décède à ${age} ans`, deathAges: i === 0 ? [age, undefined] : [undefined, age] });
    }
  }
  if (includeNoDeath) list.push({ label: "Les deux vivent jusqu'à la fin du plan", deathAges: [undefined, undefined] });
  return list;
}

export function applyDeathScenario(s: Scenario, d: DeathScenario): Scenario {
  return { ...s, spouses: [{ ...s.spouses[0], deathAge: d.deathAges[0] }, { ...s.spouses[1], deathAge: d.deathAges[1] }] };
}

/**
 * Exécute chaque stratégie dans chaque cas de décès (les `deathAge` du scénario de base sont remplacés)
 * et classe les stratégies selon leur robustesse : celles qui financent toutes les dépenses d'abord, puis
 * par plus petit regret maximal (écart avec la meilleure stratégie du cas), puis par moyenne décroissante.
 */
export function compareDeathOrders(s: Scenario, tax: TaxYearTable, candidates: LabeledStrategy[] = defaultCandidates(), opts: DeathOrderOptions = {}): DeathOrderComparison {
  const scenarios = deathScenarios(s, opts.deathAges, opts.includeNoDeath ?? true);
  const weights = opts.weights ?? scenarios.map(() => 1);
  if (weights.length !== scenarios.length) throw new Error(`weights doit compter ${scenarios.length} valeurs (une par cas de décès)`);
  return evaluateScenarios(s, tax, candidates, scenarios, weights, opts);
}

/** Exécute chaque stratégie dans chaque cas de décès et calcule la moyenne, le pire cas et le regret maximal. */
function evaluateScenarios(s: Scenario, tax: TaxYearTable, candidates: LabeledStrategy[], scenarios: DeathScenario[], weights: number[], opts: CompareOptions): DeathOrderComparison {
  const wSum = weights.reduce((a, b) => a + b, 0);

  // matrice [stratégie][cas]
  const cells = candidates.map((c) => scenarios.map((d) => summarize(c.label, c.strategy, runProjection({ ...applyDeathScenario(s, d), strategy: c.strategy }, tax), s.assumptions, opts)));

  const feasible = (x: StrategySummary) => x.totalShortfall <= 100;
  const best = scenarios.map((_, j) => {
    const pool = cells.map((row) => row[j]);
    const ok = pool.filter(feasible);
    return (ok.length ? ok : pool).reduce((a, b) => (b.afterTaxEstate > a.afterTaxEstate ? b : a));
  });

  const rows: DeathOrderRow[] = candidates.map((c, i) => {
    const estates = cells[i].map((x) => x.afterTaxEstate);
    const estatesN = cells[i].map((x) => x.nominal.afterTaxEstate);
    return {
      label: c.label,
      strategy: c.strategy,
      estates,
      nominal: {
        estates: estatesN,
        totalTaxes: cells[i].map((x) => x.nominal.totalTax),
        average: estatesN.reduce((sum, e, j) => sum + e * weights[j], 0) / wSum,
        worst: Math.min(...estatesN),
        maxRegret: Math.max(...estatesN.map((e, j) => best[j].nominal.afterTaxEstate - e)),
      },
      totalTaxes: cells[i].map((x) => x.totalTax),
      average: estates.reduce((sum, e, j) => sum + e * weights[j], 0) / wSum,
      worst: Math.min(...estates),
      maxRegret: Math.max(...estates.map((e, j) => best[j].afterTaxEstate - e)),
      totalShortfall: cells[i].reduce((sum, x) => sum + x.totalShortfall, 0),
      shortfallProbability: cells[i].reduce((sum, x, j) => sum + (feasible(x) ? 0 : weights[j]), 0) / wSum,
    };
  });
  rows.sort((a, b) => (a.totalShortfall > 100 ? 1 : 0) - (b.totalShortfall > 100 ? 1 : 0) || a.maxRegret - b.maxRegret || b.average - a.average);

  return {
    scenarios,
    probabilities: weights.map((w) => w / wSum),
    rows,
    bestPerScenario: scenarios.map((d, j) => ({ scenario: d.label, label: best[j].label, estate: best[j].afterTaxEstate, estateNominal: best[j].nominal.afterTaxEstate })),
  };
}

// ---------------------------------------------------------------------------
// Comparaison selon la durée de vie probable des deux conjoints
// ---------------------------------------------------------------------------

export interface LongevityOptions extends CompareOptions {
  lifeExpectancy65: [number, number]; // espérance de vie à 65 ans de chaque conjoint
  states?: number; // âges de décès testés par conjoint (défaut 5 : 10 %, 30 %, 50 %, 70 % et 90 %)
}

/**
 * Cas de décès où les deux conjoints varient : chacun est testé à `states` âges représentatifs de sa durée
 * de vie probable (modèle de Gompertz calé sur l'espérance de vie à 65 ans), et les deux décès se combinent
 * (états x états cas, décès indépendants, poids égaux). L'ordre des décès en découle : le plus tôt est le premier.
 */
export function longevityScenarios(s: Scenario, opts: LongevityOptions): DeathScenario[] {
  const states = opts.states ?? 5;
  const ages = s.spouses.map((sp, i) =>
    representativeDeathAges(gompertz(opts.lifeExpectancy65[i]), s.assumptions.startYear - sp.birthYear, states, s.assumptions.endAge));
  const label = (i: number, a: number | undefined) => (a === undefined ? `${s.spouses[i].name} jusqu'à la fin du plan` : `${s.spouses[i].name} ${a} ans`);
  const out: DeathScenario[] = [];
  for (const a0 of ages[0]) for (const a1 of ages[1]) out.push({ label: `${label(0, a0)}, ${label(1, a1)}`, deathAges: [a0, a1] });
  return out;
}

/** Compare les stratégies quand l'âge des deux décès varie, avec le même classement que `compareDeathOrders`. */
export function compareLongevity(s: Scenario, tax: TaxYearTable, candidates: LabeledStrategy[] = defaultCandidates(), opts: LongevityOptions): DeathOrderComparison {
  const scenarios = longevityScenarios(s, opts);
  return evaluateScenarios(s, tax, candidates, scenarios, scenarios.map(() => 1), opts);
}
