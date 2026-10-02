import { STRATEGY_NAMES, benefitHint, shareComplement } from "./model";
import type { FormState, SpouseForm } from "./model";
import { esc } from "./format";

// Le formulaire est généré en HTML; chaque champ porte son chemin dans l'état (data-path).

interface FieldOpts { suffix?: string; hint?: string; wide?: boolean; placeholder?: string }

const field = (label: string, path: string, value: string, o: FieldOpts = {}) =>
  `<label class="f${o.wide ? " wide" : ""}"><span class="lab">${esc(label)}</span><span class="ctl"><input type="text" inputmode="decimal" autocomplete="off" data-path="${path}" value="${esc(value)}"${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ""}>${o.suffix ? `<span class="suf">${esc(o.suffix)}</span>` : ""}</span>${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ""}</label>`;

const textField = (label: string, path: string, value: string, o: FieldOpts = {}) =>
  field(label, path, value, o).replace('inputmode="decimal"', 'inputmode="text"');

function pensionRows(sp: SpouseForm, i: number): string {
  if (!sp.pensions.length) return `<p class="empty">Aucune rente : ajoutez celle d'un régime de retraite d'employeur, s'il y en a une.</p>`;
  return sp.pensions.map((p, j) => {
    const base = `spouses.${i}.pensions.${j}`;
    return `<div class="pension"><div class="grid pgrid">
      ${textField("Nom de la rente", `${base}.label`, p.label, { wide: true })}
      ${field("Montant annuel", `${base}.amount`, p.amount, { suffix: "$", hint: p.harmonization ? "Avant 65 ans" : undefined })}
      ${field("Début à", `${base}.startAge`, p.startAge, { suffix: "ans" })}
      ${field("Indexation", `${base}.indexation`, p.indexation, { suffix: "%" })}
      ${field("Versée au survivant", `${base}.survivorPct`, p.survivorPct, { suffix: "%" })}
    </div>
    <div class="grid pgrid harm">
      <label class="check wide"><input type="checkbox" data-path="${base}.harmonization" data-rerender="1"${p.harmonization ? " checked" : ""}><span>Harmonisation RRQ à 65 ans</span></label>
      ${p.harmonization ? field("Montant de la pension à 65 ans", `${base}.amountAt65`, p.amountAt65, { suffix: "$", wide: true, placeholder: p.amount, hint: "Laissé vide : identique au montant annuel. Entrez la rente après harmonisation, pas le montant de la réduction." }) : ""}
    </div>
    <button type="button" class="link danger" data-action="remove-pension" data-spouse="${i}" data-index="${j}">Retirer cette rente</button></div>`;
  }).join("");
}

/** Part des dépenses du couple : saisie pour le premier conjoint, affichage seulement (100 − part) pour le second. */
function shareField(first: SpouseForm, i: number): string {
  if (i === 0) return field("Part des dépenses du couple dont il a la charge", "spouses.0.expenseShare", first.expenseShare ?? "50", { suffix: "%", wide: true, hint: "Répartit les dépenses visées entre les conjoints dans le CSV. Le deuxième conjoint a le reste." });
  return `<label class="f wide"><span class="lab">Part des dépenses du couple dont il a la charge</span><span class="ctl"><input type="text" readonly aria-readonly="true" tabindex="-1" data-share-complement value="${esc(shareComplement(first.expenseShare))}"><span class="suf">%</span></span><span class="hint">100 % moins la part du premier conjoint (affichage seulement)</span></label>`;
}

function spouseSection(sp: SpouseForm, i: number, open: boolean, first: SpouseForm): string {
  const b = `spouses.${i}`;
  return `<details class="sec" data-sec="spouse${i}"${open ? " open" : ""}><summary><span data-title="${i}">${esc(sp.name.trim() || `Conjoint ${i + 1}`)}</span></summary><div class="body">
    <div class="grid">
      ${textField("Prénom", `${b}.name`, sp.name)}
      ${field("Année de naissance", `${b}.birthYear`, sp.birthYear)}
      ${field("Âge au décès, si on veut le tester", `${b}.deathAge`, sp.deathAge, { suffix: "ans", placeholder: "aucun", wide: true })}
      ${shareField(first, i)}
      ${field("Espérance de vie à 65 ans", `${b}.lifeExpectancy`, sp.lifeExpectancy, { suffix: "ans", wide: true, hint: "Sert à l'onglet Ordre des décès. Québec, 2025 : 19,8 ans pour un homme, 22,1 ans pour une femme (ISQ). Ajustez selon la santé et pour tenir compte des gains futurs de longévité." })}
    </div>
    <fieldset><legend>Épargne</legend><div class="grid">
      ${field("REER/FERR", `${b}.reer`, sp.reer, { suffix: "$" })}
      ${field("CELI", `${b}.celi`, sp.celi, { suffix: "$" })}
      ${field("Droits de cotisation CELI inutilisés", `${b}.celiRoom`, sp.celiRoom, { suffix: "$" })}
      ${field("Compte non enregistré", `${b}.nonReg`, sp.nonReg, { suffix: "$" })}
    </div></fieldset>
    <fieldset><legend>Rente du Québec et pension de la sécurité de la vieillesse</legend><div class="grid">
      ${field("RRQ, montant annuel à 65 ans", `${b}.rrqAmount`, sp.rrqAmount, { suffix: "$", hint: "Avant réduction ou bonification" })}
      ${field("RRQ, début à", `${b}.rrqStartAge`, sp.rrqStartAge, { suffix: "ans", hint: "De 60 à 72 ans" })}
      <p class="hint wide benefit" data-benefit-hint="${b}.rrq" aria-live="polite">${esc(benefitHint("rrq", sp.rrqAmount, sp.rrqStartAge))}</p>
      ${field("PSV, montant annuel à 65 ans", `${b}.psvAmount`, sp.psvAmount, { suffix: "$", hint: "Avant bonification de report. Ajoutez la bonification de 10 % à 75 ans si elle s'applique" })}
      ${field("PSV, début à", `${b}.psvStartAge`, sp.psvStartAge, { suffix: "ans", hint: "De 65 à 70 ans" })}
      <p class="hint wide benefit" data-benefit-hint="${b}.psv" aria-live="polite">${esc(benefitHint("psv", sp.psvAmount, sp.psvStartAge))}</p>
    </div></fieldset>
    <fieldset><legend>Rentes de régimes à prestations déterminées</legend>
      ${pensionRows(sp, i)}
      <button type="button" class="link" data-action="add-pension" data-spouse="${i}">Ajouter une rente</button>
    </fieldset>
  </div></details>`;
}

export function renderForm(f: FormState, openSecs: Set<string>): string {
  const a = f.assumptions;
  const st = f.strategy;
  const needsCeiling = st.kind === "ceiling" || st.kind === "meltdown";
  const o = (k: string) => openSecs.has(k);
  return `
  <details class="sec" data-sec="general"${o("general") ? " open" : ""}><summary>Hypothèses du plan</summary><div class="body"><div class="grid">
    ${field("Dépenses nettes annuelles du couple", "spending", f.spending, { suffix: "$", wide: true, hint: `En dollars de ${esc(a.startYear)}, après impôt` })}
    ${field("Début du plan", "assumptions.startYear", a.startYear)}
    ${field("Fin du plan, quand le plus jeune atteint", "assumptions.endAge", a.endAge, { suffix: "ans" })}
    ${field("Inflation", "assumptions.inflation", a.inflation, { suffix: "%" })}
    ${field("Dépenses du survivant", "assumptions.survivorSpendingRatio", a.survivorSpendingRatio, { suffix: "%", hint: "Part des dépenses du couple" })}
    ${field("Rendement du REER/FERR", "assumptions.reerReturn", a.reerReturn, { suffix: "%" })}
    ${field("Rendement du CELI", "assumptions.celiReturn", a.celiReturn, { suffix: "%" })}
  </div></div></details>
  ${spouseSection(f.spouses[0], 0, o("spouse0"), f.spouses[0])}
  ${spouseSection(f.spouses[1], 1, o("spouse1"), f.spouses[0])}
  <details class="sec" data-sec="strategy"${o("strategy") ? " open" : ""}><summary>Stratégie de retrait</summary><div class="body">
    <label class="f wide"><span class="lab">Ordre des retraits</span><select data-path="strategy.kind" data-rerender="1">${STRATEGY_NAMES.map(([v, t]) => `<option value="${v}"${st.kind === v ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
    ${needsCeiling ? `<div class="grid">
      <label class="check wide"><input type="checkbox" data-path="strategy.usePsvThreshold" data-rerender="1"${st.usePsvThreshold ? " checked" : ""}><span>Plafonner au seuil de récupération de la PSV</span></label>
      ${st.usePsvThreshold ? "" : field("Revenu plafond par conjoint", "strategy.ceiling", st.ceiling, { suffix: "$", hint: `En dollars de ${esc(a.startYear)}` })}
      ${st.kind === "meltdown" ? field("Fonte jusqu'à l'âge de", "strategy.untilAge", st.untilAge, { suffix: "ans", placeholder: "sans limite" }) : ""}
    </div>` : ""}
    <p class="note">${{ "reer-first": "Les dépenses sont payées par le REER/FERR, puis le compte non enregistré, puis le CELI.", "celi-first": "Le CELI est utilisé en premier, ce qui laisse le REER/FERR croître.", ceiling: "Le REER/FERR est retiré jusqu'au revenu plafond de chaque conjoint. Au-delà, on puise dans le CELI avant de dépasser le plafond.", meltdown: "Chaque année, on retire du REER/FERR jusqu'au plafond, même si les dépenses sont couvertes. Le surplus après impôt va au CELI, puis au compte non enregistré." }[st.kind]}</p>
  </div></details>
  <details class="sec" data-sec="advanced"${o("advanced") ? " open" : ""}><summary>Hypothèses avancées</summary><div class="body"><div class="grid">
    <label class="check wide"><input type="checkbox" data-path="assumptions.applySplitting"${a.applySplitting ? " checked" : ""}><span>Appliquer le fractionnement du revenu de pension</span></label>
    <p class="hint wide">Répartit chaque année jusqu'à 50 % de la pension admissible entre les conjoints (quand les deux sont en vie) pour réduire l'impôt et la récupération de la PSV. Décochez pour voir l'effet du fractionnement.</p>
    ${field("Indexation de la RRQ", "assumptions.rrqIndexation", a.rrqIndexation, { suffix: "%" })}
    ${field("Indexation de la PSV", "assumptions.psvIndexation", a.psvIndexation, { suffix: "%" })}
    ${field("Rendement du non enregistré", "assumptions.nonRegReturn", a.nonRegReturn, { suffix: "%" })}
    ${field("Part du rendement imposée chaque année", "assumptions.nonRegTaxedShare", a.nonRegTaxedShare, { suffix: "%" })}
    ${field("Plafond annuel du CELI", "assumptions.celiAnnualLimit", a.celiAnnualLimit, { suffix: "$" })}
    ${field("Plafond de la RRQ du survivant", "assumptions.rrqSurvivorCap", a.rrqSurvivorCap, { suffix: "$", hint: `En dollars de ${esc(a.startYear)}` })}
    ${field("Impôt présumé sur le REER/FERR restant", "estateTaxRate", f.estateTaxRate, { suffix: "%", hint: "Sert à classer les stratégies" })}
    ${field("Impôt présumé sur les gains non enregistrés", "nonRegTaxRate", f.nonRegTaxRate, { suffix: "%" })}
  </div></div></details>`;
}

/** Lit ou écrit une valeur dans l'état à partir d'un chemin comme « spouses.0.pensions.1.amount ». */
export function setPath(state: unknown, path: string, value: string | boolean): void {
  const keys = path.split(".");
  let cur = state as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]] as Record<string, unknown>;
  cur[keys[keys.length - 1]] = value;
}
