import type { Assumptions, Scenario, SpouseInput, SpouseYear, Strategy, TaxYearTable, YearResult } from "./types";
import { householdTax, indexTable, optimizeSplit, type HouseholdTaxResult } from "./tax";
import { ferrMinFactor } from "./ferr";

const grow = (rate: number, n: number) => Math.pow(1 + rate, n);
const RRQ_SURVIVOR_PCT = 0.6;

/** Revenus garantis : rentes RPA (admissibles au crédit et au fractionnement), RRQ et PSV. */
function guaranteedIncome(sp: SpouseInput, age: number, n: number, a: Assumptions) {
  let db = 0, rrq = 0, psv = 0;
  for (const p of sp.dbPensions) if (age >= p.startAge) db += p.annualAmount * grow(p.indexation, n);
  if (age >= sp.rrq.startAge) rrq += sp.rrq.annualAmount * grow(a.rrqIndexation, n);
  if (age >= sp.psv.startAge) psv += sp.psv.annualAmount * grow(a.psvIndexation, n);
  return { db, rrq, psv };
}

/** Répartit un montant entre deux personnes, à parts égales, en respectant les plafonds. */
function allocate(total: number, caps: [number, number]): [number, number] {
  let a = Math.min(total / 2, caps[0]);
  const b = Math.min(total - a, caps[1]);
  a = Math.min(total - b, caps[0]);
  return [a, b];
}

const swap = (r: HouseholdTaxResult): HouseholdTaxResult => ({
  tax: [r.tax[1], r.tax[0]], federal: [r.federal[1], r.federal[0]], quebec: [r.quebec[1], r.quebec[0]],
  incomeAfterSplit: [r.incomeAfterSplit[1], r.incomeAfterSplit[0]], clawback: [r.clawback[1], r.clawback[0]],
  splitAmount: [r.splitAmount[1], r.splitAmount[0]], marginal: [r.marginal[1], r.marginal[0]],
});

/**
 * Projection année par année. Après les revenus garantis et le retrait FERR minimum,
 * les dépenses nettes visées sont financées selon `scenario.strategy` (voir `Strategy`);
 * les retraits imposables sont répartis également entre les conjoints (dans la limite de
 * leurs soldes). Le fractionnement du revenu de pension est optimisé chaque année tant
 * que les deux conjoints sont en vie.
 *
 * Décès (`deathAge`) : survenu en fin d'année. Le REER/FERR et le CELI passent au
 * survivant (roulement, sans impôt); les rentes RPA sont réduites au `survivorPct`;
 * la rente RRQ du survivant = sa rente + 60 % de celle du défunt, plafonnée;
 * la PSV du défunt cesse; les dépenses passent à `survivorSpendingRatio`;
 * le survivant est imposé seul (montant pour personne vivant seule au Québec).
 */
export function runProjection(s: Scenario, baseTax: TaxYearTable): YearResult[] {
  const a = s.assumptions;
  const spendingRatio = a.survivorSpendingRatio ?? 0.75;
  const rrqCap = a.rrqSurvivorCap ?? 17295;
  const nrReturn = a.nonRegReturn ?? a.reerReturn;
  const nrShare = a.nonRegTaxedShare ?? 0.5;
  const celiLimit = a.celiAnnualLimit ?? 7000;
  const bal = s.spouses.map((sp) => ({ reer: sp.reer, celi: sp.celi, nonReg: sp.nonRegistered ?? 0, room: sp.celiRoom ?? 0, pending: 0 }));
  const deathYear = s.spouses.map((sp) => (sp.deathAge === undefined ? Infinity : sp.birthYear + sp.deathAge));
  const results: YearResult[] = [];

  for (let year = a.startYear; ; year++) {
    const n = year - a.startYear;
    const ages = s.spouses.map((sp) => year - sp.birthYear);
    const alive = deathYear.map((d) => year <= d);
    if (!alive[0] && !alive[1]) break;
    if (Math.min(...ages.filter((_, i) => alive[i])) > a.endAge) break;
    const both = alive[0] && alive[1];

    const infl = grow(a.inflation, n);
    // Droits de cotisation au CELI : plafond annuel (arrondi à 500 $) + retraits de l'année précédente.
    if (n > 0) for (const i of [0, 1]) if (alive[i]) {
      bal[i].room += Math.round((celiLimit * infl) / 500) * 500 + bal[i].pending;
      bal[i].pending = 0;
    }
    // Part imposable du rendement du compte non enregistré, reçue en argent.
    const nrIncome = bal.map((b, i) => (alive[i] ? b.nonReg * nrReturn * nrShare : 0));
    const tax = indexTable(baseTax, infl);
    const target = s.targetNetSpending * infl * (both ? 1 : spendingRatio);

    const g = s.spouses.map((sp, i) => {
      if (!alive[i]) return { db: 0, rrq: 0, psv: 0 };
      const own = guaranteedIncome(sp, ages[i], n, a);
      if (both) return own;
      const dec = s.spouses[1 - i]; // survivant : prestations de conjoint survivant
      for (const p of dec.dbPensions) own.db += p.annualAmount * grow(p.indexation, n) * p.survivorPct;
      const cap = rrqCap * grow(a.rrqIndexation, n);
      const combined = own.rrq + RRQ_SURVIVOR_PCT * dec.rrq.annualAmount * grow(a.rrqIndexation, n);
      own.rrq = Math.max(own.rrq, Math.min(combined, cap));
      return own;
    });
    const minW = bal.map((b, i) => (alive[i] && ages[i] >= 71 ? b.reer * ferrMinFactor(ages[i]) : 0));
    const caps: [number, number] = [bal[0].reer - minW[0], bal[1].reer - minW[1]];

    const evaluate = (extra: [number, number]): HouseholdTaxResult => {
      const tp = [0, 1].map((i) => ({
        age: ages[i], psv: g[i].psv,
        income: g[i].db + g[i].rrq + g[i].psv + nrIncome[i] + minW[i] + extra[i],
        eligiblePension: g[i].db + (ages[i] >= 65 ? minW[i] + extra[i] : 0),
      }));
      if (both) return a.pensionSplitting === false ? householdTax([tp[0], tp[1]], tax) : optimizeSplit([tp[0], tp[1]], tax);
      const k = alive[0] ? 0 : 1;
      const r = householdTax([{ ...tp[k], livingAlone: true }, null], tax);
      return k === 0 ? r : swap(r);
    };
    const netFor = (extra: [number, number]) => {
      const r = evaluate(extra);
      return r.incomeAfterSplit[0] + r.incomeAfterSplit[1] - r.tax[0] - r.tax[1] - r.clawback[0] - r.clawback[1];
    };

    // Financement de la dépense nette, palier par palier selon la stratégie.
    // Un palier REER ajoute des retraits imposables (bissection jusqu'à l'atteinte de la cible,
    // ou intégralement si `force`); les paliers non enregistré et CELI ajoutent de l'argent non imposable.
    type Tier = { kind: "celi" } | { kind: "nonreg" } | { kind: "reer"; caps: [number, number]; force?: boolean };
    const strategy: Strategy = s.strategy ?? { kind: "reer-first" };
    const ceilingOf = (c: number | "psv-threshold") => (c === "psv-threshold" ? tax.federal.psvClawback.threshold : c * infl);
    const base = [0, 1].map((i) => g[i].db + g[i].rrq + g[i].psv + nrIncome[i] + minW[i]);
    const capsUpTo = (ceiling: number, ageLimit = Infinity): [number, number] => [0, 1].map((i) => (ages[i] <= ageLimit ? Math.min(caps[i], Math.max(0, ceiling - base[i])) : 0)) as [number, number];
    const rest = (first: [number, number]): [number, number] => [caps[0] - first[0], caps[1] - first[1]];
    let tiers: Tier[];
    if (strategy.kind === "celi-first") tiers = [{ kind: "celi" }, { kind: "nonreg" }, { kind: "reer", caps }];
    else if (strategy.kind === "ceiling") {
      const first = capsUpTo(ceilingOf(strategy.ceiling));
      tiers = [{ kind: "reer", caps: first }, { kind: "nonreg" }, { kind: "celi" }, { kind: "reer", caps: rest(first) }];
    } else if (strategy.kind === "meltdown") {
      const first = capsUpTo(ceilingOf(strategy.ceiling), strategy.untilAge);
      tiers = [{ kind: "reer", caps: first, force: true }, { kind: "nonreg" }, { kind: "celi" }, { kind: "reer", caps: rest(first) }];
    } else tiers = [{ kind: "reer", caps }, { kind: "nonreg" }, { kind: "celi" }];

    const celiCaps: [number, number] = [bal[0].celi, bal[1].celi];
    const nrCaps: [number, number] = [bal[0].nonReg, bal[1].nonReg];
    let extra: [number, number] = [0, 0];
    let celiUsed = 0, nrUsed = 0;
    const funded = (e: [number, number]) => netFor(e) + celiUsed + nrUsed;
    for (const tier of tiers) {
      const forced = tier.kind === "reer" && tier.force === true;
      if (!forced && funded(extra) >= target) break;
      if (tier.kind === "celi") {
        celiUsed += Math.min(celiCaps[0] + celiCaps[1] - celiUsed, target - funded(extra));
        continue;
      }
      if (tier.kind === "nonreg") {
        nrUsed += Math.min(nrCaps[0] + nrCaps[1] - nrUsed, target - funded(extra));
        continue;
      }
      const capT = tier.caps[0] + tier.caps[1];
      if (capT <= 0) continue;
      const from = extra;
      const at = (t: number): [number, number] => {
        const inc = allocate(t, tier.caps);
        return [from[0] + inc[0], from[1] + inc[1]];
      };
      if (forced || funded(at(capT)) <= target) extra = at(capT);
      else {
        let lo = 0, hi = capT;
        for (let k = 0; k < 40; k++) {
          const mid = (lo + hi) / 2;
          if (funded(at(mid)) < target) lo = mid; else hi = mid;
        }
        extra = at(hi);
      }
    }
    const r = evaluate(extra);
    const celiW = allocate(celiUsed, celiCaps);
    const nrW = allocate(nrUsed, nrCaps);
    const total = funded(extra);
    const celiNeed = Math.max(0, target - total);

    // Tout surplus net (fonte du REER, ou retraits FERR minimums supérieurs aux dépenses) est réinvesti :
    // d'abord au CELI (dans la limite des droits), puis au compte non enregistré.
    const surplus = Math.max(0, total - target);
    const roomCaps: [number, number] = [alive[0] ? bal[0].room : 0, alive[1] ? bal[1].room : 0];
    const celiIn = allocate(Math.min(surplus, roomCaps[0] + roomCaps[1]), roomCaps);
    const nrIn = allocate(surplus - celiIn[0] - celiIn[1], [alive[0] ? Infinity : 0, alive[1] ? Infinity : 0]);

    // Fin d'année : retraits, rendements, cotisations, puis roulement au survivant en cas de décès.
    const reerW = [0, 1].map((i) => minW[i] + extra[i]);
    for (const i of [0, 1]) {
      bal[i].reer = (bal[i].reer - reerW[i]) * (1 + a.reerReturn);
      bal[i].celi = (bal[i].celi - celiW[i]) * (1 + a.celiReturn) + celiIn[i];
      bal[i].nonReg = (bal[i].nonReg - nrW[i]) * (1 + nrReturn * (1 - nrShare)) + nrIn[i];
      bal[i].room += -celiIn[i];
      bal[i].pending += celiW[i];
    }
    for (const i of [0, 1]) {
      if (deathYear[i] === year && deathYear[1 - i] > year) {
        bal[1 - i].reer += bal[i].reer; bal[1 - i].celi += bal[i].celi; bal[1 - i].nonReg += bal[i].nonReg;
        bal[i].reer = 0; bal[i].celi = 0; bal[i].nonReg = 0;
      }
    }

    const spouseYears = [0, 1].map((i): SpouseYear => ({
      age: ages[i], alive: alive[i], guaranteedIncome: g[i].db + g[i].rrq + g[i].psv,
      pensionIncome: g[i].db, rrqIncome: g[i].rrq, psvIncome: g[i].psv,
      reerWithdrawal: reerW[i], celiWithdrawal: celiW[i],
      taxableIncome: r.incomeAfterSplit[i] - r.clawback[i], psvClawback: r.clawback[i], pensionSplit: r.splitAmount[i], tax: r.tax[i],
      reerBalanceEnd: bal[i].reer, celiBalanceEnd: bal[i].celi,
      nonRegIncome: nrIncome[i], nonRegWithdrawal: nrW[i], celiContribution: celiIn[i], nonRegContribution: nrIn[i], nonRegBalanceEnd: bal[i].nonReg,
      marginalRate: alive[i] ? r.marginal[i] : 0,
    })) as [SpouseYear, SpouseYear];

    results.push({ year, spouses: spouseYears, targetSpending: target, netIncome: target - celiNeed, shortfall: celiNeed });
  }
  return results;
}
