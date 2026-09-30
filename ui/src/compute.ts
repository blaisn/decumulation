import table2026 from "../../src/engine/data/tax-2026.json";
import { compareDeathOrders, compareLongevity, compareStrategies, indexTable, runProjection } from "../../src/index";
import type { CompareOptions, DeathOrderComparison, Scenario, StrategySummary, TaxYearTable, YearResult } from "../../src/index";
import { FIRST_TAX_YEAR } from "./model";

export type Job =
  | { kind: "plan"; scenario: Scenario }
  | { kind: "strategies"; scenario: Scenario; options: CompareOptions }
  | { kind: "deaths"; scenario: Scenario; options: CompareOptions; deathAges: number[] }
  | { kind: "longevity"; scenario: Scenario; options: CompareOptions; lifeExpectancy: [number, number]; states: number };

export type JobResult = YearResult[] | StrategySummary[] | DeathOrderComparison;

/** Table fiscale 2026 indexée à l'inflation si le plan commence plus tard (approximation). */
export function taxFor(scenario: Scenario): TaxYearTable {
  const base = table2026 as unknown as TaxYearTable;
  const years = scenario.assumptions.startYear - FIRST_TAX_YEAR;
  return years > 0 ? indexTable(base, Math.pow(1 + scenario.assumptions.inflation, years)) : base;
}

export function runJob(job: Job): JobResult {
  const tax = taxFor(job.scenario);
  if (job.kind === "plan") return runProjection(job.scenario, tax);
  if (job.kind === "strategies") return compareStrategies(job.scenario, tax, undefined, job.options);
  if (job.kind === "longevity") return compareLongevity(job.scenario, tax, undefined, { ...job.options, lifeExpectancy65: job.lifeExpectancy, states: job.states });
  return compareDeathOrders(job.scenario, tax, undefined, { ...job.options, deathAges: job.deathAges });
}
