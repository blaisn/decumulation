import { STRATEGY_NAMES, benefitHint, extraExpenseHint, incomeHint, principalResidenceCount, propertyHint, shareComplement } from "./model";
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

/** Revenus d'un conjoint (salaire, location, héritage...) : un bloc par revenu, annuel ou ponctuel, imposable ou non. */
function incomeRows(f: FormState, i: number): string {
  const sp = f.spouses[i];
  if (!sp.incomes.length) return `<p class="empty">Aucun revenu : ajoutez un salaire, un revenu de travail autonome, de location ou un héritage.</p>`;
  return sp.incomes.map((r, j) => {
    const b = `spouses.${i}.incomes.${j}`;
    const once = r.frequency === "once";
    return `<div class="income"><div class="grid pgrid">
      ${textField("Description", `${b}.label`, r.label, { wide: true, placeholder: `Revenu ${j + 1}` })}
      <label class="f"><span class="lab">Fréquence</span><select data-path="${b}.frequency" data-rerender="1"><option value="annual"${once ? "" : " selected"}>Annuel</option><option value="once"${once ? " selected" : ""}>Ponctuel</option></select></label>
      ${field("Montant", `${b}.amount`, r.amount, { suffix: "$", hint: once ? "En dollars de l'année du revenu" : "Montant de l'année de début" })}
      <label class="check wide"><input type="checkbox" data-path="${b}.taxable"${r.taxable ? " checked" : ""}><span>Imposable (comme un salaire : non fractionnable)</span></label>
      ${once
        ? field("Année", `${b}.year`, r.year, { hint: "À partir du début du plan" })
        : `${field("Début", `${b}.startYear`, r.startYear, { hint: "Année; à partir du début du plan" })}
      ${field("Fin", `${b}.endYear`, r.endYear, { placeholder: "fin du plan", hint: "Année; vide : jusqu'à la fin du plan" })}
      ${field("Indexation", `${b}.indexation`, r.indexation, { suffix: "%", hint: "Par an, après l'année de début" })}`}
      <p class="hint wide benefit" data-income-hint="${i}.${j}" aria-live="polite">${esc(incomeHint(f, i, j))}</p>
    </div>
    <button type="button" class="link danger" data-action="remove-income" data-spouse="${i}" data-index="${j}">Retirer ce revenu</button></div>`;
  }).join("");
}

/** Immeubles : un bloc par immeuble, avec propriétaire, résidence principale, achat et vente. */
function propertyRows(f: FormState): string {
  if (!f.properties.length) return `<p class="empty">Aucun immeuble : ajoutez une résidence, un chalet ou un immeuble à revenus que vous prévoyez vendre pendant le plan.</p>`;
  const names = f.spouses.map((s, i) => s.name.trim() || `Conjoint ${i + 1}`);
  return f.properties.map((p, j) => {
    const b = `properties.${j}`;
    const opt = (v: string, text: string, nameOf?: number) => `<option value="${v}"${p.owner === v ? " selected" : ""}${nameOf === undefined ? "" : ` data-name-opt="${nameOf}"`}>${esc(text)}</option>`;
    return `<div class="property"><div class="grid pgrid">
      ${textField("Nom de l'immeuble", `${b}.label`, p.label, { wide: true, placeholder: `Immeuble ${j + 1}` })}
      <label class="f wide"><span class="lab">Propriétaire</span><select data-path="${b}.owner">${opt("both", "Les deux, à parts égales")}${opt("0", names[0], 0)}${opt("1", names[1], 1)}</select></label>
      <label class="check wide"><input type="checkbox" data-path="${b}.principalResidence" data-rerender="1"${p.principalResidence ? " checked" : ""}><span>Résidence principale (gain en capital exonéré d'impôt)</span></label>
      ${field("Année d'achat", `${b}.purchaseYear`, p.purchaseYear, { hint: "Avant le début du plan" })}
      ${field("Prix d'achat", `${b}.purchasePrice`, p.purchasePrice, { suffix: "$", hint: p.principalResidence ? "Sans effet : gain exonéré" : "Coût fiscal, en dollars de l'année d'achat" })}
      ${field("Année de vente", `${b}.saleYear`, p.saleYear, { placeholder: "aucune" })}
      ${field("Prix de vente", `${b}.salePrice`, p.salePrice, { suffix: "$", hint: "En dollars courants de l'année de vente" })}
      <p class="hint wide benefit" data-property-hint="${j}" aria-live="polite">${esc(propertyHint(f, j))}</p>
    </div>
    <button type="button" class="link danger" data-action="remove-property" data-index="${j}">Retirer cet immeuble</button></div>`;
  }).join("");
}

/** Dépenses supplémentaires ponctuelles : une ligne par dépense, avec son année et son montant. */
function extraRows(f: FormState): string {
  if (!f.extraExpenses.length) return `<p class="empty">Aucune dépense supplémentaire : ajoutez une voiture, une rénovation, un voyage ou un cadeau prévu une année précise.</p>`;
  const start = f.assumptions.startYear.trim() || "l'année de départ";
  return f.extraExpenses.map((e, j) => {
    const b = `extraExpenses.${j}`;
    return `<div class="extra"><div class="grid pgrid">
      ${textField("Description", `${b}.label`, e.label, { wide: true, placeholder: `Dépense ${j + 1}` })}
      ${field("Année", `${b}.year`, e.year, { hint: "À partir du début du plan" })}
      ${field("Montant", `${b}.amount`, e.amount, { suffix: "$", hint: `Après impôt, en dollars de ${start}` })}
      <p class="hint wide benefit" data-extra-hint="${j}" aria-live="polite">${esc(extraExpenseHint(f, j))}</p>
    </div>
    <button type="button" class="link danger" data-action="remove-extra" data-index="${j}">Retirer cette dépense</button></div>`;
  }).join("");
}

/** Part des dépenses du couple : saisie pour le premier conjoint, affichage seulement (100 − part) pour le second. */
function shareField(first: SpouseForm, i: number): string {
  if (i === 0) return field("Part des dépenses du couple dont il a la charge", "spouses.0.expenseShare", first.expenseShare ?? "50", { suffix: "%", wide: true, hint: "Répartit les dépenses visées entre les conjoints dans le CSV. Le deuxième conjoint a le reste." });
  return `<label class="f wide"><span class="lab">Part des dépenses du couple dont il a la charge</span><span class="ctl"><input type="text" readonly aria-readonly="true" tabindex="-1" data-share-complement value="${esc(shareComplement(first.expenseShare))}"><span class="suf">%</span></span><span class="hint">100 % moins la part du premier conjoint (affichage seulement)</span></label>`;
}

function spouseSection(f: FormState, i: number, open: boolean): string {
  const sp = f.spouses[i], first = f.spouses[0];
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
    <fieldset><legend>Revenus</legend>
      <p class="note">Salaire, travail autonome, location, héritage... (les rentes de régime, la RRQ et la PSV se saisissent plus haut). Un revenu imposable s'ajoute au revenu imposable comme un salaire, sans cotisations ni déduction pour travailleur. Un revenu cesse au décès de ce conjoint.</p>
      ${incomeRows(f, i)}
      <button type="button" class="link" data-action="add-income" data-spouse="${i}">Ajouter un revenu</button>
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
  ${spouseSection(f, 0, o("spouse0"))}
  ${spouseSection(f, 1, o("spouse1"))}
  <details class="sec" data-sec="properties"${o("properties") ? " open" : ""}><summary>Immeubles${f.properties.length ? ` (${f.properties.length})` : ""}</summary><div class="body">
    <p class="note">Achetés avant le début du plan, sans hypothèque. À la vente, le produit est reçu dans l'année : il finance les dépenses, puis le surplus est placé au CELI et au compte non enregistré. Le gain en capital (imposable à 50 %) s'ajoute au revenu des propriétaires, sauf pour une résidence principale. Au décès d'un propriétaire, l'immeuble passe au conjoint survivant.</p>
    ${propertyRows(f)}
    ${principalResidenceCount(f) > 1 ? `<p class="alert soft" role="status">Plusieurs résidences principales sont cochées. Une famille ne peut en désigner qu'une par année : le calcul exonère tous les gains cochés, ce qui peut sous-estimer l'impôt.</p>` : ""}
    <button type="button" class="link" data-action="add-property">Ajouter un immeuble</button>
  </div></details>
  <details class="sec" data-sec="extras"${o("extras") ? " open" : ""}><summary>Dépenses supplémentaires${f.extraExpenses.length ? ` (${f.extraExpenses.length})` : ""}</summary><div class="body">
    <p class="note">Dépenses ponctuelles qui s'ajoutent, l'année indiquée, à la dépense annuelle visée : le revenu requis de cette année-là est la somme des deux. Les montants sont nets (après impôt) et indexés à l'inflation, comme la dépense annuelle; ils ne sont pas réduits après un décès. Elles se répartissent entre les conjoints selon leur part des dépenses.</p>
    ${extraRows(f)}
    <button type="button" class="link" data-action="add-extra">Ajouter une dépense</button>
  </div></details>
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
