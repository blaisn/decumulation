import type { Bracket, TaxYearTable } from "./types";

/** Situation fiscale d'une personne pour l'année. */
export interface Taxpayer {
  age: number; // âge au 31 décembre
  income: number; // revenu net avant fractionnement
  eligiblePension: number; // revenu de pension admissible (rente RPA, FERR à 65+)
  psv?: number; // PSV reçue dans l'année (incluse dans `income`)
  livingAlone?: boolean; // Québec : montant pour personne vivant seule (survivant)
}

export interface HouseholdTaxResult {
  tax: [number, number]; // fédéral + Québec, par conjoint
  federal: [number, number];
  quebec: [number, number];
  incomeAfterSplit: [number, number]; // avant déduction de la récupération de la PSV
  clawback: [number, number]; // récupération fiscale de la PSV (hors impôt)
  splitAmount: [number, number]; // + reçu / − cédé
  marginal: [number, number]; // taux marginal combiné de chaque conjoint (voir `marginalRate`)
}

const pair = (a: number[]): [number, number] => [a[0], a[1] ?? 0];

export function progressiveTax(income: number, brackets: Bracket[]): number {
  let tax = 0;
  let prev = 0;
  for (const { upTo, rate } of brackets) {
    if (income <= prev) break;
    tax += (Math.min(income, upTo ?? Infinity) - prev) * rate;
    prev = upTo ?? Infinity;
  }
  return tax;
}

/**
 * Taux marginal statutaire combiné pour un revenu imposable : taux du palier fédéral (après l'abattement du Québec)
 * plus taux du palier du Québec, pour le prochain dollar gagné. Il ne tient pas compte de la récupération de la PSV
 * ni de la réduction des montants en raison de l'âge, qui s'ajoutent dans certaines zones de revenu.
 */
export function marginalRate(income: number, t: TaxYearTable): number {
  const rateOf = (bs: Bracket[]) => (bs.find((b) => b.upTo === null || income < b.upTo) ?? bs[bs.length - 1]).rate;
  return rateOf(t.federal.brackets) * (1 - t.federal.quebecAbatement) + rateOf(t.quebec.brackets);
}

/** Indexe paliers, montants personnels et seuils par un facteur (inflation cumulée). */
export function indexTable(t: TaxYearTable, f: number): TaxYearTable {
  const idx = (bs: Bracket[]) => bs.map((b) => ({ ...b, upTo: b.upTo === null ? null : b.upTo * f }));
  const age = (a: TaxYearTable["federal"]["ageAmount"]) => ({ ...a, max: a.max * f, threshold: a.threshold * f });
  return {
    ...t,
    // Le montant fédéral pour revenu de pension (2 000 $) n'est pas indexé.
    federal: { ...t.federal, psvClawback: { ...t.federal.psvClawback, threshold: t.federal.psvClawback.threshold * f }, brackets: idx(t.federal.brackets), basicPersonalAmount: t.federal.basicPersonalAmount * f, ageAmount: age(t.federal.ageAmount) },
    quebec: { ...t.quebec, brackets: idx(t.quebec.brackets), basicPersonalAmount: t.quebec.basicPersonalAmount * f, ageAmount: age(t.quebec.ageAmount), retirementIncomeAmount: t.quebec.retirementIncomeAmount * f, livingAloneAmount: t.quebec.livingAloneAmount * f },
  };
}

/** Applique les crédits; la partie inutilisée des crédits d'un conjoint réduit l'impôt de l'autre. */
function settle(gross: number[], credits: number[], abatement = 0): number[] {
  const two = gross.length === 2;
  const rem = gross.map((g, i) => Math.max(0, g - credits[i]));
  const unused = gross.map((g, i) => Math.max(0, credits[i] - g));
  return rem.map((r, i) => Math.max(0, r - (two ? unused[1 - i] : 0)) * (1 - abatement));
}

/**
 * Impôt d'un ménage (deux conjoints) ou d'une personne seule (`p[1] = null`).
 * `transfer` : fractionnement du revenu de pension (montant cédé de `from` à l'autre conjoint).
 */
export function householdTax(p: [Taxpayer, Taxpayer | null], t: TaxYearTable, transfer?: { from: 0 | 1; amount: number }): HouseholdTaxResult {
  const people = (p[1] ? [p[0], p[1]] : [p[0]]).map((x) => ({ ...x }));
  const two = people.length === 2;
  const splitAmount = [0, 0];
  if (two && transfer && transfer.amount > 0) {
    const to = 1 - transfer.from;
    people[transfer.from].income -= transfer.amount;
    people[transfer.from].eligiblePension -= transfer.amount;
    people[to].income += transfer.amount;
    people[to].eligiblePension += transfer.amount;
    splitAmount[transfer.from] = -transfer.amount;
    splitAmount[to] = transfer.amount;
  }

  // Récupération fiscale de la PSV : 15 % du revenu net au-dessus du seuil, plafonnée à la PSV reçue.
  // Le montant remboursé est déductible du revenu net (fédéral et Québec).
  const C = t.federal.psvClawback;
  const incomeAfterSplit = people.map((x) => x.income);
  const clawback = people.map((x) => Math.min(Math.max(0, x.psv ?? 0), C.rate * Math.max(0, x.income - C.threshold)));
  people.forEach((x, i) => { x.income -= clawback[i]; });

  // Fédéral : crédits individuels (montant personnel, âge, pension), non utilisés transférables au conjoint.
  const F = t.federal;
  const fedCredits = people.map((x) => {
    const age = x.age >= 65 ? Math.max(0, F.ageAmount.max - F.ageAmount.reductionRate * Math.max(0, x.income - F.ageAmount.threshold)) : 0;
    const pension = Math.min(F.pensionIncomeAmount, Math.max(0, x.eligiblePension));
    return (F.basicPersonalAmount + age + pension) * F.creditRate;
  });
  const federal = settle(people.map((x) => progressiveTax(x.income, F.brackets)), fedCredits, F.quebecAbatement);

  // Québec : les montants en raison de l'âge, pour personne vivant seule et pour revenus de retraite
  // des deux conjoints forment UN seul montant, réduit UNE fois selon le revenu familial net.
  const Q = t.quebec;
  const familyIncome = people.reduce((sum, x) => sum + x.income, 0);
  const pool = people.reduce(
    (sum, x) => sum + (x.age >= 65 ? Q.ageAmount.max : 0) + Math.min(Q.retirementIncomeAmount, 1.25 * Math.max(0, x.eligiblePension)) + (x.livingAlone ? Q.livingAloneAmount : 0),
    0,
  );
  const poolCredit = Math.max(0, pool - Q.ageAmount.reductionRate * Math.max(0, familyIncome - Q.ageAmount.threshold)) * Q.creditRate;
  const basicCredit = Q.basicPersonalAmount * Q.creditRate;
  const grossQ = people.map((x) => progressiveTax(x.income, Q.brackets));
  // Le montant personnel inutilisé d'un conjoint est transférable; le montant commun s'applique à l'impôt le plus élevé d'abord.
  const r = settle(grossQ, people.map(() => basicCredit));
  let left = poolCredit;
  for (const i of two && r[1] > r[0] ? [1, 0] : [0, 1]) {
    if (i >= r.length) continue;
    const use = Math.min(left, r[i]);
    r[i] -= use; left -= use;
  }
  const quebec = r;

  return {
    tax: pair(federal.map((f, i) => f + quebec[i])),
    federal: pair(federal), quebec: pair(quebec),
    incomeAfterSplit: pair(incomeAfterSplit), clawback: pair(clawback),
    splitAmount: pair(splitAmount),
    marginal: pair(people.map((x) => marginalRate(x.income, t))),
  };
}

/**
 * Fractionnement du revenu de pension (règles fédérale et québécoise) :
 * - le conjoint qui cède peut transférer au plus 50 % de sa pension admissible de l'année (`eligiblePension` : rentes de régime
 *   de pension agréé à tout âge; retraits de REER/FERR seulement à partir de 65 ans; jamais la RRQ ni la PSV);
 * - l'âge de celui qui reçoit n'a pas d'importance.
 * L'admissibilité (âge, nature du revenu) est établie par l'appelant, qui fournit `eligiblePension`; ici on applique le plafond.
 */
export const MAX_SPLIT_SHARE = 0.5;
export const splitCap = (p: Taxpayer) => Math.max(0, p.eligiblePension) * MAX_SPLIT_SHARE;

const GRID_PCT = 2;      // pas de la grille, en % de la pension admissible

/**
 * Écart d'impôt (en $ par année) qu'on accepte pour que celui qui reçoit ne change pas de palier : voir `optimizeSplit`.
 * Négligeable (de l'ordre du dollar par année) devant les montants du plan.
 */
export const SPLIT_TOLERANCE = 5;

/**
 * Choisit le fractionnement qui minimise l'impôt total + la récupération de la PSV, dans un sens ou l'autre, jusqu'au plafond de 50 %.
 *
 * 1. Grille de 2 % de la pension admissible, puis raffinement autour du meilleur point (pas décroissants jusqu'à 0,50 $) :
 *    la fonction d'impôt est linéaire par morceaux, son minimum se trouve à un changement de palier ou de crédit, et une grille
 *    seule le dépassait de jusqu'à un pas (le raffinement le place au dollar près, avec moins d'évaluations qu'une grille de 1 %).
 * 2. Égalité des taux marginaux : si, au minimum, celui qui reçoit se retrouve à un taux marginal (statutaire) supérieur à celui
 *    de celui qui cède, on réduit le fractionnement au montant qui les égalise, pourvu que l'impôt n'augmente pas de plus de
 *    `tolerance`. Au-delà, le transfert qui change de palier reste le meilleur (par exemple à cause de la disparition progressive
 *    du montant en raison de l'âge ou de la récupération de la PSV, qui font différer les taux effectifs des taux statutaires).
 */
export function optimizeSplit(p: [Taxpayer, Taxpayer], t: TaxYearTable, tolerance = SPLIT_TOLERANCE): HouseholdTaxResult {
  const cost = (r: HouseholdTaxResult) => r.tax[0] + r.tax[1] + r.clawback[0] + r.clawback[1];
  let best = householdTax(p, t);
  let bestCost = cost(best), bestFrom: 0 | 1 = 0, bestAmount = 0;

  // 1) grille de 2 % de la pension admissible
  for (const from of [0, 1] as const) {
    const cap = splitCap(p[from]);
    if (cap <= 0) continue;
    for (let pct = GRID_PCT; pct <= 50; pct += GRID_PCT) {
      const amount = (cap * pct) / 50;                      // pct % de la pension admissible (le plafond en est 50 %)
      const r = householdTax(p, t, { from, amount });
      const c = cost(r);
      if (c < bestCost - 0.005) { best = r; bestCost = c; bestFrom = from; bestAmount = amount; }
    }
  }
  if (bestAmount <= 0) return best;

  // raffinement local : pas décroissants autour du meilleur montant
  const cap = splitCap(p[bestFrom]);
  let step = (cap * GRID_PCT) / 50;
  while (step > 0.5) {
    let improved = false;
    for (const amount of [bestAmount - step, bestAmount + step]) {
      if (amount <= 0 || amount > cap + 1e-9) continue;
      const r = householdTax(p, t, { from: bestFrom, amount });
      const c = cost(r);
      if (c < bestCost - 1e-9) { best = r; bestCost = c; bestAmount = amount; improved = true; }
    }
    if (!improved) step /= 2;
  }

  // 2) égalité des taux marginaux
  const to = (1 - bestFrom) as 0 | 1;
  const crosses = (r: HouseholdTaxResult) => r.marginal[to] > r.marginal[bestFrom] + 1e-9;
  if (crosses(best) && !crosses(householdTax(p, t))) {
    // Les taux de celui qui reçoit ne baissent jamais et ceux de celui qui cède ne montent jamais quand le montant diminue :
    // le plus grand montant qui ne les inverse pas se trouve par bissection.
    let lo = 0, hi = bestAmount;
    for (let k = 0; k < 40 && hi - lo > 0.01; k++) {
      const mid = (lo + hi) / 2;
      if (crosses(householdTax(p, t, { from: bestFrom, amount: mid }))) hi = mid; else lo = mid;
    }
    if (lo > 0) {
      const r = householdTax(p, t, { from: bestFrom, amount: lo });
      if (cost(r) <= bestCost + tolerance) best = r;
    }
  }
  return best;
}
