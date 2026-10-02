import { describe, it, expect } from "vitest";
import table2026 from "../src/engine/data/tax-2026.json";
import { progressiveTax, householdTax, optimizeSplit, indexTable, marginalRate } from "../src/engine/tax";
import { runProjection, dbAmount } from "../src/engine/projection";
import { compareStrategies, defaultCandidates, compareDeathOrders, deathScenarios, applyDeathScenario, summarize, compareLongevity, longevityScenarios } from "../src/engine/compare";
import { gompertz, representativeDeathAges } from "../src/engine/mortality";
import { PSV_AGES, RRQ_AGES, psvAmount, psvFactor, rrqAmount, rrqEarlyMonthlyRate, rrqFactor } from "../src/engine/benefits";
import { ALL_FREE, ageAtPlanEnd, applyChoice, benefitRanges, choiceKey, compareResults, countChoices, currentChoice, enumerateChoices, evaluateChoice, evaluateChoices, isFeasible, optimizeBenefits, rankResults } from "../src/engine/optimize";
import type { ChoiceResult, FreeChoices } from "../src/engine/optimize";
import type { Property, Scenario, TaxYearTable } from "../src/engine/types";

const tax = table2026 as unknown as TaxYearTable;
const total = (r: { tax: [number, number] }) => r.tax[0] + r.tax[1];

describe("impôt", () => {
  it("applique les taux par palier", () => {
    const b = [{ upTo: 100, rate: 0.1 }, { upTo: null, rate: 0.2 }];
    expect(progressiveTax(150, b)).toBeCloseTo(20);
  });
  it("aucun impôt sous le montant personnel de base", () => {
    const r = householdTax([{ age: 50, income: 10000, eligiblePension: 0 }, { age: 50, income: 0, eligiblePension: 0 }], tax);
    expect(total(r)).toBe(0);
  });
});

describe("crédits selon l'âge", () => {
  const person = (age: number) => [{ age, income: 40000, eligiblePension: 0 }, { age, income: 0, eligiblePension: 0 }] as const;
  it("le montant en raison de l'âge réduit l'impôt à 65 ans", () => {
    expect(total(householdTax([...person(65)] as any, tax))).toBeLessThan(total(householdTax([...person(64)] as any, tax)));
  });
  it("les montants d'âge disparaissent à revenu élevé (deux conjoints)", () => {
    const at = (age: number) => total(householdTax([{ age, income: 150000, eligiblePension: 0 }, { age, income: 150000, eligiblePension: 0 }], tax));
    expect(at(64) - at(65)).toBeCloseTo(0, 0);
  });
  it("le crédit non utilisé est transféré au conjoint", () => {
    const seul = householdTax([{ age: 66, income: 60000, eligiblePension: 0 }, { age: 66, income: 0, eligiblePension: 0 }], tax);
    const jeune = householdTax([{ age: 66, income: 60000, eligiblePension: 0 }, { age: 60, income: 0, eligiblePension: 0 }], tax);
    expect(total(seul)).toBeLessThan(total(jeune));
  });
});

describe("crédits du Québec", () => {
  const couple = (age: number, income: number, eligible = 0): [any, any] => [{ age, income, eligiblePension: eligible }, { age, income, eligiblePension: eligible }];
  it("le montant d'âge est réduit une seule fois au niveau du couple", () => {
    // revenu familial 60 000 $ : réduction unique de 18,75 % de l'excédent sur 42 955 $, crédit à 14 %
    const q = (age: number) => { const r = householdTax(couple(age, 30000), tax); return r.quebec[0] + r.quebec[1]; };
    const attendu = (2 * 3986 - 0.1875 * (60000 - 42955)) * 0.14;
    expect(q(64) - q(70)).toBeCloseTo(attendu, 2);
  });
  it("le montant pour revenus de retraite vaut 1,25 x le revenu, jusqu'au maximum", () => {
    const q = (elig: number) => { const r = householdTax([{ age: 66, income: 50000, eligiblePension: elig }, { age: 66, income: 50000, eligiblePension: 0 }], tax); return r.quebec[0] + r.quebec[1]; };
    expect(q(1000)).toBeGreaterThan(q(3000));
    expect(q(3000)).toBeCloseTo(q(5000), 6);
  });
  it("le montant pour personne vivant seule réduit l'impôt du survivant", () => {
    const seul = (livingAlone: boolean) => householdTax([{ age: 72, income: 40000, eligiblePension: 0, livingAlone }, null], tax).quebec[0];
    expect(seul(true)).toBeLessThan(seul(false));
  });
  it("le montant personnel inutilisé d'un conjoint est transféré", () => {
    const avec = householdTax([{ age: 50, income: 60000, eligiblePension: 0 }, { age: 50, income: 5000, eligiblePension: 0 }], tax);
    const seul = householdTax([{ age: 50, income: 60000, eligiblePension: 0 }, null], tax);
    expect(avec.tax[0]).toBeLessThan(seul.tax[0]);
  });
});

describe("fractionnement du revenu de pension", () => {
  const p = [{ age: 66, income: 80000, eligiblePension: 60000 }, { age: 66, income: 20000, eligiblePension: 0 }] as const;
  it("réduit l'impôt total et cède au plus 50 % de la pension", () => {
    const sans = householdTax([...p] as any, tax);
    const avec = optimizeSplit([...p] as any, tax);
    expect(total(avec)).toBeLessThan(total(sans));
    expect(avec.splitAmount[0]).toBeGreaterThanOrEqual(-30000);
    expect(avec.splitAmount[1]).toBeCloseTo(-avec.splitAmount[0]);
  });
  it("ne fait rien sans pension admissible", () => {
    const r = optimizeSplit([{ age: 66, income: 80000, eligiblePension: 0 }, { age: 66, income: 20000, eligiblePension: 0 }], tax);
    expect(r.splitAmount).toEqual([0, 0]);
  });
});

describe("récupération fiscale de la PSV", () => {
  const solo = (income: number, psv = 8700) => [{ age: 70, income, eligiblePension: 0, psv }, { age: 70, income: 0, eligiblePension: 0 }] as [any, any];
  it("aucune récupération sous le seuil", () => {
    expect(householdTax(solo(90000), tax).clawback[0]).toBe(0);
  });
  it("15 % de l'excédent au-dessus du seuil", () => {
    expect(householdTax(solo(105000), tax).clawback[0]).toBeCloseTo(0.15 * (105000 - 95323), 2);
  });
  it("plafonnée à la PSV reçue", () => {
    expect(householdTax(solo(200000), tax).clawback[0]).toBeCloseTo(8700, 2);
  });
  it("le seuil est indexé avec l'inflation", () => {
    const t = indexTable(tax, 1.1);
    expect(householdTax(solo(95323 * 1.1 + 1000), t).clawback[0]).toBeCloseTo(150, 0);
  });
  it("le fractionnement réduit la récupération du conjoint à revenu élevé", () => {
    const p: [any, any] = [{ age: 70, income: 130000, eligiblePension: 90000, psv: 8700 }, { age: 70, income: 30000, eligiblePension: 0, psv: 8700 }];
    const sans = householdTax(p, tax);
    const avec = optimizeSplit(p, tax);
    expect(avec.clawback[0] + avec.clawback[1]).toBeLessThan(sans.clawback[0] + sans.clawback[1]);
  });
});

describe("projection", () => {
  const spouse = (name: string, birthYear: number, db: number) => ({
    name, birthYear,
    dbPensions: [{ label: "RREGOP", annualAmount: db, startAge: 62, indexation: 0.02, survivorPct: 0.6 }],
    rrq: { annualAmount: 12000, startAge: 65 },
    psv: { annualAmount: 8700, startAge: 65 },
    reer: 300000, celi: 80000,
  });
  const scenario: Scenario = {
    spouses: [spouse("A", 1960, 50000), spouse("B", 1962, 10000)],
    targetNetSpending: 80000,
    assumptions: { startYear: 2026, endAge: 95, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 },
  };
  it("produit une ligne par année et des soldes non négatifs", () => {
    const r = runProjection(scenario, tax);
    expect(r.length).toBeGreaterThan(30);
    for (const y of r) for (const sp of y.spouses) {
      expect(sp.reerBalanceEnd).toBeGreaterThanOrEqual(0);
      expect(sp.celiBalanceEnd).toBeGreaterThanOrEqual(0);
    }
  });
  it("applique la récupération de la PSV quand les retraits font dépasser le seuil", () => {
    const rich: Scenario = {
      ...scenario,
      targetNetSpending: 220000,
      spouses: [{ ...scenario.spouses[0], reer: 2_000_000 }, { ...scenario.spouses[1], birthYear: 1960, reer: 2_000_000 }],
    };
    const first = runProjection(rich, tax).find((r) => r.spouses[0].age >= 66)!;
    expect(first.spouses[0].psvClawback + first.spouses[1].psvClawback).toBeGreaterThan(0);
    expect(first.shortfall).toBeCloseTo(0, 0);
  });
  it("évite la récupération en fractionnant vers un conjoint sans PSV", () => {
    const y = runProjection({ ...scenario, targetNetSpending: 150000, spouses: [{ ...scenario.spouses[0], reer: 2_000_000 }, { ...scenario.spouses[1], reer: 2_000_000 }] }, tax).find((r) => r.spouses[0].age >= 66)!;
    expect(y.spouses[0].psvClawback + y.spouses[1].psvClawback).toBe(0);
  });
  describe("décès du premier conjoint", () => {
    const withDeath: Scenario = { ...scenario, spouses: [{ ...scenario.spouses[0], deathAge: 80 }, scenario.spouses[1]] };
    const rows = runProjection(withDeath, tax);
    const deathYear = 1960 + 80;
    const before = rows.find((y) => y.year === deathYear)!;
    const after = rows.find((y) => y.year === deathYear + 1)!;
    it("le défunt n'a plus de revenus ni de comptes; le survivant est seul", () => {
      expect(before.spouses[0].alive).toBe(true);
      expect(after.spouses[0].alive).toBe(false);
      expect(after.spouses[0].reerBalanceEnd).toBe(0);
      expect(after.spouses[0].celiBalanceEnd).toBe(0);
      expect(after.spouses[1].pensionSplit).toBe(0);
    });
    it("le REER et le CELI passent au survivant en fin d'année du décès", () => {
      expect(before.spouses[0].reerBalanceEnd + before.spouses[0].celiBalanceEnd).toBe(0);
      const sansDeces = runProjection(scenario, tax).find((y) => y.year === deathYear)!;
      expect(before.spouses[1].reerBalanceEnd).toBeGreaterThan(sansDeces.spouses[1].reerBalanceEnd);
    });
    it("la rente du survivant s'ajoute et les dépenses baissent à 75 %", () => {
      expect(after.spouses[1].guaranteedIncome).toBeGreaterThan(before.spouses[1].guaranteedIncome + 0.5 * 50000);
      expect(after.targetSpending / before.targetSpending).toBeCloseTo(0.75 * 1.02, 6);
      expect(after.shortfall).toBeCloseTo(0, 0);
    });
    it("la RRQ combinée du survivant est plafonnée", () => {
      const rrqOnly: Scenario = {
        ...scenario,
        spouses: [
          { ...scenario.spouses[0], dbPensions: [], psv: { annualAmount: 0, startAge: 65 }, rrq: { annualAmount: 17000, startAge: 65 }, deathAge: 80 },
          { ...scenario.spouses[1], dbPensions: [], psv: { annualAmount: 0, startAge: 65 }, rrq: { annualAmount: 17000, startAge: 65 } },
        ],
      };
      const y = runProjection(rrqOnly, tax).find((r) => r.year === deathYear + 1)!;
      expect(y.spouses[1].guaranteedIncome).toBeCloseTo(17295 * Math.pow(1.02, deathYear + 1 - 2026), 0);
    });
    it("les soldes restent non négatifs jusqu'à la fin du plan", () => {
      for (const y of rows) for (const sp of y.spouses) {
        expect(sp.reerBalanceEnd).toBeGreaterThanOrEqual(0);
        expect(sp.celiBalanceEnd).toBeGreaterThanOrEqual(0);
      }
    });
  });
  describe("stratégies de retrait", () => {
    const rich: Scenario = {
      ...scenario,
      targetNetSpending: 220000,
      spouses: [{ ...scenario.spouses[0], reer: 2_000_000 }, { ...scenario.spouses[1], birthYear: 1960, reer: 2_000_000 }],
    };
    const first = (sc: Scenario) => runProjection(sc, tax).find((r) => r.spouses[0].age >= 66)!;
    it("reer-first est la stratégie par défaut", () => {
      const a = runProjection(scenario, tax);
      const b = runProjection({ ...scenario, strategy: { kind: "reer-first" } }, tax);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
    it("celi-first puise dans le CELI avant le REER", () => {
      const y = runProjection({ ...scenario, strategy: { kind: "celi-first" } }, tax)[0];
      expect(y.spouses[0].celiWithdrawal + y.spouses[1].celiWithdrawal).toBeGreaterThan(0);
      expect(y.spouses[0].reerWithdrawal + y.spouses[1].reerWithdrawal).toBe(0);
    });
    it("le plafond « seuil de la PSV » évite la récupération quand le CELI peut combler l'écart", () => {
      const sans = first(rich);
      const avec = first({ ...rich, strategy: { kind: "ceiling", ceiling: "psv-threshold" } });
      expect(sans.spouses[0].psvClawback + sans.spouses[1].psvClawback).toBeGreaterThan(0);
      expect(avec.spouses[0].psvClawback + avec.spouses[1].psvClawback).toBeLessThan(1);
      expect(avec.shortfall).toBeCloseTo(0, 0);
    });
    it("toutes les stratégies atteignent la dépense visée tant que les actifs suffisent", () => {
      for (const c of defaultCandidates()) {
        const y = runProjection({ ...scenario, strategy: c.strategy }, tax)[0];
        expect(y.shortfall).toBeCloseTo(0, 0);
      }
    });
    it("compareStrategies classe les stratégies et retourne des montants cohérents", () => {
      const r = compareStrategies(scenario, tax);
      expect(r.length).toBe(defaultCandidates().length);
      for (let i = 1; i < r.length; i++) {
        if (r[i - 1].totalShortfall <= 100 && r[i].totalShortfall <= 100) expect(r[i - 1].afterTaxEstate).toBeGreaterThanOrEqual(r[i].afterTaxEstate);
      }
      expect(r[0].totalTax).toBeGreaterThan(0);
    });
  });
  describe("fonte du REER et compte non enregistré", () => {
    const big = (over: Partial<Scenario["spouses"][0]> = {}) => ({ ...scenario.spouses[0], reer: 1_000_000, celi: 0, ...over });
    const melt: Scenario = {
      ...scenario,
      targetNetSpending: 60000,
      spouses: [big({ celiRoom: 10000 }), big({ birthYear: 1962, dbPensions: scenario.spouses[1].dbPensions, celiRoom: 10000 })],
    };
    const sum = (y: { spouses: readonly [any, any] }, k: string) => y.spouses[0][k] + y.spouses[1][k];
    it("retire plus que les besoins et verse le surplus au CELI puis au compte non enregistré", () => {
      const normal = runProjection(melt, tax)[0];
      const fonte = runProjection({ ...melt, strategy: { kind: "meltdown", ceiling: 90000 } }, tax)[0];
      expect(sum(fonte, "reerWithdrawal")).toBeGreaterThan(sum(normal, "reerWithdrawal") + 1000);
      expect(sum(fonte, "celiContribution")).toBeCloseTo(20000, 0); // droits épuisés
      expect(sum(fonte, "nonRegContribution")).toBeGreaterThan(0);
      expect(fonte.shortfall).toBeCloseTo(0, 0);
    });
    it("l'argent retiré se retrouve dans les comptes : aucun montant créé ni perdu", () => {
      // Sans rendement ni impôt de succession, REER + CELI + non enregistré + impôt cumulé + dépenses = mêmes actifs de départ + revenus garantis.
      const flat = { ...melt, assumptions: { ...melt.assumptions, inflation: 0, rrqIndexation: 0, psvIndexation: 0, reerReturn: 0, celiReturn: 0, nonRegReturn: 0, celiAnnualLimit: 0 } };
      const sc: Scenario = { ...flat, spouses: flat.spouses.map((x) => ({ ...x, dbPensions: x.dbPensions.map((d) => ({ ...d, indexation: 0 })) })) as Scenario["spouses"], strategy: { kind: "meltdown", ceiling: 90000 } };
      const rows = runProjection(sc, tax);
      const start = sc.spouses[0].reer + sc.spouses[1].reer;
      let income = 0, taxes = 0, spending = 0;
      for (const y of rows) {
        for (const sp of y.spouses) { income += sp.guaranteedIncome; taxes += sp.tax + sp.psvClawback; }
        spending += y.targetSpending - y.shortfall;
      }
      const last = rows[rows.length - 1];
      const end = sum(last, "reerBalanceEnd") + sum(last, "celiBalanceEnd") + sum(last, "nonRegBalanceEnd");
      expect(end + taxes + spending).toBeCloseTo(start + income, -1);
    });
    it("les cotisations au CELI respectent les droits annuels (arrondis à 500 $)", () => {
      const rows = runProjection({ ...melt, strategy: { kind: "meltdown", ceiling: 90000 } }, tax);
      expect(sum(rows[1], "celiContribution")).toBeLessThan(14001);
      expect(sum(rows[1], "celiContribution")).toBeGreaterThan(0);
    });
    it("la fonte s'arrête à `untilAge`", () => {
      const at70 = (untilAge?: number) => runProjection({ ...melt, strategy: { kind: "meltdown", ceiling: 90000, untilAge } }, tax).find((y) => y.spouses[0].age === 70)!;
      expect(sum(at70(65), "reerWithdrawal")).toBeLessThan(1); // les revenus garantis couvrent déjà les dépenses
      expect(sum(at70(), "reerWithdrawal")).toBeGreaterThan(1000);
    });
    it("le rendement imposable du non enregistré s'ajoute au revenu imposable", () => {
      const low: Scenario = { ...scenario, targetNetSpending: 20000 };
      const avec: Scenario = { ...low, spouses: [{ ...low.spouses[0], nonRegistered: 200000 }, { ...low.spouses[1], nonRegistered: 200000 }] };
      const a = runProjection(low, tax)[0], b = runProjection(avec, tax)[0];
      expect(sum(b, "taxableIncome") - sum(a, "taxableIncome")).toBeCloseTo(2 * 200000 * 0.04 * 0.5, 0);
    });
    it("le non enregistré finance les dépenses avant le CELI", () => {
      const sc: Scenario = { ...scenario, targetNetSpending: 90000, spouses: scenario.spouses.map((x) => ({ ...x, reer: 0, celi: 100000, nonRegistered: 300000 })) as Scenario["spouses"] };
      const y = runProjection(sc, tax)[0];
      expect(sum(y, "nonRegWithdrawal")).toBeGreaterThan(0);
      expect(sum(y, "celiWithdrawal")).toBe(0);
    });
    it("le non enregistré passe au survivant au décès", () => {
      const sc: Scenario = { ...scenario, spouses: [{ ...scenario.spouses[0], nonRegistered: 200000, deathAge: 80 }, { ...scenario.spouses[1], nonRegistered: 100000 }] };
      const y = runProjection(sc, tax).find((r) => r.year === 2040)!;
      expect(y.spouses[0].nonRegBalanceEnd).toBe(0);
      expect(y.spouses[1].nonRegBalanceEnd).toBeGreaterThan(200000);
    });
  });
  it("fractionne la pension quand les rentes sont inégales", () => {
    const y = runProjection(scenario, tax).find((r) => r.spouses[0].age >= 66)!;
    expect(y.spouses[0].pensionSplit).toBeLessThan(0);
    expect(y.spouses[1].pensionSplit).toBeGreaterThan(0);
  });
});

describe("comparaison des ordres de décès", () => {
  const spouse = (name: string, birthYear: number, db: number) => ({
    name, birthYear,
    dbPensions: [{ label: "RPA", annualAmount: db, startAge: 62, indexation: 0.02, survivorPct: 0.6 }],
    rrq: { annualAmount: 14000, startAge: 65 }, psv: { annualAmount: 8700, startAge: 65 },
    reer: 900000, celi: 100000, celiRoom: 40000,
  });
  const base: Scenario = {
    spouses: [spouse("Alex", 1960, 45000), spouse("Sam", 1962, 25000)],
    targetNetSpending: 130000,
    assumptions: { startYear: 2026, endAge: 95, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 },
  };
  const few = [
    { label: "REER d'abord", strategy: { kind: "reer-first" } as const },
    { label: "Fonte 100 k$", strategy: { kind: "meltdown", ceiling: 100000 } as const },
    { label: "CELI d'abord", strategy: { kind: "celi-first" } as const },
  ];

  it("génère un cas par conjoint et par âge, plus le cas sans décès", () => {
    const d = deathScenarios(base, [80, 90]);
    expect(d.length).toBe(2 * 2 + 1);
    expect(d[0].label).toBe("Alex décède à 80 ans");
    expect(d[2].deathAges).toEqual([undefined, 80]);
    expect(d[d.length - 1].deathAges).toEqual([undefined, undefined]);
  });
  it("applique un cas de décès sans modifier le scénario de base", () => {
    const sc = applyDeathScenario(base, { label: "x", deathAges: [80, undefined] });
    expect(sc.spouses[0].deathAge).toBe(80);
    expect(base.spouses[0].deathAge).toBe(undefined);
  });
  it("la matrice est cohérente : regrets positifs, meilleur par cas, classement par regret maximal", () => {
    const r = compareDeathOrders(base, tax, few, { deathAges: [80] });
    expect(r.scenarios.length).toBe(3);
    expect(r.rows.length).toBe(3);
    for (const row of r.rows) {
      expect(row.estates.length).toBe(3);
      expect(row.maxRegret).toBeGreaterThanOrEqual(0);
      expect(row.worst).toBeLessThan(row.average + 1);
    }
    r.bestPerScenario.forEach((b, j) => { for (const row of r.rows) expect(b.estate).toBeGreaterThanOrEqual(row.estates[j] - 0.01); });
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i - 1].maxRegret).toBeLessThan(r.rows[i].maxRegret + 1e-6);
  });
  it("le cas « Sam décède » diffère du cas « Alex décède » (ordre des décès)", () => {
    const r = compareDeathOrders(base, tax, [few[0]], { deathAges: [80], includeNoDeath: false });
    expect(Math.abs(r.rows[0].estates[0] - r.rows[0].estates[1])).toBeGreaterThan(1000);
  });
  it("refuse des pondérations de mauvaise longueur", () => {
    let erreur = false;
    try { compareDeathOrders(base, tax, few, { deathAges: [80], weights: [1, 2] }); } catch { erreur = true; }
    expect(erreur).toBe(true);
  });
});

describe("montants en dollars courants", () => {
  const sp = (name: string, birthYear: number) => ({
    name, birthYear,
    dbPensions: [{ label: "RPA", annualAmount: 40000, startAge: 62, indexation: 0.02, survivorPct: 0.6 }],
    rrq: { annualAmount: 14000, startAge: 65 }, psv: { annualAmount: 8700, startAge: 65 },
    reer: 600000, celi: 90000, celiRoom: 40000,
  });
  const mk = (inflation: number): Scenario => ({
    spouses: [sp("A", 1960), sp("B", 1962)], targetNetSpending: 100000,
    assumptions: { startYear: 2026, endAge: 95, inflation, rrqIndexation: inflation, psvIndexation: inflation, reerReturn: 0.04, celiReturn: 0.04 },
  });
  it("les soldes de fin en dollars courants valent ceux en dollars constants x le facteur d'inflation", () => {
    const s = mk(0.02);
    const rows = runProjection(s, tax);
    const r = summarize("x", { kind: "reer-first" }, rows, s.assumptions);
    const factor = Math.pow(1.02, rows[rows.length - 1].year - 2026);
    expect(r.nominal.afterTaxEstate / r.afterTaxEstate).toBeCloseTo(factor, 6);
    expect(r.nominal.finalCeli / r.finalCeli).toBeCloseTo(factor, 6);
  });
  it("l'impôt cumulé courant dépasse l'impôt constant quand il y a de l'inflation", () => {
    const s = mk(0.02);
    const r = summarize("x", { kind: "reer-first" }, runProjection(s, tax), s.assumptions);
    expect(r.nominal.totalTax).toBeGreaterThan(r.totalTax * 1.2);
  });
  it("sans inflation, les deux séries sont identiques", () => {
    const s = mk(0);
    const r = summarize("x", { kind: "reer-first" }, runProjection(s, tax), s.assumptions);
    expect(r.nominal).toEqual({ totalTax: r.totalTax, totalClawback: r.totalClawback, totalShortfall: r.totalShortfall, finalReer: r.finalReer, finalCeli: r.finalCeli, finalNonReg: r.finalNonReg, afterTaxEstate: r.afterTaxEstate });
  });
  it("la comparaison des décès fournit les successions courantes, dans le même ordre de grandeur que le facteur", () => {
    const s = mk(0.02);
    const c = compareDeathOrders(s, tax, [{ label: "REER d'abord", strategy: { kind: "reer-first" } }], { deathAges: [80], includeNoDeath: false });
    const row = c.rows[0];
    row.estates.forEach((e, j) => {
      expect(row.nominal.estates[j] / e).toBeGreaterThan(1.5);
      expect(c.bestPerScenario[j].estateNominal / c.bestPerScenario[j].estate).toBeCloseTo(row.nominal.estates[j] / e, 6);
    });
    expect(row.nominal.maxRegret).toBeGreaterThanOrEqual(0);
  });
});

describe("mortalité de Gompertz", () => {
  it("reproduit l'espérance de vie à 65 ans demandée", () => {
    for (const e of [19.8, 22.1, 26]) {
      const m = gompertz(e);
      let total = 0, prev = 1;
      for (let x = 65.25; x <= 135; x += 0.25) { const sv = m.survival(65, x); total += ((prev + sv) / 2) * 0.25; prev = sv; }
      expect(total).toBeCloseTo(e, 1);
    }
  });
  it("la survie décroît avec l'âge et augmente avec l'espérance de vie", () => {
    const m = gompertz(20), longer = gompertz(24);
    expect(m.survival(65, 75)).toBeGreaterThan(m.survival(65, 85));
    expect(m.survival(65, 85)).toBeGreaterThan(m.survival(65, 95));
    expect(longer.survival(65, 90)).toBeGreaterThan(m.survival(65, 90));
    expect(m.survival(70, 70)).toBeCloseTo(1, 10);
  });
  it("l'âge quantile est l'inverse de la survie", () => {
    const m = gompertz(21);
    for (const p of [0.1, 0.5, 0.9]) expect(m.survival(66, m.quantileAge(66, p))).toBeCloseTo(1 - p, 8);
  });
  it("les âges représentatifs sont croissants, jamais avant l'âge actuel, et undefined au-delà de la fin du plan", () => {
    const ages = representativeDeathAges(gompertz(21), 66, 5, 95);
    expect(ages.length).toBe(5);
    const defined = ages.filter((a): a is number => a !== undefined);
    for (let i = 1; i < defined.length; i++) expect(defined[i]).toBeGreaterThanOrEqual(defined[i - 1]);
    expect(defined[0]).toBeGreaterThanOrEqual(66);
    expect(ages.filter((a) => a === undefined).length).toBeGreaterThan(0);
    expect(representativeDeathAges(gompertz(21), 66, 3, 200).every((a) => a !== undefined)).toBe(true);
  });
  it("une espérance de vie plus élevée repousse les âges de décès", () => {
    const a = representativeDeathAges(gompertz(19), 66, 3, 200), b = representativeDeathAges(gompertz(24), 66, 3, 200);
    expect(b[1]! > a[1]!).toBe(true);
  });
});

describe("comparaison selon la durée de vie des deux conjoints", () => {
  const sp = (name: string, birthYear: number) => ({
    name, birthYear,
    dbPensions: [{ label: "RPA", annualAmount: 40000, startAge: 62, indexation: 0.02, survivorPct: 0.6 }],
    rrq: { annualAmount: 14000, startAge: 65 }, psv: { annualAmount: 8700, startAge: 65 },
    reer: 600000, celi: 90000, celiRoom: 40000,
  });
  const s: Scenario = {
    spouses: [sp("Alex", 1960), sp("Sam", 1962)], targetNetSpending: 100000,
    assumptions: { startYear: 2026, endAge: 95, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 },
  };
  const few = [{ label: "REER d'abord", strategy: { kind: "reer-first" } as const }, { label: "Fonte 90 k$", strategy: { kind: "meltdown", ceiling: 90000 } as const }];

  it("produit états x états cas, avec les deux âges de décès variables", () => {
    const sc = longevityScenarios(s, { lifeExpectancy65: [19.8, 22.1], states: 3 });
    expect(sc.length).toBe(9);
    expect(new Set(sc.map((d) => d.label)).size).toBe(9);
    const first = sc[0].deathAges;
    expect(first[0]! < (sc[sc.length - 1].deathAges[0] ?? 999)).toBe(true);
    expect(sc.some((d) => d.deathAges[0]! < d.deathAges[1]! + 2)).toBe(true);
  });
  it("le poids total est 1 et chaque ligne a une valeur par cas", () => {
    const r = compareLongevity(s, tax, few, { lifeExpectancy65: [21, 21], states: 3 });
    expect(r.scenarios.length).toBe(9);
    expect(r.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    r.rows.forEach((row) => { expect(row.estates.length).toBe(9); expect(row.shortfallProbability).toBeGreaterThanOrEqual(0); expect(row.shortfallProbability).toBeLessThan(1.0000001); });
    expect(r.rows[0].maxRegret).toBeLessThan(r.rows[1].maxRegret + 1e-6);
  });
  it("une plus longue vie augmente le risque de manquer de fonds", () => {
    const tight: Scenario = { ...s, targetNetSpending: 175000 };
    const short = compareLongevity(tight, tax, [few[0]], { lifeExpectancy65: [15, 15], states: 5 });
    const long = compareLongevity(tight, tax, [few[0]], { lifeExpectancy65: [27, 27], states: 5 });
    expect(long.rows[0].shortfallProbability).toBeGreaterThan(short.rows[0].shortfallProbability);
  });
  it("la probabilité de manquer de fonds monte quand les dépenses dépassent les moyens", () => {
    const poor: Scenario = { ...s, targetNetSpending: 190000 };
    const r = compareLongevity(poor, tax, [few[0]], { lifeExpectancy65: [24, 24], states: 3 });
    expect(r.rows[0].shortfallProbability).toBeGreaterThan(0);
    const ok = compareLongevity(s, tax, [few[0]], { lifeExpectancy65: [24, 24], states: 3 });
    expect(ok.rows[0].shortfallProbability).toBe(0);
  });
});

describe("taux marginal d'imposition", () => {
  it("combine le palier fédéral (après l'abattement du Québec) et celui du Québec", () => {
    expect(marginalRate(30000, tax)).toBeCloseTo(0.2569, 4);      // 14 % x 0,835 + 14 %
    expect(marginalRate(70000, tax)).toBeCloseTo(0.361175, 5);    // 20,5 % x 0,835 + 19 %
    expect(marginalRate(110301, tax)).toBeCloseTo(0.411175, 5);   // 20,5 % x 0,835 + 24 %
    expect(marginalRate(200000, tax)).toBeCloseTo(0.49965, 5);    // 29 % x 0,835 + 25,75 %
  });
  it("change de palier au seuil exact : le prochain dollar est imposé au taux supérieur", () => {
    expect(marginalRate(54344, tax)).toBeCloseTo(0.2569, 4);
    expect(marginalRate(54345, tax)).toBeCloseTo(0.3069, 4);
  });
  it("suit l'indexation des paliers", () => {
    const t2 = indexTable(tax, 1.1);
    expect(marginalRate(54345 * 1.1 - 1, t2)).toBeCloseTo(0.2569, 4);
    expect(marginalRate(54345 * 1.1 + 1, t2)).toBeCloseTo(0.3069, 4);
  });
  it("householdTax donne un taux marginal par conjoint, à partir du revenu imposable après fractionnement et récupération de la PSV", () => {
    const r = householdTax([{ age: 66, income: 120000, eligiblePension: 0 }, { age: 66, income: 20000, eligiblePension: 0 }], tax);
    expect(r.marginal[0]).toBeCloseTo(0.4571, 4);   // 26 % x 0,835 + 24 %
    expect(r.marginal[1]).toBeCloseTo(0.2569, 4);
    const seul = householdTax([{ age: 70, income: 70000, eligiblePension: 0 }, null], tax);
    expect(seul.marginal[0]).toBeCloseTo(0.361175, 5);
    expect(seul.marginal[1]).toBe(0);
    // récupération de la PSV : le revenu imposable est réduit avant de chercher le palier (108 680 $ = seuil du palier du Québec)
    const avecPsv = householdTax([{ age: 70, income: 116000, eligiblePension: 0, psv: 9000 }, null], tax);
    expect(avecPsv.clawback[0]).toBeCloseTo(0.15 * (116000 - 95323), 2);
    expect(avecPsv.marginal[0]).toBeCloseTo(0.171175 + 0.24, 5);
  });
  it("la projection donne un taux marginal par conjoint et par année, et 0 après un décès", () => {
    const person = (name: string, birthYear: number, deathAge?: number) => ({
      name, birthYear, deathAge,
      dbPensions: [{ label: "RPA", annualAmount: 40000, startAge: 62, indexation: 0.02, survivorPct: 0.6 }],
      rrq: { annualAmount: 14000, startAge: 65 }, psv: { annualAmount: 8700, startAge: 65 }, reer: 600000, celi: 90000, celiRoom: 40000,
    });
    const sc: Scenario = {
      spouses: [person("A", 1960, 80), person("B", 1962)], targetNetSpending: 100000,
      assumptions: { startYear: 2026, endAge: 95, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 },
    };
    const rows = runProjection(sc, tax);
    for (const y of rows) y.spouses.forEach((p) => {
      if (p.alive) { expect(p.marginalRate).toBeGreaterThan(0.25); expect(p.marginalRate).toBeLessThan(0.55); }
      else expect(p.marginalRate).toBe(0);
    });
    expect(rows.find((y) => y.year === 2045)!.spouses[0].alive).toBe(false);
  });
});

describe("fractionnement du revenu de pension (option)", () => {
  const person = (name: string, birthYear: number, db: number) => ({
    name, birthYear,
    dbPensions: [{ label: "RPA", annualAmount: db, startAge: 62, indexation: 0.02, survivorPct: 0.6 }],
    rrq: { annualAmount: 14000, startAge: 65 }, psv: { annualAmount: 8700, startAge: 65 }, reer: 600000, celi: 90000, celiRoom: 40000,
  });
  const base: Scenario = {
    spouses: [person("A", 1960, 55000), person("B", 1962, 8000)], targetNetSpending: 100000,
    assumptions: { startYear: 2026, endAge: 95, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 },
  };
  const withOpt = (v?: boolean): Scenario => ({ ...base, assumptions: { ...base.assumptions, pensionSplitting: v } });
  const cost = (rows: ReturnType<typeof runProjection>) => rows.reduce((sum, y) => sum + y.spouses[0].tax + y.spouses[1].tax + y.spouses[0].psvClawback + y.spouses[1].psvClawback, 0);

  it("l'option est activée par défaut : absente ou true donne exactement le même plan", () => {
    const a = runProjection(withOpt(undefined), tax), b = runProjection(withOpt(true), tax);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.some((y) => y.spouses[0].pensionSplit !== 0)).toBe(true);
  });
  it("désactivée : aucun montant n'est fractionné, pour aucune année", () => {
    const rows = runProjection(withOpt(false), tax);
    for (const y of rows) y.spouses.forEach((p) => expect(p.pensionSplit).toBe(0));
  });
  it("désactiver le fractionnement augmente l'impôt et la récupération de la PSV quand les rentes sont inégales", () => {
    const avec = cost(runProjection(withOpt(true), tax)), sans = cost(runProjection(withOpt(false), tax));
    expect(sans).toBeGreaterThan(avec + 10000);
  });
  it("le fractionnement désactivé ne change pas la dépense nette atteinte tant que les actifs suffisent", () => {
    const rows = runProjection(withOpt(false), tax);
    expect(rows.every((y) => y.shortfall < 1)).toBe(true);
  });
  it("après un décès, l'option n'a plus d'effet (le survivant est imposé seul)", () => {
    const dead = (v: boolean): Scenario => ({ ...withOpt(v), spouses: [{ ...base.spouses[0], deathAge: 70 }, base.spouses[1]] });
    const a = runProjection(dead(true), tax), b = runProjection(dead(false), tax);
    const later = (rows: typeof a) => rows.filter((y) => y.year > 2030).map((y) => y.spouses[1].tax);
    expect(later(a).length).toBeGreaterThan(10);
    // tant que le survivant est seul, les deux plans ne diffèrent que par l'héritage des années précédentes : ils doivent rester proches
    expect(Math.abs(later(a)[later(a).length - 1] - later(b)[later(b).length - 1]) / later(a)[later(a).length - 1]).toBeLessThan(0.25);
  });
});

describe("harmonisation de la rente avec la RRQ à 65 ans", () => {
  const mk = (deathAgeA?: number, amountAt65?: number): Scenario => {
    const pension = { label: "RPA", annualAmount: 40000, startAge: 62, indexation: 0.02, survivorPct: 0.6, ...(amountAt65 === undefined ? {} : { amountAt65 }) };
    const base = { rrq: { annualAmount: 0, startAge: 65 }, psv: { annualAmount: 0, startAge: 65 }, reer: 500000, celi: 100000, celiRoom: 40000 };
    return {
      spouses: [{ name: "A", birthYear: 1965, deathAge: deathAgeA, dbPensions: [pension], ...base }, { name: "B", birthYear: 1965, dbPensions: [], ...base }],
      targetNetSpending: 50000,
      assumptions: { startYear: 2026, endAge: 95, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 },
    };
  };
  const pensionOf = (rows: ReturnType<typeof runProjection>, year: number, who: 0 | 1) => rows.find((y) => y.year === year)!.spouses[who].pensionIncome;

  it("avant 65 ans le montant annuel s'applique, à partir de 65 ans le montant à 65 ans", () => {
    const rows = runProjection(mk(undefined, 30000), tax);      // né en 1965 : 65 ans en 2030
    expect(pensionOf(rows, 2025 + 1, 0)).toBe(0);                 // 61 ans : la rente n'a pas commencé
    expect(pensionOf(rows, 2027, 0)).toBeCloseTo(40000 * Math.pow(1.02, 1), 4);   // 62 ans
    expect(pensionOf(rows, 2029, 0)).toBeCloseTo(40000 * Math.pow(1.02, 3), 4);   // 64 ans
    expect(pensionOf(rows, 2030, 0)).toBeCloseTo(30000 * Math.pow(1.02, 4), 4);   // 65 ans
    expect(pensionOf(rows, 2040, 0)).toBeCloseTo(30000 * Math.pow(1.02, 14), 4);
  });
  it("sans harmonisation la rente ne change pas à 65 ans", () => {
    const rows = runProjection(mk(), tax);
    expect(pensionOf(rows, 2030, 0)).toBeCloseTo(40000 * Math.pow(1.02, 4), 4);
  });
  it("un montant à 65 ans égal au montant annuel donne exactement le même plan qu'aucune harmonisation", () => {
    expect(JSON.stringify(runProjection(mk(undefined, 40000), tax))).toBe(JSON.stringify(runProjection(mk(), tax)));
  });
  it("la baisse à 65 ans réduit l'impôt et les revenus, et le plan reste financé par les comptes", () => {
    const avec = runProjection(mk(undefined, 30000), tax), sans = runProjection(mk(), tax);
    const tot = (rows: typeof avec) => rows.reduce((s, y) => s + y.spouses[0].tax + y.spouses[1].tax, 0);
    expect(tot(avec)).toBeLessThan(tot(sans));
    expect(avec.every((y) => y.shortfall < 1)).toBe(true);
    // avant 71 ans (pas encore de retraits FERR minimums), la différence de revenu est compensée par des retraits plus élevés
    const w = (rows: typeof avec) => rows.filter((y) => y.year >= 2030 && y.year <= 2035).reduce((s, y) => s + y.spouses[0].reerWithdrawal + y.spouses[1].reerWithdrawal, 0);
    expect(w(avec)).toBeGreaterThan(w(sans));
  });
  it("rente de survivant : calculée sur le montant du défunt à son âge au décès", () => {
    // décès à 70 ans (2035) : le défunt touchait le montant à 65 ans -> survivant 60 % de 30 000 $, indexé
    const tard = runProjection(mk(70, 30000), tax);
    expect(pensionOf(tard, 2036, 1)).toBeCloseTo(0.6 * 30000 * Math.pow(1.02, 10), 4);
    // décès à 62 ans (2027) : il touchait encore le montant annuel -> survivant 60 % de 40 000 $
    const tot = runProjection(mk(62, 30000), tax);
    expect(pensionOf(tot, 2028, 1)).toBeCloseTo(0.6 * 40000 * Math.pow(1.02, 2), 4);
  });
  it("une rente qui commence après 65 ans utilise le montant à 65 ans dès le début", () => {
    const sc = mk(undefined, 30000);
    sc.spouses[0].dbPensions[0].startAge = 67;
    expect(pensionOf(runProjection(sc, tax), 2032, 0)).toBeCloseTo(30000 * Math.pow(1.02, 6), 4);   // 67 ans
  });
  it("dbAmount : aucune harmonisation, avant et après 65 ans", () => {
    const p = { label: "x", annualAmount: 1000, startAge: 60, indexation: 0, survivorPct: 0.5 };
    expect(dbAmount(p, 70)).toBe(1000);
    expect(dbAmount({ ...p, amountAt65: 600 }, 64)).toBe(1000);
    expect(dbAmount({ ...p, amountAt65: 600 }, 65)).toBe(600);
    expect(dbAmount({ ...p, amountAt65: 0 }, 80)).toBe(0);      // zéro est une valeur valide, pas « absent »
  });
});

describe("répartition des dépenses visées entre les conjoints", () => {
  const person = (name: string, birthYear: number, deathAge?: number) => ({
    name, birthYear, deathAge,
    dbPensions: [{ label: "RPA", annualAmount: 40000, startAge: 62, indexation: 0.02, survivorPct: 0.6 }],
    rrq: { annualAmount: 14000, startAge: 65 }, psv: { annualAmount: 8700, startAge: 65 }, reer: 600000, celi: 90000, celiRoom: 40000,
  });
  const mk = (share?: number, deathA?: number): Scenario => ({
    spouses: [person("A", 1960, deathA), person("B", 1962)], targetNetSpending: 100000, firstSpouseSpendingShare: share,
    assumptions: { startYear: 2026, endAge: 95, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 },
  });
  it("par défaut 50 / 50, et la somme des parts est la dépense visée du ménage", () => {
    const rows = runProjection(mk(undefined), tax);
    for (const y of rows) {
      expect(y.spouses[0].spending + y.spouses[1].spending).toBeCloseTo(y.targetSpending, 6);
      expect(y.spouses[0].spendingShare).toBe(0.5);
      expect(y.spouses[1].spendingShare).toBe(0.5);
    }
    expect(rows[0].spouses[0].spending).toBeCloseTo(50000, 6);
  });
  it("respecte la part du premier conjoint, et le second a le reste", () => {
    const rows = runProjection(mk(0.7), tax);
    const y = rows.find((r) => r.year === 2030)!;
    expect(y.spouses[0].spending).toBeCloseTo(0.7 * y.targetSpending, 6);
    expect(y.spouses[1].spending).toBeCloseTo(0.3 * y.targetSpending, 6);
    expect(y.spouses[0].spendingShare + y.spouses[1].spendingShare).toBeCloseTo(1, 12);
    expect(y.targetSpending).toBeCloseTo(100000 * Math.pow(1.02, 4), 4);    // la dépense du ménage suit l'inflation
  });
  it("les dépenses sont en dollars courants : chaque part suit l'inflation", () => {
    const rows = runProjection(mk(0.6), tax);
    expect(rows.find((r) => r.year === 2036)!.spouses[0].spending / rows[0].spouses[0].spending).toBeCloseTo(Math.pow(1.02, 10), 8);
  });
  it("après un décès, le survivant a toute la dépense (réduite) et le défunt rien, quelle que soit la part", () => {
    const rows = runProjection(mk(0.7, 80), tax);          // A (né en 1960) décède à 80 ans, fin 2040
    const apres = rows.find((r) => r.year === 2041)!;
    expect(apres.spouses[0].spending).toBe(0);
    expect(apres.spouses[0].spendingShare).toBe(0);
    expect(apres.spouses[1].spendingShare).toBe(1);
    expect(apres.spouses[1].spending).toBeCloseTo(apres.targetSpending, 6);
    expect(apres.targetSpending).toBeCloseTo(0.75 * 100000 * Math.pow(1.02, 15), 4);
    // et si c'est le second qui reste : même chose
    const b = runProjection({ ...mk(0.3), spouses: [person("A", 1960), person("B", 1962, 78)] }, tax);   // B décède en 2040
    const y2 = b.find((r) => r.year === 2041)!;
    expect(y2.spouses[0].spendingShare).toBe(1);
    expect(y2.spouses[1].spending).toBe(0);
  });
  it("valeurs limites : 0 % et 100 % ; une valeur hors limites est ramenée dans [0, 1]", () => {
    const zero = runProjection(mk(0), tax)[0], cent = runProjection(mk(1), tax)[0];
    expect(zero.spouses[0].spending).toBe(0);
    expect(zero.spouses[1].spending).toBeCloseTo(zero.targetSpending, 6);
    expect(cent.spouses[1].spending).toBe(0);
    const trop = runProjection(mk(1.8), tax)[0], neg = runProjection(mk(-0.4), tax)[0];
    expect(trop.spouses[0].spendingShare).toBe(1);
    expect(neg.spouses[0].spendingShare).toBe(0);
  });
  it("la répartition ne change ni l'impôt ni le financement du ménage", () => {
    const a = runProjection(mk(0.5), tax), b = runProjection(mk(0.9), tax);
    const strip = (rows: typeof a) => rows.map((y) => ({ ...y, spouses: y.spouses.map((p) => ({ ...p, spending: 0, spendingShare: 0 })) }));
    expect(JSON.stringify(strip(a))).toBe(JSON.stringify(strip(b)));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("RRQ et PSV : réduction avant 65 ans et bonification du report", () => {
  const MAX = 18091.8;      // rente RRQ maximale à 65 ans en 2026 (1 507,65 $ x 12)

  it("la table fiscale 2026 contient la rente maximale de Retraite Québec", () => {
    expect(tax.rrqMaxAt65).toBeCloseTo(1507.65 * 12, 2);
  });
  it("RRQ à 65 ans : ni réduction ni bonification", () => {
    expect(rrqFactor(65, 14000, MAX)).toBe(1);
    expect(rrqFactor(65, 0, MAX)).toBe(1);
  });
  it("RRQ après 65 ans : +0,7 % par mois, soit +8,4 % par année, jusqu'à +58,8 % à 72 ans", () => {
    expect(rrqFactor(66, 14000, MAX)).toBeCloseTo(1.084, 10);
    expect(rrqFactor(70, 14000, MAX)).toBeCloseTo(1.42, 10);      // +42 % à 70 ans (Retraite Québec)
    expect(rrqFactor(72, 14000, MAX)).toBeCloseTo(1.588, 10);     // +58,8 % à 72 ans
    expect(rrqFactor(75, 14000, MAX)).toBeCloseTo(1.588, 10);     // la rente cesse d'augmenter après 72 ans
  });
  it("RRQ avant 65 ans, rente maximale : -0,6 % par mois, soit -36 % à 60 ans", () => {
    expect(rrqFactor(60, MAX, MAX)).toBeCloseTo(0.64, 10);
    expect(rrqFactor(62, MAX, MAX)).toBeCloseTo(0.784, 10);
    expect(rrqFactor(64, MAX, MAX)).toBeCloseTo(0.928, 10);
    expect(MAX * rrqFactor(60, MAX, MAX) / 12).toBeCloseTo(964.9, 0);      // 964,90 $ par mois à 60 ans, selon Retraite Québec
  });
  it("RRQ avant 65 ans, rente très faible : environ -0,5 % par mois, soit -30 % à 60 ans", () => {
    expect(rrqFactor(60, 0, MAX)).toBeCloseTo(0.7, 10);
    expect(rrqEarlyMonthlyRate(0, MAX)).toBeCloseTo(0.005, 12);
    expect(rrqEarlyMonthlyRate(MAX, MAX)).toBeCloseTo(0.006, 12);
  });
  it("la réduction augmente avec le montant de la rente, sans jamais dépasser 0,6 % par mois", () => {
    let prev = 1;
    for (const amount of [0, 4000, 8000, 12000, 16000, MAX, 25000, 1e6]) {
      const f = rrqFactor(60, amount, MAX);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);        // plus la rente est élevée, plus le facteur baisse
      expect(f).toBeGreaterThanOrEqual(0.64 - 1e-12);     // jamais plus de 36 % de réduction
      expect(f).toBeLessThanOrEqual(0.7 + 1e-12);         // jamais moins de 30 %
      prev = f;
    }
    expect(rrqEarlyMonthlyRate(MAX / 2, MAX)).toBeCloseTo(0.0055, 12);
    expect(rrqEarlyMonthlyRate(5, 0)).toBeCloseTo(0.006, 12);      // rente maximale inconnue : taux maximal
  });
  it("les âges hors des limites sont ramenés aux limites (RRQ 60 à 72 ans, PSV 65 à 70 ans)", () => {
    expect(rrqFactor(55, MAX, MAX)).toBe(rrqFactor(60, MAX, MAX));
    expect(rrqFactor(80, 14000, MAX)).toBe(rrqFactor(72, 14000, MAX));
    expect(psvFactor(60)).toBe(1);
    expect(psvFactor(75)).toBe(psvFactor(70));
    expect([RRQ_AGES.min, RRQ_AGES.normal, RRQ_AGES.max, PSV_AGES.min, PSV_AGES.max]).toEqual([60, 65, 72, 65, 70]);
  });
  it("PSV : +0,6 % par mois de report, soit +7,2 % par année, jusqu'à +36 % à 70 ans", () => {
    expect(psvFactor(65)).toBe(1);
    expect(psvFactor(66)).toBeCloseTo(1.072, 10);
    expect(psvFactor(68)).toBeCloseTo(1.216, 10);        // 36 mois x 0,6 % = 21,6 % (Service Canada)
    expect(psvFactor(70)).toBeCloseTo(1.36, 10);         // 60 mois x 0,6 % = 36 %
  });
  it("rrqAmount et psvAmount appliquent le facteur au montant de 65 ans", () => {
    expect(rrqAmount({ annualAmount: 10000, startAge: 70 }, MAX)).toBeCloseTo(14200, 8);
    expect(psvAmount({ annualAmount: 8700, startAge: 70 })).toBeCloseTo(11832, 8);
  });
});

describe("projection : RRQ et PSV reportées ou anticipées", () => {
  const person = (name: string, birthYear: number, rrqAge: number, psvAge: number, extra: Partial<Scenario["spouses"][0]> = {}) => ({
    name, birthYear, dbPensions: [], rrq: { annualAmount: 14000, startAge: rrqAge }, psv: { annualAmount: 8700, startAge: psvAge },
    reer: 800000, celi: 100000, celiRoom: 30000, ...extra,
  });
  const scen = (a: Scenario["spouses"][0], b: Scenario["spouses"][0], extra: Partial<Scenario["assumptions"]> = {}): Scenario => ({
    spouses: [a, b], targetNetSpending: 60000,
    assumptions: { startYear: 2026, endAge: 95, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04, ...extra },
  });
  const at = (rows: ReturnType<typeof runProjection>, year: number) => rows.find((y) => y.year === year)!;

  it("le montant saisi est celui de 65 ans : à 65 ans la rente est inchangée", () => {
    const rows = runProjection(scen(person("A", 1961, 65, 65), person("B", 1961, 65, 65)), tax);   // 65 ans en 2026
    expect(at(rows, 2026).spouses[0].rrqIncome).toBeCloseTo(14000, 6);
    expect(at(rows, 2030).spouses[0].rrqIncome).toBeCloseTo(14000 * Math.pow(1.02, 4), 6);
    expect(at(rows, 2026).spouses[0].psvIncome).toBeCloseTo(8700, 6);
  });
  it("RRQ à 60 ans : réduite de 30 % à 36 % selon le montant, et rien avant", () => {
    const rows = runProjection(scen(person("A", 1971, 60, 65), person("B", 1971, 65, 65)), tax);   // 60 ans en 2031
    expect(at(rows, 2030).spouses[0].rrqIncome).toBe(0);
    const f = rrqFactor(60, 14000, tax.rrqMaxAt65);
    expect(f).toBeGreaterThan(0.64);
    expect(f).toBeLessThan(0.7);
    expect(at(rows, 2031).spouses[0].rrqIncome).toBeCloseTo(14000 * f * Math.pow(1.02, 5), 6);
  });
  it("RRQ à 72 ans et PSV à 70 ans : bonifiées à vie, puis indexées", () => {
    const rows = runProjection(scen(person("A", 1956, 72, 70), person("B", 1956, 65, 65)), tax);    // 70 ans en 2026, 72 ans en 2028
    expect(at(rows, 2027).spouses[0].rrqIncome).toBe(0);
    expect(at(rows, 2028).spouses[0].rrqIncome).toBeCloseTo(14000 * 1.588 * Math.pow(1.02, 2), 6);
    expect(at(rows, 2026).spouses[0].psvIncome).toBeCloseTo(8700 * 1.36, 6);
    expect(at(rows, 2031).spouses[0].psvIncome).toBeCloseTo(8700 * 1.36 * Math.pow(1.02, 5), 6);
  });
  it("la rente de survivant de la RRQ se calcule sur la rente ajustée du défunt", () => {
    // A (RRQ à 70 ans, +42 %) décède à 75 ans, fin 2035; B a sa propre RRQ à 65 ans. Plafond du survivant très élevé.
    const a = person("A", 1960, 70, 65, { deathAge: 75 }), b = person("B", 1960, 65, 65);
    b.rrq = { annualAmount: 10000, startAge: 65 };
    const rows = runProjection(scen(a, b, { rrqSurvivorCap: 1e9 }), tax);
    const own = 10000 * Math.pow(1.02, 10);
    const deceasedAdjusted = 14000 * 1.42 * Math.pow(1.02, 10);
    expect(at(rows, 2036).spouses[1].rrqIncome).toBeCloseTo(own + 0.6 * deceasedAdjusted, 6);
    expect(at(rows, 2036).spouses[0].rrqIncome).toBe(0);
  });
  it("reporter la RRQ réduit les revenus des premières années et augmente ceux d'après", () => {
    const tôt = runProjection(scen(person("A", 1961, 65, 65), person("B", 1961, 65, 65)), tax);
    const tard = runProjection(scen(person("A", 1961, 70, 65), person("B", 1961, 65, 65)), tax);
    expect(at(tard, 2028).spouses[0].rrqIncome).toBe(0);
    expect(at(tôt, 2028).spouses[0].rrqIncome).toBeGreaterThan(0);
    expect(at(tard, 2040).spouses[0].rrqIncome).toBeCloseTo(at(tôt, 2040).spouses[0].rrqIncome * 1.42, 6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("optimisation de l'âge de début de la RRQ et de la PSV", () => {
  type Sp = Scenario["spouses"][0];
  const person = (name: string, birthYear: number, o: { rrq?: number; psv?: number; reer?: number; celi?: number; db?: boolean } = {}): Sp => ({
    name, birthYear,
    dbPensions: o.db === false ? [] : [{ label: "RPA", annualAmount: 30000, startAge: 60, indexation: 0.02, survivorPct: 0.6 }],
    rrq: { annualAmount: 12000, startAge: o.rrq ?? 65 }, psv: { annualAmount: 8700, startAge: o.psv ?? 65 },
    reer: o.reer ?? 400000, celi: o.celi ?? 60000, celiRoom: 30000,
  });
  const couple = (a: Sp, b: Sp, endAge = 85, spending = 80000): Scenario => ({
    spouses: [a, b], targetNetSpending: spending,
    assumptions: { startYear: 2026, endAge, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 },
  });
  const onlyA: FreeChoices = { rrq: [true, false], psv: [true, false] };     // seulement le conjoint 1 : 11 x 6 = 66 combinaisons
  const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);

  // ---- âges possibles
  it("explore chaque âge entre l'âge actuel et l'âge maximum de chaque rente", () => {
    const r = benefitRanges(couple(person("A", 1964), person("B", 1962)), ALL_FREE);      // 62 ans et 64 ans en 2026
    expect(r.rrq[0]).toEqual(range(62, 72));
    expect(r.rrq[1]).toEqual(range(64, 72));
    expect(r.psv[0]).toEqual(range(65, 70));
    expect(r.psv[1]).toEqual(range(65, 70));
    expect(countChoices(r)).toBe(11 * 6 * 9 * 6);
  });
  it("la RRQ commence au plus tôt à 60 ans et la PSV à 65 ans, même pour une personne plus jeune", () => {
    const r = benefitRanges(couple(person("A", 1976), person("B", 1980)));        // 50 ans et 46 ans
    expect(r.rrq[0]).toEqual(range(60, 72));
    expect(r.psv[0]).toEqual(range(65, 70));
    expect(countChoices(r)).toBe(13 * 6 * 13 * 6);
  });
  it("une rente déjà commencée (âge de début passé) n'a qu'un choix : son âge actuel", () => {
    const r = benefitRanges(couple(person("A", 1955, { rrq: 62, psv: 65 }), person("B", 1962)));     // A a 71 ans
    expect(r.rrq[0]).toEqual([62]);
    expect(r.psv[0]).toEqual([65]);
    expect(r.rrq[1]).toEqual(range(64, 72));
  });
  it("une rente qui commence cette année peut encore être reportée", () => {
    const r = benefitRanges(couple(person("A", 1961, { rrq: 65 }), person("B", 1962)));      // A a 65 ans : la RRQ peut commencer maintenant
    expect(r.rrq[0]).toEqual(range(65, 72));
  });
  it("une décision décochée garde l'âge du scénario", () => {
    const r = benefitRanges(couple(person("A", 1964, { rrq: 66, psv: 67 }), person("B", 1962)), { rrq: [false, true], psv: [false, false] });
    expect(r.rrq[0]).toEqual([66]);
    expect(r.psv[0]).toEqual([67]);
    expect(r.psv[1]).toEqual([65]);
    expect(r.rrq[1]).toEqual(range(64, 72));
  });
  it("les âges ne dépassent pas l'âge du conjoint à la fin du plan, mais l'âge actuel du scénario est toujours conservé", () => {
    const s = couple(person("A", 1962, { rrq: 70 }), person("B", 1962), 66);                // le plan finit quand ils ont 66 ans
    expect(ageAtPlanEnd(s, 0)).toBe(66);
    const r = benefitRanges(s);
    expect(r.rrq[0]).toEqual([64, 65, 66, 70]);
    expect(r.psv[0]).toEqual([65, 66]);
  });
  it("l'âge de fin du plan se calcule à partir du conjoint le plus jeune", () => {
    const s = couple(person("A", 1960), person("B", 1966), 90);         // le plus jeune (1966) a 90 ans en 2056; A a alors 96 ans
    expect(ageAtPlanEnd(s, 1)).toBe(90);
    expect(ageAtPlanEnd(s, 0)).toBe(96);
  });

  // ---- combinaisons
  it("énumère le produit des âges possibles, sans doublon, et inclut les choix actuels", () => {
    const s = couple(person("A", 1964), person("B", 1962));
    const r = benefitRanges(s, onlyA);
    const all = enumerateChoices(r);
    expect(all.length).toBe(countChoices(r));
    expect(all.length).toBe(11 * 6);
    expect(new Set(all.map(choiceKey)).size).toBe(all.length);
    expect(all.map(choiceKey)).toContain(choiceKey(currentChoice(s)));
    for (const c of all) { expect(c.rrq[1]).toBe(65); expect(c.psv[1]).toBe(65); }
  });
  it("applyChoice remplace les âges de début sans modifier le scénario d'origine", () => {
    const s = couple(person("A", 1964), person("B", 1962));
    const before = JSON.stringify(s);
    const t = applyChoice(s, { rrq: [70, 68], psv: [66, 69] });
    expect([t.spouses[0].rrq.startAge, t.spouses[1].rrq.startAge, t.spouses[0].psv.startAge, t.spouses[1].psv.startAge]).toEqual([70, 68, 66, 69]);
    expect(t.spouses[0].rrq.annualAmount).toBe(12000);
    expect(JSON.stringify(s)).toBe(before);
  });

  // ---- évaluation et classement
  it("évaluer une combinaison donne le même résultat qu'un calcul direct du plan modifié", () => {
    const s = couple(person("A", 1964), person("B", 1962));
    const c = { rrq: [68, 65] as [number, number], psv: [67, 65] as [number, number] };
    const r = evaluateChoice(s, tax, c);
    const direct = summarize("", { kind: "reer-first" }, runProjection(applyChoice(s, c), tax), s.assumptions);
    expect(r.afterTaxEstate).toBeCloseTo(direct.afterTaxEstate, 6);
    expect(r.nominal.afterTaxEstate).toBeCloseTo(direct.nominal.afterTaxEstate, 6);
    expect(r.nominal.afterTaxEstate).toBeGreaterThan(r.afterTaxEstate);      // dollars courants > dollars constants
    expect(r.key).toBe("68-67|65-65");
  });
  it("les résultats ne dépendent pas de la façon de découper le calcul en lots", () => {
    const s = couple(person("A", 1964), person("B", 1962), 80);
    const choices = enumerateChoices(benefitRanges(s, { rrq: [true, false], psv: [false, false] }));         // 11 combinaisons
    const whole = evaluateChoices(s, tax, choices);
    const chunks = [choices.slice(0, 4), choices.slice(4, 5), choices.slice(5)].flatMap((c) => evaluateChoices(s, tax, c));
    expect(JSON.stringify(chunks)).toBe(JSON.stringify(whole));
  });
  const fake = (key: string, estate: number, shortfall: number, tax = 0): ChoiceResult => ({
    choice: { rrq: [65, 65], psv: [65, 65] }, key, afterTaxEstate: estate, totalShortfall: shortfall, yearsWithShortfall: shortfall > 0 ? 1 : 0, totalTax: tax, totalClawback: 0,
    nominal: { afterTaxEstate: estate, totalShortfall: shortfall, totalTax: tax, totalClawback: 0 },
  });
  it("classement : les combinaisons qui financent tout d'abord, par succession décroissante", () => {
    const list = [fake("a", 500, 0), fake("b", 900, 5000), fake("c", 700, 0), fake("d", 100, 0)];
    expect([...list].sort(compareResults).map((r) => r.key)).toEqual(["c", "a", "d", "b"]);
  });
  it("classement : si aucune ne finance tout, par manque cumulé croissant", () => {
    const list = [fake("a", 0, 9000), fake("b", 50, 3000), fake("c", 10, 3000), fake("d", 0, 500)];
    expect([...list].sort(compareResults).map((r) => r.key)).toEqual(["d", "b", "c", "a"]);
  });
  it("un manque de 100 $ ou moins est négligé (même seuil que pour les stratégies)", () => {
    expect(isFeasible(fake("a", 1, 100))).toBe(true);
    expect(isFeasible(fake("b", 1, 100.01))).toBe(false);
    expect([fake("x", 100, 100.5), fake("y", 50, 100)].sort(compareResults)[0].key).toBe("y");
  });
  it("à succession égale, l'impôt le plus bas passe devant, puis l'ordre des clés rend le classement stable", () => {
    const list = [fake("b", 1000, 0, 300), fake("a", 1000, 0, 500), fake("c", 1000, 0, 300)];
    expect([...list].sort(compareResults).map((r) => r.key)).toEqual(["b", "c", "a"]);
  });
  it("rankResults repère les choix actuels et leur rang, et refuse des résultats qui ne les contiennent pas", () => {
    const s = couple(person("A", 1964), person("B", 1962));
    const mine = choiceKey(currentChoice(s));
    const res = rankResults(s, [fake("zz", 900, 0), { ...fake(mine, 400, 0) }, fake("yy", 700, 0)]);
    expect(res.ranked.map((r) => r.key)).toEqual(["zz", "yy", mine]);
    expect(res.currentRank).toBe(3);
    expect(res.best.key).toBe("zz");
    expect(res.total).toBe(3);
    expect(res.anyFeasible).toBe(true);
    expect(() => rankResults(s, [fake("zz", 900, 0)])).toThrow();
  });

  // ---- optimisation complète
  it("la meilleure combinaison est première, au moins aussi bonne que toutes les autres et que les choix actuels", () => {
    const s = couple(person("A", 1964), person("B", 1962), 85);
    const res = optimizeBenefits(s, tax, {}, onlyA);
    expect(res.total).toBe(66);
    expect(new Set(res.ranked.map((r) => r.key)).size).toBe(66);
    expect(res.best).toBe(res.ranked[0]);
    for (const r of res.ranked) expect(res.best.afterTaxEstate).toBeGreaterThanOrEqual(r.afterTaxEstate - 1e-6);
    expect(res.best.afterTaxEstate).toBeGreaterThanOrEqual(res.current.afterTaxEstate);
    expect(res.current.key).toBe(choiceKey(currentChoice(s)));
    expect(res.ranked[res.currentRank - 1]).toBe(res.current);
    expect(res.anyFeasible).toBe(true);
  });
  it("appliquer la meilleure combinaison et recalculer le plan redonne exactement sa succession", () => {
    const s = couple(person("A", 1964), person("B", 1962), 80);
    const res = optimizeBenefits(s, tax, {}, { rrq: [true, false], psv: [false, false] });
    const t = applyChoice(s, res.best.choice);
    const direct = summarize("", { kind: "reer-first" }, runProjection(t, tax), t.assumptions);
    expect(direct.afterTaxEstate).toBeCloseTo(res.best.afterTaxEstate, 6);
    expect(optimizeBenefits(t, tax, {}, { rrq: [true, false], psv: [false, false] }).currentRank).toBe(1);      // après application, ce sont les choix actuels les meilleurs
  });
  it("plus le plan est long, plus l'âge optimal de début de la RRQ est tardif", () => {
    const best = (endAge: number) => optimizeBenefits(couple(person("A", 1964), person("B", 1962), endAge), tax, {}, { rrq: [true, false], psv: [false, false] }).best.choice.rrq[0];
    const [court, moyen, long] = [best(72), best(85), best(100)];
    expect(court).toBe(62);                 // un plan qui s'arrête à 72 ans : mieux vaut commencer tout de suite
    expect(long).toBe(72);                  // un plan jusqu'à 100 ans : mieux vaut reporter au maximum
    expect(moyen).toBeGreaterThan(court);
    expect(moyen).toBeLessThan(long);
  });
  it("quand seules certaines combinaisons financent les dépenses, la meilleure en fait partie et les autres manquent", () => {
    // Peu d'actifs : reporter la rente laisse des années sans revenus suffisants.
    const poor = (o = {}) => person("A", 1964, { db: false, reer: 20000, celi: 0, ...o });
    const s = couple(poor(), { ...poor(), name: "B", birthYear: 1962 }, 80, 34000);
    const res = optimizeBenefits(s, tax, {}, onlyA);
    const feasible = res.ranked.filter(isFeasible);
    expect(feasible.length).toBeGreaterThan(0);
    expect(feasible.length).toBeLessThan(res.total);
    expect(isFeasible(res.best)).toBe(true);
    expect(res.anyFeasible).toBe(true);
    res.ranked.slice(0, feasible.length).forEach((r) => expect(isFeasible(r)).toBe(true));        // les faisables sont toutes devant
    res.ranked.slice(feasible.length).forEach((r) => expect(r.totalShortfall).toBeGreaterThan(100));
    for (let k = 1; k < feasible.length; k++) expect(feasible[k - 1].afterTaxEstate).toBeGreaterThanOrEqual(feasible[k].afterTaxEstate - 1e-6);
  });
  it("quand aucune combinaison ne finance tout, la meilleure est celle qui manque le moins", () => {
    const poor = (o = {}) => person("A", 1964, { db: false, reer: 20000, celi: 0, ...o });
    const s = couple(poor(), { ...poor(), name: "B", birthYear: 1962 }, 80, 40000);
    const res = optimizeBenefits(s, tax, {}, onlyA);
    expect(res.anyFeasible).toBe(false);
    expect(res.ranked.every((r) => !isFeasible(r))).toBe(true);
    const least = Math.min(...res.ranked.map((r) => r.totalShortfall));
    expect(res.best.totalShortfall).toBeCloseTo(least, 6);
    for (let k = 1; k < res.ranked.length; k++) expect(res.ranked[k - 1].totalShortfall).toBeLessThanOrEqual(res.ranked[k].totalShortfall + 1e-6);
    expect(res.best.totalShortfall).toBeLessThan(res.ranked[res.ranked.length - 1].totalShortfall);
  });
  it("tient compte d'un décès saisi dans le scénario", () => {
    // A décède à 66 ans : reporter sa propre RRQ jusqu'à 72 ans n'a aucun intérêt pour lui; l'optimisation doit le voir.
    const s = couple({ ...person("A", 1964), deathAge: 66 }, person("B", 1962), 85);
    const res = optimizeBenefits(s, tax, {}, { rrq: [true, false], psv: [true, false] });
    expect(res.best.choice.rrq[0]).toBeLessThan(72);
    expect(res.best.choice.psv[0]).toBe(65);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("immeubles : vente, gain en capital et résidence principale", () => {
  type Sp = Scenario["spouses"][0];
  const person = (name: string, birthYear: number, o: Partial<Sp> = {}): Sp => ({
    name, birthYear, dbPensions: [], rrq: { annualAmount: 0, startAge: 65 }, psv: { annualAmount: 0, startAge: 70 }, reer: 800000, celi: 100000, celiRoom: 30000, ...o,
  });
  const chalet: Property = { label: "Chalet", owner: "both", purchaseYear: 2000, purchasePrice: 200000, saleYear: 2030, salePrice: 600000, principalResidence: false };
  const scen = (props: Property[] | undefined, extra: Partial<Scenario> = {}, a = person("A", 1971), b = person("B", 1971)): Scenario => ({
    spouses: [a, b], targetNetSpending: 60000, properties: props,
    assumptions: { startYear: 2026, endAge: 80, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 }, ...extra,
  });
  const at = (rows: ReturnType<typeof runProjection>, year: number) => rows.find((y) => y.year === year)!;
  const sum = (y: ReturnType<typeof at>, f: (s: ReturnType<typeof at>["spouses"][0]) => number) => f(y.spouses[0]) + f(y.spouses[1]);
  const t2030 = indexTable(tax, Math.pow(1.02, 4));      // table fiscale de 2030 (quatre ans d'inflation)

  it("la table fiscale donne un taux d'inclusion de 50 %, et l'indexation ne le modifie pas", () => {
    expect(tax.capitalGainsInclusion).toBe(0.5);
    expect(indexTable(tax, 1.5).capitalGainsInclusion).toBe(0.5);
  });
  it("vente d'un immeuble détenu à parts égales : le produit et la moitié du gain imposable sont répartis entre les deux", () => {
    const y = at(runProjection(scen([chalet]), tax), 2030);
    expect(y.spouses.map((p) => p.propertyProceeds)).toEqual([300000, 300000]);
    expect(y.spouses.map((p) => p.taxableCapitalGain)).toEqual([100000, 100000]);      // (600 000 - 200 000) x 50 % / 2
  });
  it("le gain imposable est du revenu : l'impôt est celui d'un revenu de 100 000 $ pour chacun", () => {
    const y = at(runProjection(scen([chalet]), tax), 2030);
    const expected = householdTax([{ age: 59, income: 100000, eligiblePension: 0 }, { age: 59, income: 100000, eligiblePension: 0 }], t2030);
    expect(y.spouses[0].tax).toBeCloseTo(expected.tax[0], 6);
    expect(y.spouses[1].tax).toBeCloseTo(expected.tax[1], 6);
    expect(y.spouses[0].taxableIncome).toBeCloseTo(100000, 6);
    expect(y.spouses[0].marginalRate).toBeGreaterThan(0.35);                   // le gain place les conjoints dans un palier élevé
  });
  it("le produit de la vente est de l'argent : il finance les dépenses, et le surplus après impôt est placé", () => {
    const y = at(runProjection(scen([chalet]), tax), 2030);
    expect(sum(y, (p) => p.reerWithdrawal)).toBe(0);                                      // plus besoin de retirer du REER cette année-là
    expect(y.shortfall).toBe(0);
    const placed = sum(y, (p) => p.celiContribution + p.nonRegContribution);
    expect(placed).toBeCloseTo(600000 - sum(y, (p) => p.tax) - y.targetSpending, 4);      // produit - impôt - dépenses
    expect(sum(y, (p) => p.celiContribution)).toBeGreaterThan(0);                         // d'abord au CELI (dans la limite des droits)
    expect(sum(y, (p) => p.nonRegContribution)).toBeGreaterThan(0);                       // puis au compte non enregistré
  });
  it("sans la vente, les mêmes années exigent des retraits du REER : la vente les remplace", () => {
    const base = runProjection(scen([]), tax);
    expect(sum(at(base, 2030), (p) => p.reerWithdrawal)).toBeGreaterThan(50000);
    expect(at(base, 2030).spouses[0].propertyProceeds).toBe(0);
  });
  it("résidence principale : le gain n'est pas imposé, mais tout le produit est reçu", () => {
    const y = at(runProjection(scen([{ ...chalet, principalResidence: true }]), tax), 2030);
    expect(y.spouses.map((p) => p.propertyProceeds)).toEqual([300000, 300000]);
    expect(y.spouses.map((p) => p.taxableCapitalGain)).toEqual([0, 0]);
    expect(sum(y, (p) => p.tax)).toBe(0);
    expect(sum(y, (p) => p.celiContribution + p.nonRegContribution)).toBeCloseTo(600000 - y.targetSpending, 4);
  });
  it("le prix d'achat d'une résidence principale n'a aucun effet", () => {
    const a = runProjection(scen([{ ...chalet, principalResidence: true, purchasePrice: 0 }]), tax);
    const b = runProjection(scen([{ ...chalet, principalResidence: true, purchasePrice: 550000 }]), tax);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it("propriétaire unique : tout le produit et tout le gain vont à ce conjoint", () => {
    const y0 = at(runProjection(scen([{ ...chalet, owner: 0 }]), tax), 2030);
    expect(y0.spouses.map((p) => p.propertyProceeds)).toEqual([600000, 0]);
    expect(y0.spouses.map((p) => p.taxableCapitalGain)).toEqual([200000, 0]);
    const y1 = at(runProjection(scen([{ ...chalet, owner: 1 }]), tax), 2030);
    expect(y1.spouses.map((p) => p.propertyProceeds)).toEqual([0, 600000]);
    expect(y1.spouses.map((p) => p.taxableCapitalGain)).toEqual([0, 200000]);
  });
  it("le conjoint qui détient tout paie plus d'impôt que deux conjoints à parts égales (impôt progressif)", () => {
    const joint = sum(at(runProjection(scen([chalet]), tax), 2030), (p) => p.tax);
    const seul = sum(at(runProjection(scen([{ ...chalet, owner: 0 }]), tax), 2030), (p) => p.tax);
    expect(seul).toBeGreaterThan(joint + 1000);
  });
  it("au décès d'un propriétaire, sa part passe au survivant sans impôt, et la vente est imposée au survivant", () => {
    const dead = person("A", 1971, { deathAge: 57 });           // décède fin 2028
    for (const owner of ["both", 0, 1] as const) {
      const rows = runProjection(scen([{ ...chalet, owner }], {}, dead), tax);
      const y = at(rows, 2030);
      expect(y.spouses[0].alive).toBe(false);
      expect(y.spouses.map((p) => p.propertyProceeds)).toEqual([0, 600000]);
      expect(y.spouses.map((p) => p.taxableCapitalGain)).toEqual([0, 200000]);
      for (const yr of [2027, 2028]) expect(sum(at(rows, yr), (p) => p.propertyProceeds)).toBe(0);      // aucune vente avant 2030
    }
  });
  it("une vente l'année du décès est répartie normalement (le décès survient en fin d'année)", () => {
    const y = at(runProjection(scen([chalet], {}, person("A", 1971, { deathAge: 59 })), tax), 2030);       // décès fin 2030
    expect(y.spouses[0].alive).toBe(true);
    expect(y.spouses.map((p) => p.propertyProceeds)).toEqual([300000, 300000]);
  });
  it("les gains et les pertes de la même année se compensent, par propriétaire", () => {
    const gain: Property = { ...chalet, label: "A", purchasePrice: 200000, salePrice: 400000 };           // +200 000 $
    const perte: Property = { ...chalet, label: "B", purchasePrice: 300000, salePrice: 260000 };          // -40 000 $
    const y = at(runProjection(scen([gain, perte]), tax), 2030);
    expect(y.spouses.map((p) => p.taxableCapitalGain)).toEqual([40000, 40000]);                           // (200 000 - 40 000) x 50 % / 2
    expect(sum(y, (p) => p.propertyProceeds)).toBe(660000);
  });
  it("une perte en capital n'est pas déduite du revenu : le gain imposable est nul, jamais négatif", () => {
    const perte: Property = { ...chalet, purchasePrice: 700000, salePrice: 500000 };
    const y = at(runProjection(scen([perte]), tax), 2030);
    expect(y.spouses.map((p) => p.taxableCapitalGain)).toEqual([0, 0]);
    expect(sum(y, (p) => p.propertyProceeds)).toBe(500000);
    const gain: Property = { ...chalet, label: "G", purchasePrice: 100000, salePrice: 150000 };
    const net = at(runProjection(scen([gain, { ...perte, label: "P", purchasePrice: 300000, salePrice: 100000 }]), tax), 2030);
    expect(net.spouses.map((p) => p.taxableCapitalGain)).toEqual([0, 0]);                                  // perte nette
  });
  it("deux ventes d'années différentes sont traitées chacune dans leur année", () => {
    const rows = runProjection(scen([chalet, { ...chalet, label: "Maison", saleYear: 2035, salePrice: 900000, purchasePrice: 400000 }]), tax);
    expect(sum(at(rows, 2030), (p) => p.propertyProceeds)).toBe(600000);
    expect(sum(at(rows, 2035), (p) => p.propertyProceeds)).toBe(900000);
    expect(sum(at(rows, 2035), (p) => p.taxableCapitalGain)).toBe(250000);
    expect(sum(at(rows, 2031), (p) => p.propertyProceeds)).toBe(0);
  });
  it("un immeuble sans vente, vendu après la fin du plan ou avant son début n'a aucun effet", () => {
    const sans = JSON.stringify(runProjection(scen(undefined), tax));
    expect(JSON.stringify(runProjection(scen([]), tax))).toBe(sans);
    expect(JSON.stringify(runProjection(scen([{ ...chalet, saleYear: undefined, salePrice: undefined }]), tax))).toBe(sans);
    expect(JSON.stringify(runProjection(scen([{ ...chalet, saleYear: 2090 }]), tax))).toBe(sans);
    expect(JSON.stringify(runProjection(scen([{ ...chalet, saleYear: 2020 }]), tax))).toBe(sans);
    expect(JSON.stringify(runProjection(scen([{ ...chalet, saleYear: 2030, salePrice: undefined }]), tax))).toBe(sans);
  });
  it("la vente n'est pas modifiée par le calcul : le scénario d'origine reste intact", () => {
    const s = scen([chalet]);
    const before = JSON.stringify(s);
    runProjection(s, tax);
    expect(JSON.stringify(s)).toBe(before);
  });
  it("après la vente, l'argent placé fait croître le patrimoine financier", () => {
    const avec = runProjection(scen([chalet]), tax), sans = runProjection(scen([]), tax);
    const last = (rows: typeof avec) => { const y = rows[rows.length - 1]; return sum(y, (p) => p.reerBalanceEnd + p.celiBalanceEnd + p.nonRegBalanceEnd); };
    expect(last(avec)).toBeGreaterThan(last(sans) + 300000);
    const fin = (rows: typeof avec) => summarize("", { kind: "reer-first" }, rows, scen([]).assumptions).afterTaxEstate;
    expect(fin(avec)).toBeGreaterThan(fin(sans));
  });
  it("un gain élevé peut faire récupérer la PSV l'année de la vente seulement", () => {
    const a = person("A", 1960, { psv: { annualAmount: 8700, startAge: 65 }, reer: 100000 }), b = person("B", 1960, { psv: { annualAmount: 8700, startAge: 65 }, reer: 100000 });
    const rows = runProjection(scen([{ ...chalet, saleYear: 2028 }], {}, a, b), tax);
    expect(sum(at(rows, 2028), (p) => p.psvClawback)).toBeGreaterThan(1000);
    expect(sum(at(rows, 2027), (p) => p.psvClawback)).toBe(0);
    expect(sum(at(rows, 2029), (p) => p.psvClawback)).toBe(0);
  });
  it("la fonte du REER tient compte du gain : pas de retrait forcé quand le revenu dépasse déjà le plafond", () => {
    const meltdown = { strategy: { kind: "meltdown" as const, ceiling: 90000 } };
    const sans = runProjection(scen([], meltdown), tax), avec = runProjection(scen([chalet], meltdown), tax);
    expect(sum(at(sans, 2030), (p) => p.reerWithdrawal)).toBeGreaterThan(100000);       // sans vente : la fonte retire jusqu'au plafond
    expect(sum(at(avec, 2030), (p) => p.reerWithdrawal)).toBe(0);                       // avec la vente : le gain occupe déjà le plafond
  });
  it("les stratégies et les durées de vie fonctionnent avec des immeubles", () => {
    const s = scen([chalet]);
    const strat = compareStrategies(s, tax, defaultCandidates().slice(0, 3));
    expect(strat.length).toBe(3);
    expect(strat.every((r) => Number.isFinite(r.afterTaxEstate))).toBe(true);
    const dead = applyDeathScenario(s, { label: "x", deathAges: [60, undefined] });
    expect(dead.properties?.length).toBe(1);
  });
});

describe("manque par conjoint", () => {
  const person = (name: string, birthYear: number, deathAge?: number) => ({
    name, birthYear, deathAge,
    dbPensions: [{ label: "RPA", annualAmount: 40000, startAge: 62, indexation: 0.02, survivorPct: 0.6 }],
    rrq: { annualAmount: 14000, startAge: 65 }, psv: { annualAmount: 8700, startAge: 65 }, reer: 300000, celi: 40000, celiRoom: 40000,
  });
  const mk = (share: number, deathA?: number): Scenario => ({
    spouses: [person("A", 1960, deathA), person("B", 1962)], targetNetSpending: 160000, firstSpouseSpendingShare: share,
    assumptions: { startYear: 2026, endAge: 95, inflation: 0.02, rrqIndexation: 0.02, psvIndexation: 0.02, reerReturn: 0.04, celiReturn: 0.04 },
  });

  it("le manque du ménage est réparti selon la part des dépenses, et la somme des deux parts est le manque du ménage", () => {
    const rows = runProjection(mk(0.7), tax);
    const short = rows.filter((y) => y.shortfall > 1);
    expect(short.length).toBeGreaterThan(5);
    for (const y of rows) {
      expect(y.spouses[0].shortfall + y.spouses[1].shortfall).toBeCloseTo(y.shortfall, 6);
      expect(y.spouses[0].shortfall).toBeCloseTo(y.shortfall * y.spouses[0].spendingShare, 6);
    }
    for (const y of short) {
      expect(y.spouses[0].shortfall).toBeCloseTo(0.7 * y.shortfall, 6);
      expect(y.spouses[1].shortfall).toBeCloseTo(0.3 * y.shortfall, 6);
    }
  });
  it("sans manque, les deux parts sont nulles", () => {
    const rows = runProjection({ ...mk(0.5), targetNetSpending: 60000 }, tax);
    expect(rows.every((y) => y.shortfall < 1)).toBe(true);
    expect(rows.every((y) => y.spouses[0].shortfall === 0 && y.spouses[1].shortfall === 0)).toBe(true);
  });
  it("après un décès, tout le manque revient au survivant et le défunt n'en a aucun", () => {
    const rows = runProjection(mk(0.7, 70), tax);        // A décède fin 2030
    const after = rows.filter((y) => y.year > 2030 && y.shortfall > 1);
    expect(after.length).toBeGreaterThan(3);
    for (const y of after) {
      expect(y.spouses[0].shortfall).toBe(0);
      expect(y.spouses[1].shortfall).toBeCloseTo(y.shortfall, 6);
    }
  });
  it("la répartition ne change pas le manque du ménage", () => {
    const a = runProjection(mk(0.5), tax), b = runProjection(mk(0.9), tax);
    expect(a.map((y) => y.shortfall)).toEqual(b.map((y) => y.shortfall));
  });
});
