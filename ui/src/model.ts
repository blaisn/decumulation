import table2026 from "../../src/engine/data/tax-2026.json";
import { psvFactor, rrqFactor } from "../../src/index";
import type { BenefitChoice, CompareOptions, DbPension, ExtraExpense, OtherIncome, Property, Scenario, SpouseInput, Strategy } from "../../src/index";
import { fmtMoney } from "./format";

// L'état du formulaire garde les valeurs telles que saisies (texte); la conversion se fait dans `toScenario`.

export interface PensionForm {
  label: string; amount: string; startAge: string; indexation: string; survivorPct: string;
  harmonization: boolean; // harmonisation avec la RRQ à 65 ans (case à cocher)
  amountAt65: string; // montant à partir de 65 ans; vide = identique au montant annuel
}
/** Revenu d'un conjoint saisi dans le formulaire (salaire, location, héritage...). Annuel : montant de l'année de début, indexé; ponctuel : dollars de son année. */
export interface IncomeForm {
  label: string;
  amount: string;
  frequency: "annual" | "once";
  taxable: boolean; // imposable : traité comme un salaire (revenu ordinaire, non fractionnable)
  startYear: string; endYear: string; indexation: string; // annuel
  year: string; // ponctuel
}
export interface SpouseForm {
  name: string; birthYear: string; deathAge: string; lifeExpectancy: string;
  reer: string; celi: string; celiRoom: string; nonReg: string;
  rrqAmount: string; rrqStartAge: string; psvAmount: string; psvStartAge: string;
  pensions: PensionForm[];
  incomes: IncomeForm[];
  expenseShare?: string; // % des dépenses du couple dont ce conjoint a la charge : saisi pour le premier, déduit (100 − part) pour le second
}
export interface StrategyForm { kind: Strategy["kind"]; ceiling: string; usePsvThreshold: boolean; untilAge: string }
export interface AssumptionsForm {
  startYear: string; endAge: string; inflation: string; rrqIndexation: string; psvIndexation: string;
  reerReturn: string; celiReturn: string; nonRegReturn: string; nonRegTaxedShare: string;
  celiAnnualLimit: string; survivorSpendingRatio: string; rrqSurvivorCap: string;
  applySplitting: boolean; // fractionnement du revenu de pension (case à cocher)
}
/** Immeuble saisi dans le formulaire : tous les champs sont du texte, comme le reste du formulaire. */
export interface PropertyForm {
  label: string;
  owner: "both" | "0" | "1"; // propriétaire : les deux conjoints ou le conjoint 1 / 2
  principalResidence: boolean; // gain en capital exonéré d'impôt
  purchaseYear: string; // avant le début du plan
  purchasePrice: string; // prix d'achat (coût fiscal); facultatif tant qu'il n'y a pas de vente imposable
  saleYear: string; // vide : pas de vente pendant le plan
  salePrice: string; // en dollars courants de l'année de vente
}
/** Dépense supplémentaire saisie dans le formulaire : montant net en dollars de l'année de départ, indexé jusqu'à son année. */
export interface ExtraExpenseForm {
  label: string;
  year: string; // à partir de l'année de départ
  amount: string;
}
export interface FormState {
  version: 1;
  spending: string;
  assumptions: AssumptionsForm;
  estateTaxRate: string;
  nonRegTaxRate: string;
  spouses: [SpouseForm, SpouseForm];
  properties: PropertyForm[];
  extraExpenses: ExtraExpenseForm[];
  strategy: StrategyForm;
}

const pension = (label: string, amount: string): PensionForm => ({ label, amount, startAge: "62", indexation: "2", survivorPct: "60", harmonization: false, amountAt65: "" });
const spouse = (name: string, birthYear: string, pensionAmount: string, expenseShare?: string): SpouseForm => ({
  ...(expenseShare === undefined ? {} : { expenseShare }),
  name, birthYear, deathAge: "", lifeExpectancy: "21",
  reer: "600000", celi: "90000", celiRoom: "40000", nonReg: "0",
  rrqAmount: "14000", rrqStartAge: "65", psvAmount: "8700", psvStartAge: "65",
  pensions: [pension("Régime de retraite", pensionAmount)],
  incomes: [],
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
    properties: [],
    extraExpenses: [],
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

/** Nouvel immeuble : acheté il y a 15 ans, sans vente (il n'a donc aucun effet sur le plan tant qu'on n'ajoute pas de vente). */
export function newProperty(startYear = "2026"): PropertyForm {
  const y = parseInt(startYear, 10);
  return { label: "", owner: "both", principalResidence: false, purchaseYear: String(Number.isFinite(y) ? y - 15 : 2011), purchasePrice: "", saleYear: "", salePrice: "" };
}

/** Nouveau revenu : annuel et imposable, à partir du début du plan, indexé de 2 %, de montant nul (sans effet tant qu'on ne le remplit pas). */
export function newIncome(startYear = "2026"): IncomeForm {
  return { label: "", amount: "0", frequency: "annual", taxable: true, startYear: startYear.trim() || "2026", endYear: "", indexation: "2", year: startYear.trim() || "2026" };
}

/**
 * Aperçu d'un revenu : montants dans le plan et nature fiscale, ou avertissement (hors du plan, après le décès).
 * Chaîne vide tant que les champs nécessaires ne sont pas valides.
 */
export function incomeHint(f: FormState, i: number, j: number): string {
  const sp = f.spouses[i], r = sp?.incomes[j];
  if (!r) return "";
  const planStart = parseNumber(f.assumptions.startYear), amount = parseNumber(r.amount);
  const births = f.spouses.map((s) => parseNumber(s.birthYear)), endAge = parseNumber(f.assumptions.endAge);
  if (!Number.isFinite(planStart) || !Number.isFinite(amount) || amount < 0 || !births.every(Number.isFinite) || !Number.isFinite(endAge)) return "";
  const lastYear = Math.max(...births) + endAge;
  const death = parseNumber(sp.deathAge), deathYear = Number.isFinite(death) ? births[i] + death : Infinity;
  const kind = r.taxable ? "imposable, comme un salaire (non fractionnable)" : "non imposable";
  if (r.frequency === "once") {
    const year = parseNumber(r.year);
    if (!Number.isInteger(year) || year < planStart) return "";
    if (amount === 0) return "Montant nul : ce revenu n'a aucun effet.";
    const text = `Reçu en ${year} : ${fmtMoney(amount)} (dollars de ${year}), ${kind}.`;
    if (year > lastYear) return `${text} Cette année est après la fin du plan (${lastYear}) : aucun effet.`;
    if (year > deathYear) return `${text} Cette année est après le décès prévu (${deathYear}) : aucun effet.`;
    return text;
  }
  const start = parseNumber(r.startYear), index = parseNumber(r.indexation) / 100;
  const hasEnd = r.endYear.trim() !== "", end = hasEnd ? parseNumber(r.endYear) : Infinity;
  if (!Number.isInteger(start) || start < planStart || !Number.isFinite(index) || (hasEnd && (!Number.isInteger(end) || end < start))) return "";
  if (amount === 0) return "Montant nul : ce revenu n'a aucun effet.";
  const last = Math.min(end, lastYear, deathYear);
  if (start > last) return `Ce revenu commence après ${start > deathYear ? `le décès prévu (${deathYear})` : `la fin du plan (${lastYear})`} : aucun effet.`;
  let total = 0;
  for (let y = start; y <= last; y++) total += amount * Math.pow(1 + index, y - start);
  let text = `${fmtMoney(amount)} en ${start}`;
  if (last > start) text += `, ${fmtMoney(amount * Math.pow(1 + index, last - start))} en ${last}`;
  text += `; ${fmtMoney(total)} au total dans le plan; ${kind}.`;
  if (last === deathYear && last < Math.min(end, lastYear)) text += ` Arrêté au décès prévu (${deathYear}).`;
  else if (hasEnd && end > lastYear) text += ` Le plan se termine en ${lastYear}.`;
  return text;
}

/** Nouvelle dépense supplémentaire : cinq ans après le début du plan, montant nul (sans effet tant qu'on ne le remplit pas). */
export function newExtraExpense(startYear = "2026"): ExtraExpenseForm {
  const y = parseInt(startYear, 10);
  return { label: "", year: String(Number.isFinite(y) ? y + 5 : 2031), amount: "0" };
}

/** Part imposable d'un gain en capital (table fiscale 2026). */
export const CAPITAL_GAINS_INCLUSION = (table2026 as unknown as { capitalGainsInclusion: number }).capitalGainsInclusion;

/** Nombre d'immeubles désignés « résidence principale » : une famille ne peut en désigner qu'une par année. */
export const principalResidenceCount = (f: FormState) => f.properties.filter((p) => p.principalResidence).length;

/**
 * Aperçu d'une dépense supplémentaire : montant en dollars courants de son année, ou avertissement.
 * Chaîne vide tant que l'année ou le montant n'est pas valide.
 */
export function extraExpenseHint(f: FormState, j: number): string {
  const e = f.extraExpenses[j];
  if (!e) return "";
  const startYear = parseNumber(f.assumptions.startYear), inflation = parseNumber(f.assumptions.inflation) / 100;
  const year = parseNumber(e.year), amount = parseNumber(e.amount);
  if (!Number.isInteger(year) || !Number.isFinite(amount) || amount < 0 || !Number.isFinite(startYear) || !Number.isFinite(inflation) || year < startYear) return "";
  if (amount === 0) return "Montant nul : cette dépense n'a aucun effet.";
  let text = `Soit ${fmtMoney(amount * Math.pow(1 + inflation, year - startYear))} en dollars courants de ${year}, après impôt.`;
  const births = f.spouses.map((s) => parseNumber(s.birthYear)), endAge = parseNumber(f.assumptions.endAge);
  if (births.every(Number.isFinite) && Number.isFinite(endAge)) {
    const lastYear = Math.max(...births) + endAge;
    if (year > lastYear) text += ` Cette dépense a lieu après la fin du plan (${lastYear}) : elle n'a aucun effet.`;
  }
  return text;
}

/**
 * Aperçu d'un immeuble : prix de vente en dollars de départ, gain en capital et impôt, ou avertissement.
 * Chaîne vide tant que les champs nécessaires ne sont pas valides.
 */
export function propertyHint(f: FormState, j: number): string {
  const p = f.properties[j];
  if (!p) return "";
  if (p.saleYear.trim() === "") return "Sans année de vente, l'immeuble n'est pas vendu pendant le plan : il n'a aucun effet sur les calculs.";
  const startYear = parseNumber(f.assumptions.startYear), inflation = parseNumber(f.assumptions.inflation) / 100;
  const saleYear = parseNumber(p.saleYear), price = parseNumber(p.salePrice), cost = parseNumber(p.purchasePrice);
  if (!Number.isInteger(saleYear) || !Number.isFinite(price) || price < 0) return "";
  const parts: string[] = [];
  if (Number.isFinite(startYear) && Number.isFinite(inflation) && saleYear >= startYear) {
    parts.push(`prix de vente de ${fmtMoney(price / Math.pow(1 + inflation, saleYear - startYear))} en dollars de ${startYear}`);
  }
  if (p.principalResidence) parts.push("résidence principale : gain exonéré d'impôt");
  else if (Number.isFinite(cost) && cost >= 0) {
    const gain = price - cost;
    parts.push(gain > 0 ? `gain en capital de ${fmtMoney(gain)}, dont ${fmtMoney(gain * CAPITAL_GAINS_INCLUSION)} imposables` : gain < 0 ? `perte en capital de ${fmtMoney(-gain)} (sans effet sur l'impôt)` : "aucun gain en capital");
  }
  let text = parts.length ? parts.join("; ").replace(/^./, (c) => c.toUpperCase()) + "." : "";
  const births = f.spouses.map((s) => parseNumber(s.birthYear)), endAge = parseNumber(f.assumptions.endAge);
  if (births.every(Number.isFinite) && Number.isFinite(endAge)) {
    const lastYear = Math.max(...births) + endAge;
    if (saleYear > lastYear) text += `${text ? " " : ""}Cette vente a lieu après la fin du plan (${lastYear}) : elle n'a aucun effet.`;
  }
  return text;
}

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
      ...(s.incomes.length ? {
        otherIncomes: s.incomes.map((r, j): OtherIncome => {
          const Li = (x: string) => L(`revenu ${j + 1}${r.label.trim() ? ` (${r.label.trim()})` : ""}, ${x}`);
          const label = r.label.trim() || `Revenu ${j + 1}`;
          const amount = need(Li("montant"), r.amount, { min: 0 });
          const early = (what: string, y: number) => { if (Number.isFinite(y) && startYear > 0 && y < startYear) errors.push(Li(`${what} ${y} : elle doit être à partir du début du plan (${startYear}). Pour un revenu déjà en cours, entrez l'année de départ du plan et le montant actuel.`)); };
          if (r.frequency === "once") {
            const year = need(Li("année"), r.year, { int: true, min: 1800, max: 2200 });
            early("année", year);
            return { label, amount, taxable: r.taxable, frequency: "once", year };
          }
          const start = need(Li("année de début"), r.startYear, { int: true, min: 1800, max: 2200 });
          early("année de début", start);
          const end = need(Li("année de fin"), r.endYear, { int: true, min: 1800, max: 2200, optional: true });
          if (Number.isFinite(start) && Number.isFinite(end) && end < start) errors.push(Li(`année de fin ${end} : elle doit être au moins l'année de début (${start}).`));
          const indexation = need(Li("indexation"), r.indexation, { min: -20, max: 20 }) / 100;
          return { label, amount, taxable: r.taxable, frequency: "annual", startYear: start, ...(Number.isFinite(end) ? { endYear: end } : {}), indexation };
        }),
      } : {}),
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

  // Dépenses supplémentaires : montants nets, en dollars de l'année de départ, à partir de cette année-là.
  const extraExpenses = f.extraExpenses.map((e, j): ExtraExpense => {
    const L = (x: string) => `Dépense supplémentaire ${j + 1}${e.label.trim() ? ` (${e.label.trim()})` : ""} : ${x}`;
    const year = need(L("année"), e.year, { int: true, min: 1800, max: 2200 });
    if (e.year.trim() !== "" && Number.isFinite(year) && startYear > 0 && year < startYear) errors.push(L(`année ${year} : elle doit être à partir du début du plan (${startYear}).`));
    const amount = need(L("montant"), e.amount, { min: 0 });
    return { label: e.label.trim() || `Dépense ${j + 1}`, year, amount };
  });

  // Immeubles : achetés avant le début du plan (l'achat pendant le plan n'est pas encore pris en charge), sans hypothèque.
  const properties = f.properties.map((p, j): Property => {
    const name = p.label.trim() || `Immeuble ${j + 1}`;
    const L = (x: string) => `Immeuble ${j + 1}${p.label.trim() ? ` (${p.label.trim()})` : ""} : ${x}`;
    const hasSale = p.saleYear.trim() !== "";
    const purchaseYear = need(L("année d'achat"), p.purchaseYear, { int: true, min: 1800, max: 2200 });
    if (p.purchaseYear.trim() !== "" && Number.isFinite(purchaseYear) && startYear > 0 && purchaseYear >= startYear) {
      errors.push(L(`année d'achat ${purchaseYear} : elle doit précéder le début du plan (${startYear}). L'achat d'un immeuble pendant le plan n'est pas encore pris en charge.`));
    }
    const saleYear = need(L("année de vente"), p.saleYear, { int: true, min: 1800, max: 2200, optional: true });
    if (hasSale && Number.isFinite(saleYear) && startYear > 0 && saleYear < startYear) errors.push(L(`année de vente ${saleYear} : elle doit être à partir du début du plan (${startYear}).`));
    // Le prix de vente est obligatoire s'il y a une vente; le prix d'achat aussi, sauf pour une résidence principale (gain exonéré).
    const salePrice = need(L("prix de vente"), p.salePrice, { min: 0, optional: !hasSale });
    const purchasePrice = need(L("prix d'achat"), p.purchasePrice, { min: 0, optional: !hasSale || p.principalResidence });
    return {
      label: name, owner: p.owner === "0" ? 0 : p.owner === "1" ? 1 : "both", purchaseYear,
      purchasePrice: Number.isFinite(purchasePrice) ? purchasePrice : 0,
      ...(hasSale ? { saleYear, salePrice } : {}),
      principalResidence: p.principalResidence,
    };
  });

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
    ...(properties.length ? { properties } : {}),
    ...(extraExpenses.length ? { extraExpenses } : {}),
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
    const base = mergeStr({ ...d.spouses[i], pensions: undefined, incomes: undefined } as unknown as Record<string, string>, s) as unknown as SpouseForm;
    const list = Array.isArray(s?.pensions) ? s!.pensions : d.spouses[i].pensions;
    const startYear = str(src.assumptions?.startYear, d.assumptions.startYear);
    const incomes = (Array.isArray(s?.incomes) ? s!.incomes : []).map((r) => { const m = mergeStr(newIncome(startYear), r) as IncomeForm; return { ...m, frequency: m.frequency === "once" ? "once" : "annual" } as IncomeForm; });
    return { ...base, pensions: list.map((p) => mergeStr(newPension(), p)), incomes };
  }) as [SpouseForm, SpouseForm];
  const properties = (Array.isArray(src.properties) ? src.properties : []).map((p) => {
    const merged = mergeStr(newProperty(str(src.assumptions?.startYear, d.assumptions.startYear)), p);
    return { ...merged, owner: (["both", "0", "1"] as const).includes(merged.owner) ? merged.owner : "both" } as PropertyForm;
  });
  const extraExpenses = (Array.isArray(src.extraExpenses) ? src.extraExpenses : []).map((e) => mergeStr(newExtraExpense(str(src.assumptions?.startYear, d.assumptions.startYear)), e) as ExtraExpenseForm);
  return {
    version: 1,
    spending: str(src.spending, d.spending),
    assumptions: mergeStr(d.assumptions, src.assumptions),
    estateTaxRate: str(src.estateTaxRate, d.estateTaxRate),
    nonRegTaxRate: str(src.nonRegTaxRate, d.nonRegTaxRate),
    spouses,
    properties,
    extraExpenses,
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
  owner: "propriétaire", principalResidence: "résidence principale", purchaseYear: "année d'achat", purchasePrice: "prix d'achat", saleYear: "année de vente", salePrice: "prix de vente",
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
    if (/^properties\.\d+\.owner$/.test(path)) return v === "both" ? "les deux" : who(v);
    if (/^spouses\.\d\.incomes\.\d+\.frequency$/.test(path)) return v === "once" ? "ponctuel" : "annuel";
    return v === "true" ? "oui" : v === "false" ? "non" : v;
  };
  const label = (path: string): string => {
    const seg = path.split(".");
    const last = KEY_LABELS[seg[seg.length - 1]] ?? seg[seg.length - 1];
    if (seg[0] === "spouses" && seg[2] === "pensions") return `${who(seg[1])}, rente ${+seg[3] + 1} (${last})`;
    if (seg[0] === "spouses" && seg[2] === "incomes") return `${who(seg[1])}, revenu ${+seg[3] + 1} (${({ label: "nom", amount: "montant", frequency: "fréquence", taxable: "imposable", startYear: "début", endYear: "fin", indexation: "indexation", year: "année" } as Record<string, string>)[seg[4]] ?? seg[4]})`;
    if (seg[0] === "properties") return `Immeuble ${+seg[1] + 1} (${last})`;
    if (seg[0] === "extraExpenses") return `Dépense supplémentaire ${+seg[1] + 1} (${({ label: "nom", year: "année", amount: "montant" } as Record<string, string>)[seg[2]] ?? seg[2]})`;
    // Minuscule initiale, sauf pour les sigles (REER/FERR, CELI, RRQ, PSV).
    const lower = /^[A-ZÀ-Ý][a-zà-ÿ]/.test(last) ? last.charAt(0).toLowerCase() + last.slice(1) : last;
    if (seg[0] === "spouses") return `${who(seg[1])}, ${lower}`;
    return last;
  };
  const out: string[] = [];
  const pensionNoted = new Set<string>();
  const notePension = (path: string, verb: string) => {
    const m = /^spouses\.(\d)\.pensions\.(\d+)\./.exec(path);
    if (m) {
      const key = `${verb}${m[1]}.${m[2]}`;
      if (!pensionNoted.has(key)) { pensionNoted.add(key); out.push(`${who(m[1])} : rente ${+m[2] + 1} ${verb}`); }
      return true;
    }
    const inc = /^spouses\.(\d)\.incomes\.(\d+)\./.exec(path);
    if (inc) {
      const key = `revenu${verb}${inc[1]}.${inc[2]}`;
      if (!pensionNoted.has(key)) { pensionNoted.add(key); out.push(`${who(inc[1])} : revenu ${+inc[2] + 1} ${verb.replace(/ée$/, "é")}`); }
      return true;
    }
    const e = /^extraExpenses\.(\d+)\./.exec(path);
    if (e) {
      const key = `depense${verb}${e[1]}`;
      if (!pensionNoted.has(key)) { pensionNoted.add(key); out.push(`Dépense supplémentaire ${+e[1] + 1} ${verb}`); }
      return true;
    }
    const q = /^properties\.(\d+)\./.exec(path);
    if (!q) return false;
    const key = `immeuble${verb}${q[1]}`;
    if (!pensionNoted.has(key)) { pensionNoted.add(key); out.push(`Immeuble ${+q[1] + 1} ${verb.replace(/ée$/, "é")}`); }
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
