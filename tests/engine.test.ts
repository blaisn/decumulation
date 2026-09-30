import { describe, it, expect } from "vitest";
import table2026 from "../src/engine/data/tax-2026.json";
import { progressiveTax, householdTax, optimizeSplit, indexTable, marginalRate } from "../src/engine/tax";
import { runProjection, dbAmount } from "../src/engine/projection";
import { compareStrategies, defaultCandidates, compareDeathOrders, deathScenarios, applyDeathScenario, summarize, compareLongevity, longevityScenarios } from "../src/engine/compare";
import { gompertz, representativeDeathAges } from "../src/engine/mortality";
import type { Scenario, TaxYearTable } from "../src/engine/types";

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
