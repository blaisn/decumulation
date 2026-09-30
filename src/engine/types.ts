// Tous les montants sont en dollars de l'année de départ du plan (startYear).

export interface Bracket {
  upTo: number | null; // null = sans limite
  rate: number;
}

export interface AgeAmount {
  max: number; // montant maximal (65 ans et plus)
  threshold: number; // seuil de revenu où commence la réduction
  reductionRate: number;
}

export interface JurisdictionTax {
  brackets: Bracket[];
  basicPersonalAmount: number;
  creditRate: number; // taux du crédit non remboursable
  ageAmount: AgeAmount;
}

export interface TaxYearTable {
  year: number;
  federal: JurisdictionTax & {
    quebecAbatement: number;
    pensionIncomeAmount: number;
    psvClawback: { threshold: number; rate: number }; // récupération fiscale de la PSV
  };
  quebec: JurisdictionTax & { retirementIncomeAmount: number; livingAloneAmount: number };
}

export interface DbPension {
  label: string;
  annualAmount: number;
  startAge: number;
  indexation: number; // ex. 0.02
  survivorPct: number; // % de la rente versé au survivant (TODO: décès)
}

export interface PublicBenefit {
  annualAmount: number; // montant annuel au départ choisi
  startAge: number;
}

export interface SpouseInput {
  name: string;
  birthYear: number;
  dbPensions: DbPension[];
  rrq: PublicBenefit;
  psv: PublicBenefit;
  reer: number; // solde REER/FERR
  celi: number;
  nonRegistered?: number; // compte non enregistré (défaut 0)
  celiRoom?: number; // droits de cotisation CELI inutilisés au 1er janvier de startYear (défaut 0)
  deathAge?: number; // âge au décès, en fin d'année (absent = vit jusqu'à la fin du plan)
}

export interface Assumptions {
  startYear: number;
  endAge: number; // le plan s'arrête quand le plus jeune dépasse cet âge
  inflation: number;
  rrqIndexation: number;
  psvIndexation: number;
  reerReturn: number;
  celiReturn: number;
  nonRegReturn?: number; // rendement du compte non enregistré (défaut : reerReturn)
  nonRegTaxedShare?: number; // part du rendement imposée chaque année, versée en argent (défaut 0,5)
  celiAnnualLimit?: number; // plafond annuel de cotisation au CELI en $ de startYear (défaut 7 000)
  survivorSpendingRatio?: number; // dépenses du survivant / dépenses du couple (défaut 0,75)
  rrqSurvivorCap?: number; // rente RRQ maximale combinée du survivant, $ de startYear (défaut 17 295)
}

/**
 * Ordre de financement des dépenses, après les revenus garantis et les retraits FERR minimums :
 * - reer-first : REER/FERR d'abord, puis CELI
 * - celi-first : CELI d'abord, puis REER/FERR
 * - ceiling : REER/FERR jusqu'à un revenu plafond par conjoint (en $ de startYear, ou le seuil de
 *   récupération de la PSV), puis CELI, puis REER/FERR au-delà du plafond
 * - meltdown : « fonte » du REER/FERR. Chaque année, retire du REER/FERR jusqu'au revenu plafond
 *   même si les dépenses sont déjà couvertes (tant que le conjoint a `untilAge` ans ou moins), puis
 *   verse le surplus net au CELI (dans la limite des droits) et le reste au compte non enregistré
 *
 * Les comptes non enregistrés servent avant le CELI, sauf avec celi-first.
 */
export type Strategy =
  | { kind: "reer-first" }
  | { kind: "celi-first" }
  | { kind: "ceiling"; ceiling: number | "psv-threshold" }
  | { kind: "meltdown"; ceiling: number | "psv-threshold"; untilAge?: number };

export interface Scenario {
  spouses: [SpouseInput, SpouseInput];
  targetNetSpending: number; // dépenses nettes du ménage, indexées à l'inflation
  assumptions: Assumptions;
  strategy?: Strategy; // défaut : reer-first
}

export interface SpouseYear {
  age: number;
  alive: boolean;
  guaranteedIncome: number; // = pensionIncome + rrqIncome + psvIncome
  pensionIncome: number; // rentes de régimes à prestations déterminées (y compris rente de survivant)
  rrqIncome: number;
  psvIncome: number;
  reerWithdrawal: number;
  celiWithdrawal: number;
  taxableIncome: number; // après fractionnement et déduction de la récupération de la PSV
  psvClawback: number; // récupération fiscale de la PSV (montant remboursé)
  pensionSplit: number; // + reçu du conjoint / − cédé au conjoint
  tax: number;
  reerBalanceEnd: number;
  celiBalanceEnd: number;
  nonRegIncome: number; // part imposable du rendement du compte non enregistré (incluse dans le revenu imposable)
  nonRegWithdrawal: number;
  celiContribution: number;
  nonRegContribution: number;
  nonRegBalanceEnd: number;
}

export interface YearResult {
  year: number;
  spouses: [SpouseYear, SpouseYear];
  targetSpending: number;
  netIncome: number;
  shortfall: number; // > 0 = objectif non atteint
}
