import type { PublicBenefit } from "./types";

// Report ou anticipation de la RRQ et de la PSV.
//
// Sources : Retraite Québec (« Le calcul de votre rente de retraite ») et Service Canada (« Quand commencer à recevoir
// votre pension »; Loi sur la sécurité de la vieillesse, art. 7.1).
//
// - RRQ : 100 % à 65 ans. Après 65 ans, +0,7 % par mois, jusqu'à 72 ans (maximum +58,8 %). Avant 65 ans, la rente est réduite
//   de 0,5 % à 0,6 % par mois, jusqu'à 60 ans : la réduction est d'environ 0,5 % par mois pour une faible rente et augmente
//   proportionnellement au montant de la rente, jusqu'à 0,6 % pour la rente maximale. Retraite Québec ne publie pas la formule
//   exacte : on interpole linéairement entre 0,5 % et 0,6 % selon le rapport rente / rente maximale à 65 ans (approximation).
// - PSV : 100 % à 65 ans. +0,6 % par mois de report, jusqu'à 70 ans (maximum +36 %). Pas d'anticipation possible.

export const RRQ_AGES = { min: 60, normal: 65, max: 72 } as const;
export const PSV_AGES = { min: 65, normal: 65, max: 70 } as const;

export const RRQ_LATE_PER_MONTH = 0.007;
export const RRQ_EARLY_MIN_PER_MONTH = 0.005;   // rente très faible
export const RRQ_EARLY_MAX_PER_MONTH = 0.006;   // rente maximale
export const PSV_LATE_PER_MONTH = 0.006;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Réduction mensuelle de la RRQ avant 65 ans, entre 0,5 % et 0,6 %, selon la rente à 65 ans par rapport à la rente maximale. */
export function rrqEarlyMonthlyRate(amountAt65: number, maxAt65: number): number {
  const ratio = maxAt65 > 0 ? clamp(amountAt65 / maxAt65, 0, 1) : 1;
  return RRQ_EARLY_MIN_PER_MONTH + (RRQ_EARLY_MAX_PER_MONTH - RRQ_EARLY_MIN_PER_MONTH) * ratio;
}

/** Facteur à appliquer à la rente RRQ à 65 ans pour un début à `startAge` (années entières) : 0,64 à 60 ans (rente maximale), 1,588 à 72 ans. */
export function rrqFactor(startAge: number, amountAt65: number, maxAt65: number): number {
  if (startAge >= RRQ_AGES.normal) return 1 + RRQ_LATE_PER_MONTH * 12 * (Math.min(startAge, RRQ_AGES.max) - RRQ_AGES.normal);
  return 1 - rrqEarlyMonthlyRate(amountAt65, maxAt65) * 12 * (RRQ_AGES.normal - Math.max(startAge, RRQ_AGES.min));
}

/** Facteur à appliquer à la PSV à 65 ans pour un début à `startAge` : 1 à 65 ans, 1,36 à 70 ans. */
export function psvFactor(startAge: number): number {
  return 1 + PSV_LATE_PER_MONTH * 12 * (clamp(startAge, PSV_AGES.min, PSV_AGES.max) - PSV_AGES.normal);
}

/** Rente annuelle effective (en $ de l'année de départ) d'une RRQ dont `annualAmount` est le montant à 65 ans. */
export const rrqAmount = (b: PublicBenefit, maxAt65: number) => b.annualAmount * rrqFactor(b.startAge, b.annualAmount, maxAt65);
/** Pension annuelle effective d'une PSV dont `annualAmount` est le montant à 65 ans. */
export const psvAmount = (b: PublicBenefit) => b.annualAmount * psvFactor(b.startAge);
