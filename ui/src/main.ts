import { gompertz, representativeDeathAges, summarize } from "../../src/index";
import { benefitRanges, enumerateChoices, rankResults } from "../../src/index";
import type { CompareOptions, DeathOrderComparison, FreeChoices, OptimizationResult, Scenario, StrategySummary, YearResult } from "../../src/index";
import { runJob } from "./compute";
import type { Job, JobResult } from "./compute";
import { BALANCE_LEGEND, PROPERTY_LEGEND, SOURCE_LEGEND, balancesChart, legend, sourcesChart } from "./charts";
import { comparePanel } from "./compare-view";
import { planToCsv } from "./csv";
import { esc, fmtMoney } from "./format";
import { renderForm, setPath } from "./form";
import { changedPaths, defaultForm, describeChanges, fileFromJson, fileToJson, formFromJson, formToJson, newPension, newProperty, propertyHint, shareComplement, strategyToForm, toScenario, applyBenefitChoice, benefitHint } from "./model";
import type { BaseSnapshot, FormState } from "./model";
import { confirmDialog } from "./dialog";
import { OptimizationCancelled, runChoices, workerCount } from "./optimize-run";
import type { OptimizationRun, PoolDeps, PoolWorker } from "./optimize-run";
import { durationText, estimateSeconds, optionRows, plannedCount, progressText, resultsTable, verdictHtml } from "./optimize-view";
import { openScenarioFile, saveFile } from "./platform";
import { parsePrefs } from "./prefs";
import { deathBestTable, deathMatrix, deathRankTable, strategiesTable, yearTable } from "./tables";

// Clés du stockage local (formulaire, données de base, préférences).
const STORE_KEY = "decumulation.form.v1";
const BASE_KEY = "decumulation.base.v1";
const PREFS_KEY = "decumulation.prefs.v1";
type Tab = "plan" | "detail" | "compare" | "strategies" | "deaths" | "optim";

// ---------------------------------------------------------------- état
let form: FormState = loadSaved() ?? defaultForm();
let base: BaseSnapshot | null = loadBase();
let changesOpen = false;
const openSecs = new Set(["general", "spouse0", "spouse1"]);
let tab: Tab = "plan";
/** Préférences : dollars constants (true) ou courants avec l'inflation (false, par défaut); formulaire masqué ou non. */
const prefs = (() => { try { return parsePrefs(localStorage.getItem(PREFS_KEY)); } catch { return parsePrefs(null); } })();
let real = prefs.real;
let hideForm = prefs.hideForm;
let hideDetailNote = prefs.hideDetailNote;
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ real, hideForm, hideDetailNote })); } catch { /* stockage indisponible */ } }
let deathAgesText = "75, 80, 85, 90";
let deathMode: "longevity" | "first" = "longevity";
let longevityStates = 5;
let deathsMode: "longevity" | "first" = "longevity"; // mode des résultats affichés

let plan: { scenario: Scenario; rows: YearResult[]; estateRates: { estateTaxRate?: number; nonRegTaxRate?: number }; longevity: [number, number] } | null = null;
let planErrors: string[] = [];
let basePlan: { scenario: Scenario; rows: YearResult[]; options: CompareOptions } | null = null;
let baseErrors: string[] = [];
let strategies: StrategySummary[] | null = null;
let deaths: DeathOrderComparison | null = null;
const stale = { strategies: false, deaths: false, optim: false };
const busy = { strategies: false, deaths: false, optim: false };

// Optimisation PSV/RRQ : décisions à explorer, résultats, calcul en cours.
let optimFree: FreeChoices = { rrq: [true, true], psv: [true, true] };
let optim: OptimizationResult | null = null;
let optimScenario: Scenario | null = null;
let optimRun: OptimizationRun | null = null;
let optimProgress = { done: 0, total: 0, startedAt: 0 };
let optimDirty = false;     // le formulaire a changé pendant le calcul
const expandedYears = new Set<number>();      // années dépliées dans le Détail annuel (conservées d'un affichage à l'autre)
let planMs = 0;             // durée mesurée (dans le worker) d'un calcul de plan : sert à estimer la durée de l'optimisation
let lastComputeMs = 0;
let compareError = "";

function loadSaved(): FormState | null {
  try {
    const t = localStorage.getItem(STORE_KEY);
    return t ? formFromJson(t) : null;
  } catch { return null; }
}
function loadBase(): BaseSnapshot | null {
  try {
    const t = localStorage.getItem(BASE_KEY);
    if (!t) return null;
    const raw = JSON.parse(t) as { savedAt?: string; form?: unknown };
    return raw.form ? { savedAt: raw.savedAt ?? new Date().toISOString(), form: formFromJson(JSON.stringify({ form: raw.form })) } : null;
  } catch { return null; }
}
function persistBase() {
  try { if (base) localStorage.setItem(BASE_KEY, JSON.stringify(base)); else localStorage.removeItem(BASE_KEY); } catch { /* stockage indisponible */ }
}
function persist() { try { localStorage.setItem(STORE_KEY, formToJson(form)); } catch { /* stockage indisponible */ } }

// ---------------------------------------------------------------- calculs (worker, sinon fil principal)
let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, { job: Job; resolve: (r: JobResult) => void; reject: (e: Error) => void }>();

function inline(job: Job): Promise<JobResult> {
  return new Promise((resolve, reject) => setTimeout(() => {
    try { const t0 = performance.now(); const r = runJob(job); lastComputeMs = performance.now() - t0; resolve(r); } catch (e) { reject(e as Error); }
  }, 30));
}
function ensureWorker() {
  if (worker || workerBroken) return;
  try {
    worker = new Worker("worker.js");
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: JobResult; error?: string; ms?: number }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ms !== undefined) lastComputeMs = e.data.ms;
      if (e.data.ok) p.resolve(e.data.result!); else p.reject(new Error(e.data.error));
    };
    worker.onerror = () => {
      workerBroken = true; worker = null;
      for (const [id, p] of pending) { pending.delete(id); inline(p.job).then(p.resolve, p.reject); }
    };
  } catch { workerBroken = true; }
}
function run(job: Job): Promise<JobResult> {
  ensureWorker();
  if (!worker) return inline(job);
  const id = nextId++;
  return new Promise((resolve, reject) => { pending.set(id, { job, resolve, reject }); worker!.postMessage({ id, job }); });
}

let planToken = 0;
let planTimer = 0;
let planPending = false;     // le formulaire a changé et le plan n'est pas encore recalculé : `plan` ne correspond plus au formulaire
function schedulePlan(delay = 250) {
  window.clearTimeout(planTimer);
  planPending = true;
  planTimer = window.setTimeout(async () => {
    const parsed = toScenario(form);
    planErrors = parsed.errors;
    if (!parsed.scenario) { plan = null; planPending = false; renderPanel(); return; }
    const token = ++planToken;
    try {
      const rows = (await run({ kind: "plan", scenario: parsed.scenario })) as YearResult[];
      if (token !== planToken) return;
      if (lastComputeMs > 0) planMs = lastComputeMs;
      plan = { scenario: parsed.scenario, rows, estateRates: parsed.options, longevity: parsed.lifeExpectancy };
      planErrors = [];
    } catch (e) {
      planErrors = [`Le calcul a échoué : ${(e as Error).message}`];
      plan = null;
    }
    planPending = false;
    renderPanel();
  }, delay);
}

let baseToken = 0;
/** Calcule le plan des données de base (pour l'onglet de comparaison). */
async function computeBasePlan() {
  const token = ++baseToken;
  if (!base) { basePlan = null; baseErrors = []; if (tab === "compare") renderPanel(); return; }
  const parsed = toScenario(base.form);
  baseErrors = parsed.errors;
  if (!parsed.scenario) { basePlan = null; if (tab === "compare") renderPanel(); return; }
  try {
    const rows = (await run({ kind: "plan", scenario: parsed.scenario })) as YearResult[];
    if (token !== baseToken) return;
    basePlan = { scenario: parsed.scenario, rows, options: parsed.options };
  } catch (e) {
    baseErrors = [`Le calcul des données de base a échoué : ${(e as Error).message}`];
    basePlan = null;
  }
  if (tab === "compare") renderPanel();
}
function setBaseFromForm() {
  base = { savedAt: new Date().toISOString(), form: structuredClone(form) };
  persistBase(); refreshBase(); void computeBasePlan();
}

// ---------------------------------------------------------------- formulaire
const inputs = document.getElementById("inputs") as HTMLElement;
const formBody = document.getElementById("formbody") as HTMLElement;
const baseBar = document.getElementById("basebar") as HTMLElement;
const panel = document.getElementById("panel") as HTMLElement;

function renderInputs(focusPath?: string) {
  const top = inputs.scrollTop;
  formBody.innerHTML = renderForm(form, openSecs) + `<div class="foot"><button type="button" class="link" data-action="reset">Rétablir les valeurs d'exemple</button></div>`;
  inputs.scrollTop = top;
  if (focusPath) (formBody.querySelector(`[data-path="${focusPath}"]`) as HTMLElement | null)?.focus();
  refreshBase();
}

/** Barre des données de base : état, actions et liste des changements. */
function refreshBase() {
  if (!base) {
    baseBar.innerHTML = `<p>Aucune donnée de base. Enregistrez la situation actuelle pour pouvoir y revenir après avoir essayé des variantes.</p>
      <div class="acts"><button type="button" class="btn" data-action="save-base">Enregistrer comme données de base</button></div>`;
    markChanged(new Set());
    return;
  }
  const list = describeChanges(base.form, form);
  const date = new Date(base.savedAt).toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
  const n = list.length;
  baseBar.innerHTML = `<p>Données de base enregistrées le ${esc(date)}. ${n === 0 ? "Aucun changement depuis." : `${n} changement${n > 1 ? "s" : ""} depuis.`}</p>
    ${n ? `<div class="acts"><button type="button" class="btn" data-action="revert-base">Revenir aux données de base</button><button type="button" class="btn" data-action="save-base">Définir comme données de base</button></div>
    <details class="changes"${changesOpen ? " open" : ""}><summary>Voir les changements</summary><ul>${list.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></details>` : ""}`;
  markChanged(changedPaths(base.form, form));
}

/** Encadre en ocre les champs modifiés depuis la base. */
function markChanged(paths: Set<string>) {
  formBody.querySelectorAll<HTMLElement>("[data-path]").forEach((el) => {
    el.closest(".f, .check")?.classList.toggle("changed", paths.has(el.dataset.path!));
  });
}

function markStale() {
  if (strategies) stale.strategies = true;
  if (deaths) stale.deaths = true;
  if (optim) stale.optim = true;
  if (busy.optim) optimDirty = true;
}

inputs.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const path = el.dataset.path;
  if (!path) return;
  setPath(form, path, el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value);
  persist(); markStale();
  // Le montant à 65 ans, laissé vide, affiche le montant annuel : le suivre quand on le modifie.
  const pa = /^(spouses\.\d\.pensions\.\d+)\.amount$/.exec(path);
  if (pa) formBody.querySelector(`[data-path="${pa[1]}.amountAt65"]`)?.setAttribute("placeholder", el.value);
  // Aperçu de la rente RRQ / PSV selon l'âge de début : mise à jour en direct.
  const bm = /^(spouses\.(\d))\.(rrq|psv)(Amount|StartAge)$/.exec(path);
  if (bm) {
    const sp = form.spouses[Number(bm[2])];
    const kind = bm[3] as "rrq" | "psv";
    const hint = formBody.querySelector(`[data-benefit-hint="${bm[1]}.${kind}"]`);
    if (hint) hint.textContent = benefitHint(kind, kind === "rrq" ? sp.rrqAmount : sp.psvAmount, kind === "rrq" ? sp.rrqStartAge : sp.psvStartAge);
  }
  // La part du second conjoint est déduite de celle du premier : mise à jour en direct.
  if (path === "spouses.0.expenseShare") {
    const other = formBody.querySelector<HTMLInputElement>("[data-share-complement]");
    if (other) other.value = shareComplement(el.value);
  }
  const m = /^spouses\.(\d)\.name$/.exec(path);
  if (m) {
    const t = inputs.querySelector(`[data-title="${m[1]}"]`);
    if (t) t.textContent = el.value.trim() || `Conjoint ${+m[1] + 1}`;
    // Le prénom apparaît aussi dans la liste des propriétaires de chaque immeuble.
    inputs.querySelectorAll(`[data-name-opt="${m[1]}"]`).forEach((o) => { o.textContent = el.value.trim() || `Conjoint ${+m[1] + 1}`; });
  }
  // Aperçu des immeubles : mis à jour en direct (et quand l'année de départ, l'inflation, la fin du plan ou une naissance change).
  const refreshPropertyHints = () => formBody.querySelectorAll<HTMLElement>("[data-property-hint]").forEach((h) => { h.textContent = propertyHint(form, Number(h.dataset.propertyHint)); });
  if (/^properties\.\d+\./.test(path) || /^(assumptions\.(startYear|inflation|endAge)|spouses\.\d\.birthYear)$/.test(path)) refreshPropertyHints();
  if (el.dataset.rerender) renderInputs(path); else refreshBase();
  if (path === "assumptions.startYear") renderUnits();
  schedulePlan();
  if (tab !== "plan" && tab !== "detail") renderPanel();
});
inputs.addEventListener("toggle", (e) => {
  const d = e.target as HTMLDetailsElement;
  const key = d.dataset.sec;
  if (key) { if (d.open) openSecs.add(key); else openSecs.delete(key); }
  else if (d.classList.contains("changes")) changesOpen = d.open;
}, true);
inputs.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
  if (!b) return;
  const i = Number(b.dataset.spouse);
  if (b.dataset.action === "save-base") {
    const n = base ? describeChanges(base.form, form).length : 0;
    // Les confirmations sont des boîtes intégrées à la page : window.confirm bloque le focus clavier sous Electron (Windows).
    if (base && n && !(await confirmDialog({ title: "Définir comme données de base ?", message: "Les données de base actuelles seront remplacées par la situation actuelle. L'ancienne base ne pourra pas être récupérée.", confirmLabel: "Définir comme données de base" }))) return;
    setBaseFromForm(); return;
  }
  if (b.dataset.action === "revert-base") {
    if (!base) return;
    const n = describeChanges(base.form, form).length;
    if (!(await confirmDialog({ title: "Revenir aux données de base ?", message: `${n === 1 ? "Le changement sera perdu" : `Les ${n} changements seront perdus`} : le formulaire retrouvera les valeurs des données de base.`, confirmLabel: "Revenir aux données de base" }))) return;
    form = structuredClone(base.form);
    persist(); markStale(); renderInputs(); schedulePlan(0); renderPanel(); return;
  }
  if (b.dataset.action === "add-property") { form.properties.push(newProperty(form.assumptions.startYear)); openSecs.add("properties"); }
  else if (b.dataset.action === "remove-property") form.properties.splice(Number(b.dataset.index), 1);
  else if (b.dataset.action === "add-pension") form.spouses[i].pensions.push(newPension());
  else if (b.dataset.action === "remove-pension") form.spouses[i].pensions.splice(Number(b.dataset.index), 1);
  else if (b.dataset.action === "reset") {
    if (!(await confirmDialog({ title: "Rétablir les valeurs d'exemple ?", message: "Toutes les données du formulaire seront remplacées par les valeurs d'exemple. Les données de base ne sont pas touchées.", confirmLabel: "Rétablir les valeurs d'exemple" }))) return;
    form = defaultForm();
  }
  else return;
  persist(); markStale(); renderInputs(); schedulePlan(0); renderPanel();
});

// ---------------------------------------------------------------- résultats
const TABS: [Tab, string][] = [["plan", "Plan"], ["detail", "Détail annuel"], ["compare", "Comparaison à la base"], ["strategies", "Stratégies"], ["deaths", "Ordre des décès"], ["optim", "Optimisation PSV/RRQ"]];
// Masquer le formulaire : l'onglet « Détail annuel » prend alors toute la largeur de la fenêtre.
const splitEl = document.querySelector(".split") as HTMLElement;
const toggleBtn = document.getElementById("toggle-form") as HTMLButtonElement;
function applyFormVisibility() {
  splitEl.classList.toggle("form-hidden", hideForm);
  inputs.hidden = hideForm;
  toggleBtn.setAttribute("aria-expanded", String(!hideForm));
  toggleBtn.querySelector(".lbl")!.textContent = hideForm ? "Afficher le formulaire" : "Masquer le formulaire";
}
toggleBtn.addEventListener("click", () => {
  hideForm = !hideForm;
  if (hideForm && inputs.contains(document.activeElement)) toggleBtn.focus();   // le focus ne doit pas rester dans un panneau caché
  savePrefs(); applyFormVisibility();
});
const unitsEl = document.getElementById("units") as HTMLElement;
function renderUnits() {
  const y = esc(form.assumptions.startYear.trim() || "départ");
  unitsEl.innerHTML = `<span class="units-l" id="units-l">Montants en</span>` +
    `<button type="button" role="radio" aria-checked="${real}" data-real="true" title="Sans l'effet de l'inflation : ce que les montants permettent d'acheter aujourd'hui">Dollars de ${y}</button>` +
    `<button type="button" role="radio" aria-checked="${!real}" data-real="false" title="Avec l'inflation : les montants réels de chaque année">Dollars courants</button>`;
}
unitsEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("[data-real]") as HTMLElement | null;
  if (!b) return;
  real = b.dataset.real === "true"; savePrefs(); renderUnits(); renderPanel();
});
const tabsEl = document.getElementById("tabs") as HTMLElement;
// La barre d'onglets passe sur deux rangées quand la fenêtre est étroite : le tableau du Détail annuel perd alors de la hauteur.
// On mesure l'excédent par rapport à une seule rangée (55 px) pour que le tableau ne dépasse pas le bas de la fenêtre.
const tabbarEl = document.querySelector(".tabbar") as HTMLElement;
const TABBAR_ONE_ROW = 55;
function syncTabbarHeight() {
  document.documentElement.style.setProperty("--tabbar-extra", `${Math.max(0, tabbarEl.offsetHeight - TABBAR_ONE_ROW)}px`);
}
if (typeof ResizeObserver !== "undefined") new ResizeObserver(syncTabbarHeight).observe(tabbarEl);
syncTabbarHeight();

function renderTabs() {
  tabsEl.innerHTML = TABS.map(([id, label]) => `<button type="button" role="tab" id="tab-${id}" aria-selected="${id === tab}" aria-controls="panel" data-tab="${id}" tabindex="${id === tab ? 0 : -1}">${esc(label)}</button>`).join("");
}
tabsEl.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("[data-tab]") as HTMLElement | null;
  if (t) { tab = t.dataset.tab as Tab; renderTabs(); renderPanel(); }
});
tabsEl.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const i = TABS.findIndex(([id]) => id === tab);
  tab = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0];
  renderTabs(); renderPanel();
  (document.getElementById(`tab-${tab}`) as HTMLElement).focus();
});

const errorsBlock = () => `<div class="alert" role="alert"><p>Corrigez ces champs pour calculer le plan :</p><ul>${planErrors.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>`;
const unitLabel = (s: Scenario) => (real ? `dollars de ${s.assumptions.startYear}, sans l'effet de l'inflation` : "dollars courants, avec l'inflation");
const unitNote = (s: Scenario, lastYear: number) => (real ? `Montants en ${unitLabel(s)}.` : `Montants en ${unitLabel(s)} : chaque année en dollars de cette année, et ce qui reste à la fin en dollars de ${lastYear}.`);

function planPanel(): string {
  if (planErrors.length) return errorsBlock();
  if (!plan) return `<p class="empty">Calcul en cours…</p>`;
  const { scenario: s, rows, estateRates } = plan;
  const sum = summarize("plan", s.strategy ?? { kind: "reer-first" }, rows, s.assumptions, estateRates);
  const amt = real ? sum : sum.nominal;
  const first = rows.find((y) => y.shortfall > 1);
  const last = rows[rows.length - 1];
  const missing = first ? (real ? first.shortfall / Math.pow(1 + s.assumptions.inflation, first.year - s.assumptions.startYear) : first.shortfall) : 0;
  const verdict = first
    ? `<strong>Les actifs ne suffisent plus à partir de ${first.year}.</strong> Cette année-là, il manque ${fmtMoney(missing)} pour payer les dépenses visées.`
    : `Les dépenses visées sont financées chaque année jusqu'en ${last.year}.`;
  return `
    <p class="lede">${verdict} Sur ${rows.length} ans, le couple paie <strong>${fmtMoney(amt.totalTax)}</strong> d'impôt${amt.totalClawback > 1 ? ` et voit <strong>${fmtMoney(amt.totalClawback)}</strong> de PSV récupérés par l'impôt` : ""}. Il reste à la fin <strong>${fmtMoney(amt.afterTaxEstate)}</strong> après impôt.
    <span class="small">${esc(unitNote(s, last.year))} Le REER/FERR restant est imposé à ${Math.round((estateRates.estateTaxRate ?? 0.45) * 100)} % dans ce calcul.</span></p>
    <h2>Comptes et étapes de vie</h2>
    ${legend(BALANCE_LEGEND)}
    ${balancesChart(s, rows, real)}
    <h2>D'où vient l'argent</h2>
    ${legend(plan.rows.some((y) => y.spouses[0].propertyProceeds + y.spouses[1].propertyProceeds > 0) ? [...SOURCE_LEGEND, PROPERTY_LEGEND] : SOURCE_LEGEND, `<li><span class="sw line"></span>Dépenses visées et impôt</li>${first ? `<li><span class="sw s-short"></span>Manque de fonds</li>` : ""}`)}
    ${sourcesChart(s, rows, real)}
    <p class="note">Quand les barres dépassent la ligne, l'excédent est réinvesti dans le CELI, puis dans le compte non enregistré.${first ? " Quand la ligne dépasse les barres, la zone rouge est le manque : des dépenses visées ne sont pas financées." : ""}</p>`;
}

function detailPanel(): string {
  if (planErrors.length) return errorsBlock();
  if (!plan) return `<p class="empty">Calcul en cours…</p>`;
  const last = plan.rows[plan.rows.length - 1].year;
  return `<div class="toolbar"><button type="button" class="ghost dark" data-action="export-csv">Exporter en CSV</button>
      <button type="button" class="link" id="toggle-years" data-action="toggle-years">${plan.rows.every((y) => expandedYears.has(y.year)) ? "Tout réduire" : "Tout développer"}</button>
      <button type="button" class="link" id="toggle-note" data-action="toggle-note" aria-controls="detail-note" aria-expanded="${!hideDetailNote}">${hideDetailNote ? "Afficher la note" : "Masquer la note"}</button></div>
    <p class="note" id="detail-note"${hideDetailNote ? " hidden" : ""}>${esc(unitNote(plan.scenario, last))} Chaque ligne donne le total du ménage; le bouton › déplie le détail de chaque conjoint, avec les mêmes colonnes que le CSV. Son revenu imposable est calculé après le fractionnement et la déduction de la PSV récupérée; son taux marginal est le taux combiné fédéral et Québec du palier d'imposition, sans la récupération de la PSV ni la réduction des crédits; la pension fractionnée est signée (+ reçue, − cédée); la dépense visée et le manque de chaque conjoint suivent sa part des dépenses du couple. Le symbole † indique un décès; les années en rouge manquent de fonds. Le fichier CSV est toujours en dollars courants et contient l'indice d'inflation pour revenir aux dollars de ${esc(String(plan.scenario.assumptions.startYear))}.</p>
    <div class="tall">${yearTable(plan.scenario, plan.rows, real, expandedYears)}</div>`;
}

function comparePanelHtml(): string {
  if (!base) {
    return `<p class="lede">Fixez d'abord des données de base, puis modifiez le formulaire : cet onglet montre l'effet de vos changements sur l'impôt, la succession et la durée des fonds.</p>
      <div class="toolbar"><button type="button" class="primary" data-action="save-base-panel">Enregistrer la situation actuelle comme données de base</button></div>`;
  }
  if (baseErrors.length) return `<div class="alert" role="alert"><p>Les données de base contiennent des erreurs :</p><ul>${baseErrors.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>`;
  if (planErrors.length) return errorsBlock();
  if (!plan || !basePlan) return `<p class="empty">Calcul en cours…</p>`;
  const view = (p: { scenario: Scenario; rows: YearResult[]; estateRates?: CompareOptions; options?: CompareOptions }) => ({
    scenario: p.scenario, rows: p.rows,
    summary: summarize("plan", p.scenario.strategy ?? { kind: "reer-first" }, p.rows, p.scenario.assumptions, p.estateRates ?? p.options),
  });
  return comparePanel({ base: view(basePlan), cur: view(plan), changes: describeChanges(base.form, form), real });
}

function strategiesPanel(): string {
  const ready = !planErrors.length && plan;
  const staleNote = stale.strategies && strategies ? `<p class="alert soft" role="status">Les données ont changé depuis cette comparaison. Relancez-la pour mettre les résultats à jour.</p>` : "";
  return `<p class="lede">Compare les façons de financer les dépenses (ordre des retraits, plafonds de revenu, fonte du REER/FERR) avec les données du couple.</p>
    <div class="toolbar"><button type="button" class="primary" data-action="run-strategies"${ready && !busy.strategies ? "" : " disabled"}>${busy.strategies ? "Comparaison en cours…" : "Comparer les stratégies"}</button></div>
    ${compareError && !busy.strategies ? `<div class="alert" role="alert">${esc(compareError)}</div>` : ""}
    ${!ready ? errorsBlock() : ""}
    ${staleNote}
    ${strategies ? `<p class="note">Montants cumulés en ${plan ? esc(unitLabel(plan.scenario)) : "dollars constants"}. La succession suppose que le REER/FERR restant est imposé à ${Math.round((plan?.estateRates.estateTaxRate ?? 0.45) * 100)} %. Les écarts entre stratégies sont souvent petits : regardez-les avec prudence.</p><div class="${stale.strategies ? "stale" : ""}">${strategiesTable(strategies, real)}</div>` : ""}`;
}

/** Âges de décès testés pour chaque conjoint, et chances d'atteindre 85, 90 et 95 ans. */
function longevityPreview(): string {
  if (!plan) return "";
  const s = plan.scenario;
  const items = s.spouses.map((sp, i) => {
    const model = gompertz(plan!.longevity[i]);
    const age = s.assumptions.startYear - sp.birthYear;
    const tested = representativeDeathAges(model, age, longevityStates, s.assumptions.endAge)
      .map((a) => (a === undefined ? `après ${s.assumptions.endAge} ans` : `${a} ans`)).join(", ");
    const chances = [85, 90, 95].filter((x) => x > age).map((x) => `${x} ans : ${Math.round(model.survival(age - 0.5, x) * 100)} %`).join("; ");
    return `<li><strong>${esc(sp.name)}</strong> (${age} ans) : décès testé à ${esc(tested)}.${chances ? ` Chances d'atteindre ${esc(chances)}.` : ""}</li>`;
  });
  return `<ul class="preview">${items.join("")}</ul>`;
}

function deathsPanel(): string {
  const ready = !planErrors.length && plan;
  const staleNote = stale.deaths && deaths ? `<p class="alert soft" role="status">Les données ont changé depuis cette comparaison. Relancez-la pour mettre les résultats à jour.</p>` : "";
  const modes = `<fieldset class="modes"><legend>Cas de décès à tester</legend>
    <label class="check"><input type="radio" name="deathMode" value="longevity"${deathMode === "longevity" ? " checked" : ""}><span>Durées de vie probables : l'âge des deux décès varie</span></label>
    <label class="check"><input type="radio" name="deathMode" value="first"${deathMode === "first" ? " checked" : ""}><span>Premier décès à des âges choisis, l'autre conjoint vit jusqu'à la fin du plan</span></label></fieldset>`;
  const options = deathMode === "longevity"
    ? `<div class="toolbar"><label class="f inline"><span class="lab">Précision</span><select id="states">
          <option value="5"${longevityStates === 5 ? " selected" : ""}>Détaillée : 5 âges par conjoint, 25 cas</option>
          <option value="3"${longevityStates === 3 ? " selected" : ""}>Rapide : 3 âges par conjoint, 9 cas</option></select></label>
        <button type="button" class="primary" data-action="run-deaths"${ready && !busy.deaths ? "" : " disabled"}>${busy.deaths ? "Comparaison en cours…" : "Comparer selon la durée de vie"}</button></div>
       ${ready ? longevityPreview() : ""}
       <p class="note">Chaque conjoint est testé à des âges représentatifs de sa durée de vie probable, puis les décès sont combinés (durées de vie supposées indépendantes, chaque combinaison pèse autant). La mortalité est un modèle approximatif calé sur l'espérance de vie à 65 ans de chacun, à régler dans le formulaire. Comptez ${longevityStates === 5 ? "une quinzaine de secondes" : "quelques secondes"}.</p>`
    : `<div class="toolbar"><label class="f inline"><span class="lab">Âges du premier décès à tester</span><span class="ctl"><input type="text" id="deathAges" value="${esc(deathAgesText)}" autocomplete="off"></span></label>
        <button type="button" class="primary" data-action="run-deaths"${ready && !busy.deaths ? "" : " disabled"}>${busy.deaths ? "Comparaison en cours…" : "Comparer les ordres de décès"}</button></div>
       <p class="note">Séparez les âges par des virgules. Comptez une dizaine de secondes.</p>`;
  const unit = plan ? esc(unitLabel(plan.scenario)) : "dollars constants";
  const results = !deaths ? "" : deathsMode === "longevity"
    ? `<div class="${stale.deaths ? "stale" : ""}">
        <h2>Stratégies les plus robustes</h2>
        <p class="note">Montants en ${unit}. Chaque stratégie est testée dans ${deaths.scenarios.length} cas de durée de vie. Le regret maximal est l'écart, dans le pire cas, avec la meilleure stratégie de ce cas. Le classement est établi en dollars constants.</p>
        ${deathRankTable(deaths, real, 8, true)}
        <details class="more"><summary>Voir la meilleure stratégie dans chaque cas</summary>${deathBestTable(deaths, real)}</details>
        <details class="more"><summary>Voir toutes les stratégies dans chaque cas</summary>${deathMatrix(deaths, real)}</details></div>`
    : `<div class="${stale.deaths ? "stale" : ""}">
        <h2>Meilleure stratégie selon le cas</h2><p class="note">Montants en ${unit}. Le classement est établi en dollars constants.</p>${deathBestTable(deaths, real)}
        <h2>Stratégies les plus robustes</h2>
        <p class="note">Le regret maximal est l'écart, dans le pire cas, avec la meilleure stratégie de ce cas. Les cas ont un poids égal, ce qui est arbitraire.</p>
        ${deathRankTable(deaths, real)}
        <details class="more"><summary>Voir toutes les stratégies dans chaque cas</summary>${deathMatrix(deaths, real)}</details></div>`;
  return `<p class="lede">La meilleure stratégie dépend de qui meurt en premier, et à quel âge. Cette comparaison teste chaque stratégie dans plusieurs cas de décès.</p>
    ${modes}
    ${options}
    ${compareError && !busy.deaths ? `<div class="alert" role="alert">${esc(compareError)}</div>` : ""}
    ${!ready ? errorsBlock() : ""}
    ${staleNote}
    ${results}`;
}

/** Paramètres du calcul parallèle : Web Workers si possible, sinon calcul par lots dans le fil principal. */
function poolDeps(): PoolDeps {
  return {
    createWorker: workerBroken ? undefined : () => new Worker("worker.js") as unknown as PoolWorker,
    workers: workerCount(navigator.hardwareConcurrency),
    evaluate: runJob,
    yieldToUi: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

function optimPanel(): string {
  const ready = !planErrors.length && plan;
  const unit = plan ? unitLabel(plan.scenario) : "dollars constants";
  const count = plan ? plannedCount(plan.scenario, optimFree) : 0;
  const workers = workerCount(navigator.hardwareConcurrency);
  const eta = durationText(estimateSeconds(count, planMs || 60, workers));
  const staleNote = stale.optim && optim ? `<p class="alert soft" role="status">Les données ont changé depuis cette optimisation. Relancez-la pour mettre les résultats à jour.</p>` : "";
  const running = busy.optim;
  const progress = running
    ? `<div class="optim-progress"><progress id="optim-bar" max="${optimProgress.total}" value="${optimProgress.done}" aria-label="Progression de l'optimisation"></progress><p id="optim-progress-text" role="status">${esc(progressText(optimProgress.done, optimProgress.total, performance.now() - optimProgress.startedAt))}</p></div>`
    : "";
  const options = plan ? `<div class="optim-options" role="group" aria-label="Décisions à explorer">${optionRows(plan.scenario, optimFree)}</div>
    <p class="note" id="optim-count">${count.toLocaleString("fr-CA")} combinaison${count > 1 ? "s" : ""} à essayer, ${esc(eta)} sur cet ordinateur${count > 2500 ? ". C'est long : décochez une décision pour réduire la durée" : ""}.</p>` : "";
  const results = optim && optimScenario && !running
    ? `<div class="${stale.optim ? "stale" : ""}">${verdictHtml(optimScenario, optim, real)}
        <div class="toolbar">${optim.best.key !== optim.current.key ? `<button type="button" class="primary" data-action="apply-benefits" data-index="0">Appliquer la meilleure combinaison</button>` : ""}</div>
        <h2>Meilleures combinaisons</h2>
        <p class="note">Montants en ${esc(unit)}. Les âges qui diffèrent de vos choix actuels sont en gras. La succession est la valeur des placements restants à la fin du plan, après l'impôt présumé (${Math.round((plan?.estateRates.estateTaxRate ?? 0.45) * 100)} % sur le REER/FERR restant). ${optim.anyFeasible ? "" : "Aucune combinaison ne finançant toutes les dépenses, le classement va du plus petit au plus grand manque cumulé."}</p>
        ${resultsTable(optimScenario, optim, real)}</div>`
    : "";
  return `<p class="note intro">Explore les âges de début de la RRQ et de la PSV de chaque conjoint, en tenant compte de la réduction avant 65 ans et de la bonification du report, et classe les combinaisons selon ce qui reste à la fin du plan après impôt (ou, si les dépenses ne sont pas toutes financées, selon le manque cumulé).</p>
    ${options}
    <div class="toolbar">${running
      ? `<button type="button" class="ghost dark" id="cancel-optim" data-action="cancel-optim">Annuler</button>`
      : `<button type="button" class="primary" id="run-optim" data-action="run-optim"${ready && !planPending && count > 0 ? "" : " disabled"}>${optim ? "Relancer l'optimisation" : "Lancer l'optimisation"}</button>`}</div>
    ${progress}
    ${compareError && !running ? `<div class="alert" role="alert">${esc(compareError)}</div>` : ""}
    ${!ready ? errorsBlock() : ""}
    ${staleNote}
    ${results}
    <details class="more"><summary>Comment ça fonctionne</summary>
      <p class="note">Chaque combinaison est calculée avec le reste du plan tel que saisi (stratégie de retrait, fractionnement, décès éventuels). Le montant de la RRQ et de la PSV saisi dans le formulaire est celui de 65 ans : la RRQ est réduite de 0,5 % à 0,6 % par mois avant 65 ans (selon le montant de la rente) et bonifiée de 0,7 % par mois jusqu'à 72 ans; la PSV est bonifiée de 0,6 % par mois jusqu'à 70 ans. Le classement dépend de la durée du plan et des rendements supposés. Un décès plus tôt favorise les rentes prises tôt : vérifiez la combinaison choisie avec l'onglet « Ordre des décès ».</p>
    </details>`;
}

/** Met à jour la barre de progression sans réafficher tout l'onglet. */
function onOptimProgress(done: number, total: number) {
  optimProgress = { ...optimProgress, done, total };
  const bar = document.getElementById("optim-bar") as HTMLProgressElement | null;
  if (bar) { bar.max = total; bar.value = done; }
  const text = document.getElementById("optim-progress-text");
  if (text) text.textContent = progressText(done, total, performance.now() - optimProgress.startedAt);
}

function renderPanel() {
  const html = tab === "plan" ? planPanel() : tab === "detail" ? detailPanel() : tab === "compare" ? comparePanelHtml() : tab === "strategies" ? strategiesPanel() : tab === "deaths" ? deathsPanel() : optimPanel();
  const keep = document.activeElement?.id;
  panel.innerHTML = html + `<p class="disclaimer">Ces projections reposent sur des hypothèses simplifiées. Elles ne remplacent pas l'avis d'un planificateur financier ou d'un fiscaliste.</p>`;
  panel.className = `panel tab-${tab}${hideDetailNote ? " notes-off" : ""}`;
  panel.setAttribute("aria-labelledby", `tab-${tab}`);
  if (keep) document.getElementById(keep)?.focus();
}

/** Affiche ou masque les lignes des conjoints d'une année, et met à jour le bouton. */
function setYearOpen(year: number, open: boolean) {
  panel.querySelectorAll<HTMLElement>(`tr.sub[data-year="${year}"]`).forEach((tr) => { tr.hidden = !open; });
  const btn = panel.querySelector<HTMLElement>(`.expander[data-year="${year}"]`);
  if (btn) {
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", `${open ? "Masquer" : "Afficher"} le détail par conjoint de ${year}`);
  }
  if (open) expandedYears.add(year); else expandedYears.delete(year);
}
function syncYearsToggle() {
  const b = document.getElementById("toggle-years");
  if (b && plan) b.textContent = plan.rows.every((y) => expandedYears.has(y.year)) ? "Tout réduire" : "Tout développer";
}

panel.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  if (el.name === "deathMode") { deathMode = el.value as "longevity" | "first"; renderPanel(); }
  else if (el.id === "states") { longevityStates = Number(el.value) === 3 ? 3 : 5; renderPanel(); }
  else if (el.dataset.free) {
    const [kind, i] = el.dataset.free.split(":");
    optimFree[kind as "rrq" | "psv"][Number(i) as 0 | 1] = (el as HTMLInputElement).checked;
    renderPanel();
  }
});
panel.addEventListener("input", (e) => {
  if ((e.target as HTMLElement).id === "deathAges") deathAgesText = (e.target as HTMLInputElement).value;
});
panel.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
  if (!b || (b as HTMLButtonElement).disabled) return;
  const a = b.dataset.action;
  if (a === "save-base-panel") { setBaseFromForm(); renderPanel(); return; }
  if (a === "toggle-year") {
    // Déplier un détail ne réaffiche pas le tableau : il garde sa position de défilement.
    setYearOpen(Number(b.dataset.year), b.getAttribute("aria-expanded") !== "true");
    syncYearsToggle();
    return;
  }
  if (a === "toggle-years" && plan) {
    const all = plan.rows.every((y) => expandedYears.has(y.year));
    plan.rows.forEach((y) => setYearOpen(y.year, !all));
    syncYearsToggle();
    return;
  }
  if (a === "toggle-note") {
    // Sans réafficher le panneau : le tableau garde sa position de défilement.
    hideDetailNote = !hideDetailNote; savePrefs();
    const note = document.getElementById("detail-note");
    if (note) note.hidden = hideDetailNote;
    panel.classList.toggle("notes-off", hideDetailNote);
    b.textContent = hideDetailNote ? "Afficher la note" : "Masquer la note";
    b.setAttribute("aria-expanded", String(!hideDetailNote));
    return;
  }
  if (a === "export-csv" && plan) {
    await saveFile(`${fileStem()}-detail.csv`, planToCsv(plan.scenario, plan.rows), "csv");
  } else if (a === "run-strategies" && plan) {
    busy.strategies = true; compareError = ""; renderPanel();
    try { strategies = (await run({ kind: "strategies", scenario: plan.scenario, options: plan.estateRates })) as StrategySummary[]; stale.strategies = false; }
    catch (err) { compareError = `La comparaison a échoué : ${(err as Error).message}`; }
    busy.strategies = false; renderPanel();
  } else if (a === "run-optim" && plan && !busy.optim) {
    const scenario = plan.scenario, options = plan.estateRates;
    const choices = enumerateChoices(benefitRanges(scenario, optimFree));
    busy.optim = true; optimDirty = false; compareError = "";
    optimProgress = { done: 0, total: choices.length, startedAt: performance.now() };
    renderPanel();
    document.getElementById("cancel-optim")?.focus();
    optimRun = runChoices(scenario, options, choices, onOptimProgress, poolDeps());
    try {
      optim = rankResults(scenario, await optimRun.promise);
      optimScenario = scenario;
      stale.optim = optimDirty;
    } catch (err) {
      if (!(err instanceof OptimizationCancelled)) compareError = `L'optimisation a échoué : ${(err as Error).message}`;
    }
    busy.optim = false; optimRun = null; renderPanel();
    document.getElementById("run-optim")?.focus();
  } else if (a === "cancel-optim") {
    optimRun?.cancel();
  } else if (a === "apply-benefits" && optim) {
    const chosen = optim.ranked[Number(b.dataset.index)];
    if (!chosen) return;
    applyBenefitChoice(form, chosen.choice);
    persist(); renderInputs(); markStale(); tab = "plan"; renderTabs(); schedulePlan(0); renderPanel();
  } else if (a === "run-deaths" && plan) {
    let job: Job;
    if (deathMode === "longevity") {
      job = { kind: "longevity", scenario: plan.scenario, options: plan.estateRates, lifeExpectancy: plan.longevity, states: longevityStates };
    } else {
      const ages = deathAgesText.split(/[,;\s]+/).filter(Boolean).map(Number);
      if (!ages.length || ages.some((x) => !Number.isInteger(x) || x < 40 || x > 120)) { compareError = "Âges du premier décès : entrez des nombres entiers entre 40 et 120, séparés par des virgules."; renderPanel(); return; }
      job = { kind: "deaths", scenario: plan.scenario, options: plan.estateRates, deathAges: ages };
    }
    busy.deaths = true; compareError = ""; renderPanel();
    try { deaths = (await run(job)) as DeathOrderComparison; deathsMode = deathMode; stale.deaths = false; }
    catch (err) { compareError = `La comparaison a échoué : ${(err as Error).message}`; }
    busy.deaths = false; renderPanel();
  } else if ((a === "apply-strategy" && strategies) || (a === "apply-death-strategy" && deaths)) {
    const item = a === "apply-strategy" ? strategies![Number(b.dataset.index)] : deaths!.rows[Number(b.dataset.index)];
    form.strategy = strategyToForm(item.strategy, form.strategy);
    persist(); openSecs.add("strategy"); renderInputs(); markStale(); tab = "plan"; renderTabs(); schedulePlan(0); renderPanel();
  }
});

// ---------------------------------------------------------------- fichiers
function fileStem(): string {
  const names = form.spouses.map((s) => s.name.trim()).filter(Boolean).join(" et ") || "scenario";
  return names.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "scenario";
}
document.getElementById("save")!.addEventListener("click", () => { void saveFile(`${fileStem()}.json`, fileToJson(form, base), "json"); });
document.getElementById("open")!.addEventListener("click", async () => {
  try {
    const f = await openScenarioFile();
    if (!f) return;
    const opened = fileFromJson(f.content);
    form = opened.form; base = opened.base; persistBase(); void computeBasePlan();
    strategies = null; deaths = null; optim = null; optimScenario = null; stale.strategies = stale.deaths = stale.optim = false;
    optimRun?.cancel();
    persist(); renderInputs(); schedulePlan(0); renderPanel();
  } catch (err) {
    planErrors = [`Impossible d'ouvrir ce fichier : ${(err as Error).message}`];
    renderPanel();
  }
});

// ---------------------------------------------------------------- démarrage
renderTabs();
renderUnits();
applyFormVisibility();
renderInputs();
renderPanel();
schedulePlan(0);
void computeBasePlan();
