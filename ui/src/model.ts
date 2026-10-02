import table2026 from "../../src/engine/data/tax-2026.json";
import { psvFactor, rrqFactor } from "../../src/index";
import type { BenefitChoice, CompareOptions, DbPension, Scenario, SpouseInput, Strategy } from "../../src/index";
import { fmtMoney } from "./format";

// L'état du formulaire garde les valeurs telles que saisies (texte); la conversion se fait dans `toScenario`.

export interface PensionForm {
  label: string; amount: string; startAge: string; indexation: string; survivorPct: string;
  harmonization: boolean; // harmonisation avec la RRQ à 65 ans (case à cocher)
  amountAt65: string; // montant à partir de 65 ans; vide = identique au montant annuel
}
export interface SpouseForm {
  name: string; birthYear: string; deathAge: string; lifeExpectancy: string;
  reer: string; celi: string; celiRoom: string; nonReg: string;
  rrqAmount: string; rrqStartAge: string; psvAmount: string; psvStartAge: string;
  pensions: PensionForm[];
  expenseShare?: string; // % des dépenses du couple dont ce conjoint a la charge : saisi pour le premier, déduit (100 − part) pour le second
}
export interface StrategyForm { kind: Strategy["kind"]; ceiling: string; usePsvThreshold: boolean; untilAge: string }
export interface AssumptionsForm {
  startYear: string; endAge: string; inflation: string; rrqIndexation: string; psvIndexation: string;
  reerReturn: string; celiReturn: string; nonRegReturn: string; nonRegTaxedShare: string;
  celiAnnualLimit: string; survivorSpendingRatio: string; rrqSurvivorCap: string;
  applySplitting: boolean; // fractionnement du revenu de pension (case à cocher)
}
export interface FormState {
  version: 1;
  spending: string;
  assumptions: AssumptionsForm;
  estateTaxRate: string;
  nonRegTaxRate: string;
  spouses: [SpouseForm, SpouseForm];
  strategy: StrategyForm;
}

const pension = (label: string, amount: string): PensionForm => ({ label, amount, startAge: "62", indexation: "2", survivorPct: "60", harmonization: false, amountAt65: "" });
const spouse = (name: string, birthYear: string, pensionAmount: string, expenseShare?: string): SpouseForm => ({
  ...(expenseShare === undefined ? {} : { expenseShare }),
  name, birthYear, deathAge: "", lifeExpectancy: "21",
  reer: "600000", celi: "90000", celiRoom: "40000", nonReg: "0",
  rrqAmount: "14000", rrqStartAge: "65", psvAmount: "8700", psvStartAge: "65",
  pensions: [pension("Régime de retraite", pensionAmount)],
});

/** Valeurs d'exemple : un couple fictif, à remplacer par la situation réelle. */
export function defaultForm(): FormState {
  return {
    version: 1,
    spending: "100000",
    assumptions: {
      startYear: "2026", endAge: "95", inflation: "2", rrqIndexation: "2", psvIndexation: "2",
      reerReturn: "4", celiReturn: "4", nonRegReturn: "4", nonRegTaxedShare: "50",
      celiAnnualLimit: "7000", survivorSpendingRatio: "75", rrqSurvivorCap: "17295", applySplitting: true,
    },
    estateTaxRate: "45",
    nonRegTaxRate: "10",
    spouses: [spouse("Alex", "1960", "45000", "50"), spouse("Sam", "1962", "25000")],
    strategy: { kind: "reer-first", ceiling: "90000", usePsvThreshold: true, untilAge: "" },
  };
}

/** Rente RRQ maximale à 65 ans (en $ de l'année de la table fiscale) : sert à la réduction avant 65 ans. */
export const RRQ_MAX_AT_65 = (table2026 as unknown as { rrqMaxAt65: number }).rrqMaxAt65;

/**
 * Aperçu de la rente ajustée selon l'âge de début : le montant saisi est celui de 65 ans.
 * Retourne une chaîne vide tant que le montant ou l'âge n'est pas valide.
 */
export function benefitHint(kind: "rrq" | "psv", amountText: string, ageText: string): string {
  const amount = parseNumber(amountText), age = parseNumber(ageText);
  const [lo, hi] = kind === "rrq" ? [60, 72] : [65, 70];
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(age) || age < lo || age > hi) return "";
  const factor = kind === "rrq" ? rrqFactor(age, amount, RRQ_MAX_AT_65) : psvFactor(age);
  if (Math.abs(factor - 1) < 1e-9) return `À ${age} ans : le montant de 65 ans, sans réduction ni bonification.`;
  const pct = Math.abs(factor - 1) * 100;
  const sign = factor > 1 ? "+" : "−";
  return `À ${age} ans : ${fmtMoney(amount * factor)} par année, soit ${sign}${pct.toLocaleString("fr-CA", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} % par rapport à 65 ans.`;
}

/** Applique une combinaison d'âges de début (RRQ et PSV de chaque conjoint) au formulaire. */
export function applyBenefitChoice(f: FormState, c: BenefitChoice): void {
  ([0, 1] as const).forEach((i) => {
    f.spouses[i].rrqStartAge = String(c.rrq[i]);
    f.spouses[i].psvStartAge = String(c.psv[i]);
  });
}

/** Part du second conjoint, déduite de celle du premier (« 100 − part »); « — » si la saisie n'est pas valide. */
export function shareComplement(firstShare: string | undefined): string {
  const v = parseNumber(firstShare ?? "");
  if (!Number.isFinite(v) || v < 0 || v > 100) return "—";
  return (100 - v).toLocaleString("fr-CA", { maximumFractionDigits: 2 });
}

export function newPension(): PensionForm { return pension("", "0"); }

export function parseNumber(s: string): number {
  const t = String(s).replace(/[\s\u00a0\u202f$%]/g, "").replace(",", ".");
  return t === "" ? NaN : Number(t);
}

export interface Parsed { scenario?: Scenario; options: CompareOptions; errors: string[]; lifeExpectancy: [number, number] }

export const FIRST_TAX_YEAR = 2026;

export function toScenario(f: FormState): Parsed {
  const errors: string[] = [];
  const need = (label: string, raw: string, o: { min?: number; max?: number; int?: boolean; optional?: boolean } = {}): number => {
    if (raw.trim() === "") {
      if (!o.optional) errors.push(`${label} : entrez une valeur.`);
      return o.optional ? NaN : 0;
    }
    const v = parseNumber(raw);
    if (!Number.isFinite(v)) { errors.push(`${label} : « ${raw} » n'est pas un nombre.`); return 0; }
    if (o.int && !Number.isInteger(v)) errors.push(`${label} : entrez un nombre entier.`);
    if (o.min !== undefined && v < o.min) errors.push(`${label} : la valeur doit être d'au moins ${o.min}.`);
    if (o.max !== undefined && v > o.max) errors.push(`${label} : la valeur doit être d'au plus ${o.max}.`);
    return v;
  };
  const pct = (label: string, raw: string, max = 100) => need(label, raw, { min: 0, max }) / 100;

  const a = f.assumptions;
  const startYear = need("Année de départ du plan", a.startYear, { int: true, min: FIRST_TAX_YEAR, max: 2100 });
  const endAge = need("Âge de fin du plan", a.endAge, { int: true, min: 60, max: 120 });
  const spending = need("Dépenses nettes annuelles", f.spending, { min: 0 });
  const lifeExpectancy: [number, number] = [21, 21];
  const share0 = need(`${f.spouses[0].name.trim() || "Conjoint 1"} : part des dépenses du couple`, f.spouses[0].expenseShare ?? "50", { min: 0, max: 100 }) / 100;

  const spouses = f.spouses.map((s, i): SpouseInput => {
    const n = s.name.trim() || `Conjoint ${i + 1}`;
    const L = (x: string) => `${n} : ${x}`;
    const birthYear = need(L("année de naissance"), s.birthYear, { int: true, min: 1900, max: 2100 });
    const deathAge = need(L("âge au décès"), s.deathAge, { int: true, min: 0, max: 120, optional: true });
    lifeExpectancy[i] = need(L("espérance de vie à 65 ans"), s.lifeExpectancy, { min: 8, max: 35 });
    if (Number.isFinite(deathAge) && birthYear + deathAge < startYear) errors.push(L(`décès prévu en ${birthYear + deathAge}, avant le début du plan (${startYear}).`));
    return {
      name: n,
      birthYear,
      deathAge: Number.isFinite(deathAge) ? deathAge : undefined,
      reer: need(L("solde REER/FERR"), s.reer, { min: 0 }),
      celi: need(L("solde CELI"), s.celi, { min: 0 }),
      celiRoom: need(L("droits CELI inutilisés"), s.celiRoom, { min: 0 }),
      nonRegistered: need(L("compte non enregistré"), s.nonReg, { min: 0 }),
      rrq: { annualAmount: need(L("rente RRQ annuelle"), s.rrqAmount, { min: 0 }), startAge: need(L("âge de début de la RRQ"), s.rrqStartAge, { int: true, min: 60, max: 72 }) },
      psv: { annualAmount: need(L("PSV annuelle"), s.psvAmount, { min: 0 }), startAge: need(L("âge de début de la PSV"), s.psvStartAge, { int: true, min: 65, max: 70 }) },
      dbPensions: s.pensions.map((p, j): DbPension => {
        const annualAmount = need(L(`rente ${j + 1}, montant annuel`), p.amount, { min: 0 });
        const pension: DbPension = {
          label: p.label.trim() || `Rente ${j + 1}`,
          annualAmount,
          startAge: need(L(`rente ${j + 1}, âge de début`), p.startAge, { int: true, min: 40, max: 100 }),
          indexation: pct(L(`rente ${j + 1}, indexation`), p.indexation, 20),
          survivorPct: pct(L(`rente ${j + 1}, part versée au survivant`), p.survivorPct),
        };
        // Harmonisation RRQ : le montant à 65 ans, par défaut le montant annuel (aucun changement à 65 ans).
        if (p.harmonization) pension.amountAt65 = p.amountAt65.trim() === "" ? annualAmount : need(L(`rente ${j + 1}, montant à 65 ans`), p.amountAt65, { min: 0 });
        return pension;
      }),
    };
  }) as [SpouseInput, SpouseInput];

  if (errors.length === 0) {
    const youngest = Math.min(...spouses.map((s) => startYear - s.birthYear));
    if (endAge <= youngest) errors.push(`Âge de fin du plan : doit dépasser l'âge du plus jeune conjoint au départ (${youngest} ans).`);
  }

  const st = f.strategy;
  let strategy: Strategy = { kind: "reer-first" };
  if (st.kind === "celi-first") strategy = { kind: "celi-first" };
  if (st.kind === "ceiling" || st.kind === "meltdown") {
    const ceiling = st.usePsvThreshold ? ("psv-threshold" as const) : need("Revenu plafond par conjoint", st.ceiling, { min: 0 });
    if (st.kind === "ceiling") strategy = { kind: "ceiling", ceiling };
    else {
      const until = need("Fonte du REER, jusqu'à l'âge", st.untilAge, { int: true, min: 55, max: 120, optional: true });
      strategy = { kind: "meltdown", ceiling, untilAge: Number.isFinite(until) ? until : undefined };
    }
  }

  const scenario: Scenario = {
    spouses,
    targetNetSpending: spending,
    firstSpouseSpendingShare: share0,
    strategy,
    assumptions: {
      startYear, endAge,
      inflation: pct("Inflation", a.inflation, 20),
      rrqIndexation: pct("Indexation de la RRQ", a.rrqIndexation, 20),
      psvIndexation: pct("Indexation de la PSV", a.psvIndexation, 20),
      reerReturn: need("Rendement du REER/FERR", a.reerReturn, { min: -20, max: 30 }) / 100,
      celiReturn: need("Rendement du CELI", a.celiReturn, { min: -20, max: 30 }) / 100,
      nonRegReturn: need("Rendement du compte non enregistré", a.nonRegReturn, { min: -20, max: 30 }) / 100,
      nonRegTaxedShare: pct("Part imposable du rendement non enregistré", a.nonRegTaxedShare),
      celiAnnualLimit: need("Plafond annuel de cotisation au CELI", a.celiAnnualLimit, { min: 0 }),
      survivorSpendingRatio: pct("Dépenses du survivant", a.survivorSpendingRatio, 150),
      rrqSurvivorCap: need("Plafond de la rente RRQ du survivant", a.rrqSurvivorCap, { min: 0 }),
      pensionSplitting: a.applySplitting,
    },
  };
  const options: CompareOptions = { estateTaxRate: pct("Impôt présumé sur le REER restant", f.estateTaxRate), nonRegTaxRate: pct("Impôt présumé sur le non enregistré", f.nonRegTaxRate) };
  return errors.length ? { options, errors, lifeExpectancy } : { scenario, options, errors, lifeExpectancy };
}

export function strategyToForm(s: Strategy, current: StrategyForm): StrategyForm {
  const out: StrategyForm = { ...current, kind: s.kind };
  if (s.kind === "ceiling" || s.kind === "meltdown") {
    out.usePsvThreshold = s.ceiling === "psv-threshold";
    if (typeof s.ceiling === "number") out.ceiling = String(s.ceiling);
  }
  out.untilAge = s.kind === "meltdown" && s.untilAge !== undefined ? String(s.untilAge) : "";
  return out;
}

/** Relit un scénario enregistré : complète les champs manquants avec les valeurs par défaut. */
export function formFromJson(text: string): FormState {
  const raw = JSON.parse(text) as Partial<FormState> & { form?: Partial<FormState> };
  const src = (raw.form ?? raw) as Partial<FormState>;
  if (!src || typeof src !== "object" || !("spouses" in src)) throw new Error("Ce fichier ne contient pas de scénario de retraite.");
  const d = defaultForm();
  const str = (v: unknown, fallback: string) => (typeof v === "string" || typeof v === "number" ? String(v) : fallback);
  const mergeStr = <T extends object>(base: T, over: unknown): T => {
    const o = (over ?? {}) as Record<string, unknown>;
    const out = { ...base } as Record<string, unknown>;
    for (const k of Object.keys(base)) {
      const b = (base as Record<string, unknown>)[k];
      out[k] = typeof b === "boolean" ? (typeof o[k] === "boolean" ? o[k] : b) : str(o[k], String(b));
    }
    return out as T;
  };
  const spouses = [0, 1].map((i) => {
    const s = (src.spouses as SpouseForm[] | undefined)?.[i];
    const base = mergeStr({ ...d.spouses[i], pensions: undefined } as unknown as Record<string, string>, s) as unknown as SpouseForm;
    const list = Array.isArray(s?.pensions) ? s!.pensions : d.spouses[i].pensions;
    return { ...base, pensions: list.map((p) => mergeStr(newPension(), p)) };
  }) as [SpouseForm, SpouseForm];
  return {
    version: 1,
    spending: str(src.spending, d.spending),
    assumptions: mergeStr(d.assumptions, src.assumptions),
    estateTaxRate: str(src.estateTaxRate, d.estateTaxRate),
    nonRegTaxRate: str(src.nonRegTaxRate, d.nonRegTaxRate),
    spouses,
    strategy: mergeStr(d.strategy, src.strategy),
  };
}

export function formToJson(f: FormState): string {
  return JSON.stringify({ application: "decumulation", form: f }, null, 2);
}

// ---------------------------------------------------------------------------
// Données de base : un instantané du formulaire auquel on peut revenir
// ---------------------------------------------------------------------------

export interface BaseSnapshot { savedAt: string; form: FormState }

export const STRATEGY_NAMES: [Strategy["kind"], string][] = [
  ["reer-first", "REER/FERR d'abord, puis CELI"],
  ["celi-first", "CELI d'abord, puis REER/FERR"],
  ["ceiling", "REER/FERR jusqu'à un revenu plafond, puis CELI"],
  ["meltdown", "Fonte du REER/FERR : retirer plus que nécessaire"],
];

const KEY_LABELS: Record<string, string> = {
  spending: "Dépenses nettes annuelles", startYear: "Début du plan", endAge: "Fin du plan", inflation: "Inflation",
  survivorSpendingRatio: "Dépenses du survivant", reerReturn: "Rendement du REER/FERR", celiReturn: "Rendement du CELI",
  rrqIndexation: "Indexation de la RRQ", psvIndexation: "Indexation de la PSV", nonRegReturn: "Rendement du non enregistré",
  nonRegTaxedShare: "Part imposable du rendement", celiAnnualLimit: "Plafond annuel du CELI", rrqSurvivorCap: "Plafond de la RRQ du survivant", applySplitting: "Fractionnement du revenu de pension",
  estateTaxRate: "Impôt présumé sur le REER/FERR restant", nonRegTaxRate: "Impôt présumé sur le non enregistré",
  name: "Prénom", birthYear: "Année de naissance", deathAge: "Âge au décès", lifeExpectancy: "Espérance de vie à 65 ans", reer: "REER/FERR", celi: "CELI", celiRoom: "Droits CELI inutilisés",
  nonReg: "Compte non enregistré", rrqAmount: "RRQ, montant à 65 ans", rrqStartAge: "RRQ, début", psvAmount: "PSV, montant à 65 ans", psvStartAge: "PSV, début",
  label: "nom", amount: "montant annuel", startAge: "début", indexation: "indexation", survivorPct: "part au survivant",
  harmonization: "harmonisation RRQ à 65 ans", amountAt65: "montant à 65 ans",
  expenseShare: "Part des dépenses du couple",
  kind: "Ordre des retraits", ceiling: "Revenu plafond", usePsvThreshold: "Plafond au seuil de la PSV", untilAge: "Fonte jusqu'à l'âge",
};

function flatten(v: unknown, path: string, out: Map<string, string>): Map<string, string> {
  if (Array.isArray(v)) v.forEach((x, i) => flatten(x, path ? `${path}.${i}` : String(i), out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) flatten(x, path ? `${path}.${k}` : k, out);
  else out.set(path, typeof v === "boolean" ? String(v) : String(v ?? ""));
  return out;
}

/** Deux saisies sont égales si ce sont les mêmes nombres (« 100000 » et « 100 000 ») ou le même texte. */
function same(a: string, b: string): boolean {
  const x = parseNumber(a), y = parseNumber(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : a.trim() === b.trim();
}

/** Chemins (« spouses.0.reer ») dont la valeur diffère de la base, ou qui n'existent que d'un côté. */
export function changedPaths(base: FormState, cur: FormState): Set<string> {
  const a = flatten(base, "", new Map()), b = flatten(cur, "", new Map());
  const out = new Set<string>();
  for (const [p, v] of b) { const w = a.get(p); if (w === undefined || !same(w, v)) out.add(p); }
  for (const p of a.keys()) if (!b.has(p)) out.add(p);
  return out;
}

/** Liste lisible des changements depuis la base, dans l'ordre du formulaire. */
export function describeChanges(base: FormState, cur: FormState): string[] {
  const a = flatten(base, "", new Map()), b = flatten(cur, "", new Map());
  const who = (i: string) => cur.spouses[+i]?.name.trim() || base.spouses[+i]?.name.trim() || `Conjoint ${+i + 1}`;
  const show = (path: string, v: string) => {
    if (v === "") return "vide";
    if (path === "strategy.kind") return STRATEGY_NAMES.find(([k]) => k === v)?.[1] ?? v;
    return v === "true" ? "oui" : v === "false" ? "non" : v;
  };
  const label = (path: string): string => {
    const seg = path.split(".");
    const last = KEY_LABELS[seg[seg.length - 1]] ?? seg[seg.length - 1];
    if (seg[0] === "spouses" && seg[2] === "pensions") return `${who(seg[1])}, rente ${+seg[3] + 1} (${last})`;
    // Minuscule initiale, sauf pour les sigles (REER/FERR, CELI, RRQ, PSV).
    const lower = /^[A-ZÀ-Ý][a-zà-ÿ]/.test(last) ? last.charAt(0).toLowerCase() + last.slice(1) : last;
    if (seg[0] === "spouses") return `${who(seg[1])}, ${lower}`;
    return last;
  };
  const out: string[] = [];
  const pensionNoted = new Set<string>();
  const notePension = (path: string, verb: string) => {
    const m = /^spouses\.(\d)\.pensions\.(\d+)\./.exec(path);
    if (!m) return false;
    const key = `${verb}${m[1]}.${m[2]}`;
    if (!pensionNoted.has(key)) { pensionNoted.add(key); out.push(`${who(m[1])} : rente ${+m[2] + 1} ${verb}`); }
    return true;
  };
  for (const [p, v] of b) {
    const w = a.get(p);
    if (w === undefined) { if (!notePension(p, "ajoutée")) out.push(`${label(p)} : ajouté`); }
    else if (!same(w, v)) out.push(`${label(p)} : ${show(p, w)} → ${show(p, v)}`);
  }
  for (const p of a.keys()) if (!b.has(p) && !notePension(p, "retirée")) out.push(`${label(p)} : retiré`);
  return out;
}

/** Fichier de scénario : les données actuelles et, s'il y en a, les données de base. */
export function fileToJson(form: FormState, base: BaseSnapshot | null): string {
  return JSON.stringify({ application: "decumulation", form, ...(base ? { base } : {}) }, null, 2);
}

export function fileFromJson(text: string): { form: FormState; base: BaseSnapshot | null } {
  const form = formFromJson(text);
  const raw = JSON.parse(text) as { base?: { savedAt?: unknown; form?: unknown } };
  let base: BaseSnapshot | null = null;
  if (raw.base && typeof raw.base === "object" && raw.base.form) {
    base = { savedAt: typeof raw.base.savedAt === "string" ? raw.base.savedAt : new Date().toISOString(), form: formFromJson(JSON.stringify({ form: raw.base.form })) };
  }
  return { form, base };
}
