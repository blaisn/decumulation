// Compare les stratégies de retrait (dont la fonte du REER) sur un couple fictif.  Lancer :  npm run example
import table2026 from "../src/engine/data/tax-2026.json";
import { compareStrategies, compareDeathOrders } from "../src/index";
import type { Scenario, SpouseInput, TaxYearTable } from "../src/index";

const tax = table2026 as unknown as TaxYearTable;

const spouse = (birthYear: number, db: number, reer: number, celi: number, deathAge?: number): SpouseInput => ({
  name: `Conjoint ${birthYear}`,
  birthYear,
  dbPensions: [{ label: "Régime à prestations déterminées", annualAmount: db, startAge: 62, indexation: 0.02, survivorPct: 0.6 }],
  rrq: { annualAmount: 14000, startAge: 65 },
  psv: { annualAmount: 8700, startAge: 65 },
  reer, celi, deathAge,
  celiRoom: 40000, // droits de cotisation CELI inutilisés
});

const scenario: Scenario = {
  spouses: [spouse(1960, 45000, 900000, 100000, 82), spouse(1962, 25000, 900000, 100000)], // le premier conjoint décède à 82 ans
  targetNetSpending: 130000, // dépenses nettes du ménage, en $ de 2026
  assumptions: { startYear: 2026, endAge: 95, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 },
};

const n = (x: number) => Math.round(x).toLocaleString("fr-CA").padStart(10);
console.log("Montants cumulés en $ de 2026\n");
console.log("stratégie".padEnd(46), "impôt".padStart(10), "récup.PSV".padStart(10), "succession".padStart(10), " années de manque");
for (const r of compareStrategies(scenario, tax)) {
  console.log(r.label.padEnd(46), n(r.totalTax), n(r.totalClawback), n(r.afterTaxEstate), "  ", r.yearsWithShortfall);
}

// Robustesse selon l'ordre et l'âge des décès (les `deathAge` du scénario sont remplacés par chaque cas).
// Compter quelques secondes : chaque stratégie est exécutée dans chaque cas.
const k = (x: number) => Math.round(x / 1000).toString().padStart(6);
const orders = compareDeathOrders(scenario, tax);
console.log("\nMeilleure stratégie par cas de décès (succession après impôt, k$)");
for (const b of orders.bestPerScenario) console.log(" ", b.scenario.padEnd(40), k(b.estate), " ", b.label);
console.log("\nStratégies les plus robustes (k$)".padEnd(48), "moyenne".padStart(8), "pire cas".padStart(9), "regret max".padStart(11));
for (const r of orders.rows.slice(0, 5)) console.log(r.label.padEnd(47), k(r.average).padStart(8), k(r.worst).padStart(9), k(r.maxRegret).padStart(11));
