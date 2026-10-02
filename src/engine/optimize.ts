import { PSV_AGES, RRQ_AGES } from "./benefits";
import { summarize, type CompareOptions } from "./compare";
import { runProjection } from "./projection";
import type { Scenario, TaxYearTable } from "./types";

// Optimisation de l'âge de début de la RRQ et de la PSV de chaque conjoint.
//
// On essaie toutes les combinaisons d'âges (jusqu'à 13 x 6 pour chaque conjoint) en gardant le reste du scénario tel quel
// (stratégie de retrait, fractionnement, décès éventuels), et on classe les résultats :
//   1. les combinaisons qui financent toutes les dépenses, par succession après impôt décroissante (placements restants à la fin);
//   2. puis, si aucune ne finance tout, par manque cumulé croissant.

/** Âge de début de chaque rente, par conjoint : [conjoint 1, conjoint 2]. */
export interface BenefitChoice {
  rrq: [number, number];
  psv: [number, number];
}

/** Quelles décisions explorer. Une rente décochée garde l'âge du scénario. */
export interface FreeChoices {
  rrq: [boolean, boolean];
  psv: [boolean, boolean];
}

export const ALL_FREE: FreeChoices = { rrq: [true, true], psv: [true, true] };

/** Âges possibles de chaque rente, par conjoint. */
export interface BenefitRanges {
  rrq: [number[], number[]];
  psv: [number[], number[]];
}

export type BenefitKind = "rrq" | "psv";

export function currentChoice(s: Scenario): BenefitChoice {
  return { rrq: [s.spouses[0].rrq.startAge, s.spouses[1].rrq.startAge], psv: [s.spouses[0].psv.startAge, s.spouses[1].psv.startAge] };
}

/** Copie du scénario avec les âges de début de la combinaison. */
export function applyChoice(s: Scenario, c: BenefitChoice): Scenario {
  const sp = (i: 0 | 1) => ({ ...s.spouses[i], rrq: { ...s.spouses[i].rrq, startAge: c.rrq[i] }, psv: { ...s.spouses[i].psv, startAge: c.psv[i] } });
  return { ...s, spouses: [sp(0), sp(1)] };
}

export const choiceKey = (c: BenefitChoice) => `${c.rrq[0]}-${c.psv[0]}|${c.rrq[1]}-${c.psv[1]}`;

/** Âge du conjoint dans l'année de départ du plan (on peut commencer une rente dès cette année-là). */
export const ageAtStart = (s: Scenario, i: 0 | 1) => s.assumptions.startYear - s.spouses[i].birthYear;

/** Âge du conjoint la dernière année du plan, si le plus jeune vit jusqu'à la fin. */
export function ageAtPlanEnd(s: Scenario, i: 0 | 1): number {
  const youngestBirth = Math.max(s.spouses[0].birthYear, s.spouses[1].birthYear);
  return youngestBirth + s.assumptions.endAge - s.spouses[i].birthYear;
}

/**
 * Âges à essayer pour une rente d'un conjoint.
 * - Une rente décochée, ou déjà commencée (son âge de début est passé), garde son âge.
 * - Sinon, de l'âge actuel (ou de l'âge minimum de la rente) jusqu'à l'âge maximum de report, sans dépasser l'âge du conjoint
 *   à la fin du plan (plus tard, la rente ne serait jamais versée). L'âge du scénario est toujours inclus.
 */
export function ageOptions(s: Scenario, i: 0 | 1, kind: BenefitKind, free = true): number[] {
  const current = s.spouses[i][kind].startAge;
  const now = ageAtStart(s, i);
  if (!free || current < now) return [current];
  const { min, max } = kind === "rrq" ? RRQ_AGES : PSV_AGES;
  const from = Math.max(min, now);
  const to = Math.max(Math.min(max, ageAtPlanEnd(s, i)), from);
  const out: number[] = [];
  for (let a = from; a <= to; a++) out.push(a);
  if (!out.includes(current)) out.push(current);
  return out.sort((x, y) => x - y);
}

export function benefitRanges(s: Scenario, free: FreeChoices = ALL_FREE): BenefitRanges {
  return {
    rrq: [ageOptions(s, 0, "rrq", free.rrq[0]), ageOptions(s, 1, "rrq", free.rrq[1])],
    psv: [ageOptions(s, 0, "psv", free.psv[0]), ageOptions(s, 1, "psv", free.psv[1])],
  };
}

export const countChoices = (r: BenefitRanges) => r.rrq[0].length * r.psv[0].length * r.rrq[1].length * r.psv[1].length;

/** Toutes les combinaisons : conjoint 1 (RRQ, PSV) x conjoint 2 (RRQ, PSV). */
export function enumerateChoices(r: BenefitRanges): BenefitChoice[] {
  const out: BenefitChoice[] = [];
  for (const r0 of r.rrq[0]) for (const p0 of r.psv[0]) for (const r1 of r.rrq[1]) for (const p1 of r.psv[1]) out.push({ rrq: [r0, r1], psv: [p0, p1] });
  return out;
}

/** Résultat d'une combinaison : en dollars de départ (constants), avec la version en dollars courants. */
export interface ChoiceResult {
  choice: BenefitChoice;
  key: string;
  afterTaxEstate: number; // placements restants à la fin, après impôt présumé
  totalShortfall: number; // somme des manques
  yearsWithShortfall: number;
  totalTax: number;
  totalClawback: number;
  nominal: { afterTaxEstate: number; totalShortfall: number; totalTax: number; totalClawback: number };
}

export function evaluateChoice(s: Scenario, tax: TaxYearTable, c: BenefitChoice, opts: CompareOptions = {}): ChoiceResult {
  const sc = applyChoice(s, c);
  const x = summarize("", sc.strategy ?? { kind: "reer-first" }, runProjection(sc, tax), sc.assumptions, opts);
  const { afterTaxEstate, totalShortfall, totalTax, totalClawback, yearsWithShortfall } = x;
  return {
    choice: c, key: choiceKey(c), afterTaxEstate, totalShortfall, yearsWithShortfall, totalTax, totalClawback,
    nominal: { afterTaxEstate: x.nominal.afterTaxEstate, totalShortfall: x.nominal.totalShortfall, totalTax: x.nominal.totalTax, totalClawback: x.nominal.totalClawback },
  };
}

export function evaluateChoices(s: Scenario, tax: TaxYearTable, cs: BenefitChoice[], opts: CompareOptions = {}, onEach?: (done: number) => void): ChoiceResult[] {
  return cs.map((c, k) => { const r = evaluateChoice(s, tax, c, opts); onEach?.(k + 1); return r; });
}

/** Seuil sous lequel un manque cumulé (en $ de départ) est négligé : le même que pour la comparaison des stratégies. */
export const SHORTFALL_TOLERANCE = 100;
export const isFeasible = (r: ChoiceResult) => r.totalShortfall <= SHORTFALL_TOLERANCE;

/** Ordre de classement : les combinaisons qui financent tout d'abord (plus grande succession), puis celles qui manquent le moins. */
export function compareResults(a: ChoiceResult, b: ChoiceResult): number {
  const fa = isFeasible(a), fb = isFeasible(b);
  if (fa !== fb) return fa ? -1 : 1;
  if (fa) return b.afterTaxEstate - a.afterTaxEstate || a.totalTax - b.totalTax || a.key.localeCompare(b.key);
  return a.totalShortfall - b.totalShortfall || b.afterTaxEstate - a.afterTaxEstate || a.key.localeCompare(b.key);
}

export interface OptimizationResult {
  ranked: ChoiceResult[]; // meilleure combinaison en premier
  best: ChoiceResult;
  current: ChoiceResult; // les choix actuels du scénario
  currentRank: number; // rang des choix actuels, à partir de 1
  total: number;
  anyFeasible: boolean;
}

/** Classe les résultats et repère les choix actuels du scénario (qui doivent faire partie des combinaisons évaluées). */
export function rankResults(s: Scenario, results: ChoiceResult[]): OptimizationResult {
  const ranked = [...results].sort(compareResults);
  const key = choiceKey(currentChoice(s));
  const idx = ranked.findIndex((r) => r.key === key);
  if (idx < 0) throw new Error("Les choix actuels ne font pas partie des combinaisons évaluées.");
  return { ranked, best: ranked[0], current: ranked[idx], currentRank: idx + 1, total: ranked.length, anyFeasible: isFeasible(ranked[0]) };
}

/** Évalue toutes les combinaisons d'un coup (sans parallélisme) : utilisé par les tests et comme solution de secours. */
export function optimizeBenefits(s: Scenario, tax: TaxYearTable, opts: CompareOptions = {}, free: FreeChoices = ALL_FREE, onEach?: (done: number, total: number) => void): OptimizationResult {
  const choices = enumerateChoices(benefitRanges(s, free));
  return rankResults(s, evaluateChoices(s, tax, choices, opts, (d) => onEach?.(d, choices.length)));
}
