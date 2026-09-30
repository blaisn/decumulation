import type { Scenario, YearResult } from "../../src/index";

const HEADERS = [
  "Année", "Conjoint", "Âge", "En vie", "Rente de régime de retraite", "RRQ", "PSV", "Retraits REER/FERR", "Retraits CELI",
  "Retraits non enregistré", "Rendement imposable non enregistré", "Fractionnement (reçu + / cédé −)", "Revenu imposable",
  "Impôt", "Récupération de la PSV", "Cotisation CELI", "Cotisation non enregistré", "Solde REER/FERR", "Solde CELI", "Solde non enregistré", "Indice d'inflation (départ = 1)", "Taux marginal (%)",
];

const csvCell = (v: string | number) => {
  const t = typeof v === "number" ? String(Math.round(v)) : v;
  return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/**
 * Détail du plan, une ligne par conjoint et par année, en dollars courants (avec l'inflation).
 * L'avant-dernière colonne permet de revenir aux dollars de l'année de départ : diviser un montant par l'indice.
 * Séparateur « ; » et virgule décimale pour Excel en français.
 */
export function planToCsv(s: Scenario, rows: YearResult[]): string {
  const lines = [HEADERS.join(";")];
  const index = (year: number) => Math.pow(1 + s.assumptions.inflation, year - s.assumptions.startYear).toFixed(4).replace(".", ",");
  for (const y of rows) {
    y.spouses.forEach((sp, i) => {
      lines.push([
        y.year, s.spouses[i].name, sp.age, sp.alive ? "oui" : "non", sp.pensionIncome, sp.rrqIncome, sp.psvIncome, sp.reerWithdrawal, sp.celiWithdrawal,
        sp.nonRegWithdrawal, sp.nonRegIncome, sp.pensionSplit, sp.taxableIncome, sp.tax, sp.psvClawback, sp.celiContribution, sp.nonRegContribution,
        sp.reerBalanceEnd, sp.celiBalanceEnd, sp.nonRegBalanceEnd, index(y.year), (sp.marginalRate * 100).toFixed(2).replace(".", ","),
      ].map(csvCell).join(";"));
    });
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
