import type { Scenario, YearResult } from "../../src/index";

type Spouse = YearResult["spouses"][0];

/** Ce dont une colonne a besoin pour calculer la valeur d'une ligne (un conjoint, une année). */
interface Row { year: number; name: string; sp: Spouse; index: string }

/**
 * Colonnes du CSV, dans l'ordre du tableau « Détail annuel » : toutes ses colonnes s'y retrouvent, dans le même ordre.
 * Les colonnes propres au CSV (identification du conjoint, rendement imposable du non enregistré, part des dépenses, indice
 * d'inflation) sont placées à côté de ce à quoi elles se rapportent. En-tête et valeur sont définis ensemble pour ne pas se décaler.
 */
const COLUMNS: { header: string; value: (r: Row) => string | number }[] = [
  { header: "Année", value: (r) => r.year },
  { header: "Conjoint", value: (r) => r.name },
  { header: "Âge", value: (r) => r.sp.age },
  { header: "En vie", value: (r) => (r.sp.alive ? "oui" : "non") },
  { header: "Rente de régime de retraite", value: (r) => r.sp.pensionIncome },
  { header: "RRQ", value: (r) => r.sp.rrqIncome },
  { header: "PSV", value: (r) => r.sp.psvIncome },
  { header: "Retraits REER/FERR", value: (r) => r.sp.reerWithdrawal },
  { header: "Retraits CELI", value: (r) => r.sp.celiWithdrawal },
  { header: "Retraits non enregistré", value: (r) => r.sp.nonRegWithdrawal },
  { header: "Rendement imposable non enregistré", value: (r) => r.sp.nonRegIncome },
  { header: "Vente d'immeubles", value: (r) => r.sp.propertyProceeds },
  { header: "Gain en capital imposable", value: (r) => r.sp.taxableCapitalGain },
  // Espace CELI (droits de cotisation disponibles), juste avant la cotisation qui l'utilise. Seulement dans le CSV.
  { header: "Espace CELI", value: (r) => r.sp.celiRoom },
  { header: "Cotisation CELI", value: (r) => r.sp.celiContribution },
  { header: "Cotisation non enregistré", value: (r) => r.sp.nonRegContribution },
  { header: "Récupération de la PSV", value: (r) => r.sp.psvClawback },
  { header: "Fractionnement (reçu + / cédé −)", value: (r) => r.sp.pensionSplit },
  { header: "Revenu imposable", value: (r) => r.sp.taxableIncome },
  { header: "Taux marginal (%)", value: (r) => (r.sp.marginalRate * 100).toFixed(2).replace(".", ",") },
  { header: "Impôt", value: (r) => r.sp.tax },
  { header: "Dépenses visées", value: (r) => r.sp.spending },
  { header: "Dépenses supp.", value: (r) => r.sp.extraSpending },
  { header: "Part des dépenses (%)", value: (r) => (r.sp.spendingShare * 100).toFixed(2).replace(".", ",") },
  { header: "Manque", value: (r) => r.sp.shortfall },
  { header: "Solde REER/FERR", value: (r) => r.sp.reerBalanceEnd },
  { header: "Solde CELI", value: (r) => r.sp.celiBalanceEnd },
  { header: "Solde non enregistré", value: (r) => r.sp.nonRegBalanceEnd },
  { header: "Indice d'inflation (départ = 1)", value: (r) => r.index },
];

export const CSV_HEADERS = COLUMNS.map((c) => c.header);

const csvCell = (v: string | number) => {
  const t = typeof v === "number" ? String(Math.round(v)) : v;
  return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/**
 * Détail du plan, une ligne par conjoint et par année, en dollars courants (avec l'inflation).
 * La dernière colonne permet de revenir aux dollars de l'année de départ : diviser un montant par l'indice.
 * Le manque de chaque conjoint est sa part du manque du ménage, répartie selon sa part des dépenses.
 * Séparateur « ; » et virgule décimale pour Excel en français.
 */
export function planToCsv(s: Scenario, rows: YearResult[]): string {
  const lines = [CSV_HEADERS.join(";")];
  const index = (year: number) => Math.pow(1 + s.assumptions.inflation, year - s.assumptions.startYear).toFixed(4).replace(".", ",");
  for (const y of rows) {
    y.spouses.forEach((sp, i) => {
      const r: Row = { year: y.year, name: s.spouses[i].name, sp, index: index(y.year) };
      lines.push(COLUMNS.map((c) => csvCell(c.value(r))).join(";"));
    });
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
