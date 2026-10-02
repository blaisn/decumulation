import { ageAtStart, ageOptions, benefitRanges, countChoices } from "../../src/index";
import type { BenefitChoice, ChoiceResult, FreeChoices, OptimizationResult, Scenario } from "../../src/index";
import { esc, fmtMoney } from "./format";

// Onglet « Optimisation PSV/RRQ » : choix des décisions à explorer, estimation du temps, verdict et tableau des meilleures combinaisons.
// Fonctions pures qui retournent du HTML ou du texte : le branchement à la page se fait dans main.ts.

const KINDS = [["rrq", "RRQ"], ["psv", "PSV"]] as const;

/** Nombre de combinaisons à essayer selon les décisions cochées. */
export const plannedCount = (s: Scenario, free: FreeChoices) => countChoices(benefitRanges(s, free));

/** Durée estimée d'une optimisation : `perEvalMs` est le temps d'un calcul de plan, `workers` le nombre de calculs en parallèle. */
export function estimateSeconds(count: number, perEvalMs: number, workers: number): number {
  return (count * Math.max(perEvalMs, 1)) / 1000 / Math.max(workers, 1) * 1.15;      // 15 % pour les échanges avec les workers
}

export function durationText(seconds: number): string {
  if (seconds < 5) return "quelques secondes";
  if (seconds < 90) return `environ ${Math.max(5, Math.round(seconds / 5) * 5)} secondes`;
  return `environ ${Math.round(seconds / 60)} minutes`;
}

/** Progression : « 120 sur 480 combinaisons, il reste environ 30 secondes ». */
export function progressText(done: number, total: number, elapsedMs: number): string {
  if (done <= 0 || elapsedMs <= 0) return `0 sur ${total.toLocaleString("fr-CA")} combinaisons essayées…`;
  const left = ((total - done) / done) * (elapsedMs / 1000);
  const eta = done >= total ? "" : `, il reste ${durationText(left)}`;
  return `${done.toLocaleString("fr-CA")} sur ${total.toLocaleString("fr-CA")} combinaisons essayées${eta}.`;
}

/** Cases à cocher : quelles rentes de quel conjoint explorer. Une rente déjà commencée n'a rien à explorer. */
export function optionRows(s: Scenario, free: FreeChoices): string {
  return s.spouses.map((sp, i) => {
    const idx = i as 0 | 1;
    const rows = KINDS.map(([kind, label]) => {
      const natural = ageOptions(s, idx, kind, true);
      const cur = sp[kind].startAge;
      if (natural.length === 1) {
        const why = cur < ageAtStart(s, idx) ? `déjà commencée à ${cur} ans` : `un seul âge possible, ${cur} ans`;
        return `<li class="fixed"><label><input type="checkbox" disabled><span>${label} : ${why}</span></label></li>`;
      }
      const on = free[kind][idx];
      return `<li><label><input type="checkbox" data-free="${kind}:${i}"${on ? " checked" : ""}><span>${label} : essayer de ${natural[0]} à ${natural[natural.length - 1]} ans <span class="count">(${natural.length} choix)</span></span></label></li>`;
    });
    return `<div class="opt-spouse"><h3>${esc(sp.name)} <span class="age">${ageAtStart(s, idx)} ans</span></h3><ul>${rows.join("")}</ul></div>`;
  }).join("");
}

/** « Alex : RRQ à 66 ans, PSV à 68 ans; Sam : … » (HTML déjà échappé). */
export function choiceText(s: Scenario, c: BenefitChoice): string {
  return s.spouses.map((sp, i) => `<strong>${esc(sp.name)}</strong> : RRQ à ${c.rrq[i]} ans, PSV à ${c.psv[i]} ans`).join("; ");
}

const est = (r: ChoiceResult, real: boolean) => (real ? r.afterTaxEstate : r.nominal.afterTaxEstate);
const miss = (r: ChoiceResult, real: boolean) => (real ? r.totalShortfall : r.nominal.totalShortfall);
const feasible = (r: ChoiceResult) => r.totalShortfall <= 100;
/** Écart sous lequel deux successions sont considérées comme équivalentes (en $ de départ). */
const NEGLIGIBLE = 100;

/** Phrase-bilan de l'optimisation. */
export function verdictHtml(s: Scenario, res: OptimizationResult, real: boolean): string {
  const { best, current } = res;
  const n = res.total.toLocaleString("fr-CA");
  const sameResult = best.key === current.key || (feasible(best) && feasible(current) && best.afterTaxEstate - current.afterTaxEstate < NEGLIGIBLE);
  if (sameResult) {
    return `<p class="lede">Vos choix actuels sont déjà les meilleurs parmi les ${n} combinaisons essayées : ils laissent <strong>${fmtMoney(est(current, real))}</strong> après impôt à la fin du plan.</p>`;
  }
  const spread = res.ranked[res.ranked.length - 1];
  const range = feasible(spread) ? ` L'écart entre la meilleure et la pire combinaison est de ${fmtMoney(est(best, real) - est(spread, real))}.` : "";
  const bestIs = `<p class="best-choice">${choiceText(s, best.choice)}.</p>`;
  if (!res.anyFeasible) {
    return `<p class="lede">Aucune des ${n} combinaisons ne finance toutes les dépenses. La meilleure réduit le manque cumulé de <strong>${fmtMoney(miss(current, real))}</strong> (vos choix actuels) à <strong>${fmtMoney(miss(best, real))}</strong>.</p>${bestIs}`;
  }
  if (!feasible(current)) {
    return `<p class="lede">Avec vos choix actuels, il manque <strong>${fmtMoney(miss(current, real))}</strong> au total (${current.yearsWithShortfall} année${current.yearsWithShortfall > 1 ? "s" : ""}). La meilleure combinaison finance toutes les dépenses et laisse <strong>${fmtMoney(est(best, real))}</strong> après impôt à la fin du plan.</p>${bestIs}`;
  }
  return `<p class="lede">La meilleure combinaison, parmi les ${n} essayées, laisse <strong>${fmtMoney(est(best, real) - est(current, real))} de plus</strong> après impôt à la fin du plan que vos choix actuels (${fmtMoney(est(best, real))} au lieu de ${fmtMoney(est(current, real))}).${range}</p>${bestIs}`;
}

/** Tableau des meilleures combinaisons, avec les choix actuels (ajoutés en bas s'ils n'en font pas partie). */
export function resultsTable(s: Scenario, res: OptimizationResult, real: boolean, topN = 10): string {
  const top = res.ranked.slice(0, topN);
  const shown: { r: ChoiceResult; rank: number }[] = top.map((r, k) => ({ r, rank: k + 1 }));
  if (res.currentRank > topN) shown.push({ r: res.current, rank: res.currentRank });
  const age = (a: number, b: number) => `<td class="${a === b ? "" : "chg"}">${a} ans</td>`;
  const body = shown.map(({ r, rank }) => {
    const isCurrent = r.key === res.current.key;
    const gap = est(r, real) - est(res.current, real);
    const gapText = isCurrent ? "—" : `${gap >= 0 ? "+" : "−"}${fmtMoney(Math.abs(gap))}`;
    const cls = [isCurrent ? "current" : "", rank === 1 && feasible(r) ? "best" : ""].filter(Boolean).join(" ");
    const action = isCurrent ? "" : `<button type="button" class="link" data-action="apply-benefits" data-index="${rank - 1}">Appliquer</button>`;
    const c = res.current.choice;
    return `<tr class="${cls}"><th scope="row">${isCurrent ? `Vos choix actuels <span class="rank">(n° ${rank})</span>` : `n° ${rank}`}</th>${age(r.choice.rrq[0], c.rrq[0])}${age(r.choice.psv[0], c.psv[0])}${age(r.choice.rrq[1], c.rrq[1])}${age(r.choice.psv[1], c.psv[1])}<td>${fmtMoney(est(r, real))}</td><td>${feasible(r) ? "Aucun" : fmtMoney(miss(r, real))}</td><td>${gapText}</td><td>${action}</td></tr>`;
  });
  const [n0, n1] = s.spouses.map((x) => esc(x.name));
  const th = (label: string, sub?: string) => `<th scope="col" class="num">${label}${sub ? `<span class="sub">${sub}</span>` : ""}</th>`;
  return `<div class="scroll"><table class="data wide optim"><thead><tr><th scope="col">Rang</th>${th("RRQ", n0)}${th("PSV", n0)}${th("RRQ", n1)}${th("PSV", n1)}${th("Succession après impôt")}${th("Manque cumulé")}${th("Écart avec vos choix actuels")}<th scope="col"><span class="sr-only">Action</span></th></tr></thead><tbody>${body.join("")}</tbody></table></div>`;
}
