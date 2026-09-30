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

/** Choisit le fractionnement (0 à 50 % de la pension admissible, dans un sens ou l'autre) qui minimise l'impôt total + la récupération de la PSV. */
export function optimizeSplit(p: [Taxpayer, Taxpayer], t: TaxYearTable): HouseholdTaxResult {
  const cost = (r: HouseholdTaxResult) => r.tax[0] + r.tax[1] + r.clawback[0] + r.clawback[1];
  let best = householdTax(p, t);
  let bestTotal = cost(best);
  for (const from of [0, 1] as const) {
    for (let pct = 1; pct <= 50; pct++) {
      const amount = (Math.max(0, p[from].eligiblePension) * pct) / 100;
      if (amount <= 0) break;
      const r = householdTax(p, t, { from, amount });
      const total = cost(r);
      if (total < bestTotal - 0.005) { best = r; bestTotal = total; }
    }
  }
  return best;
}
