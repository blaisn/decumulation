/**
 * Modèle de mortalité de Gompertz, calé sur l'espérance de vie à 65 ans.
 *
 * Le risque de décès à l'âge x est exp(alpha + beta x) : il augmente d'environ 12 % par année d'âge.
 * `beta` est fixé; `alpha` est déterminé pour que l'espérance de vie à 65 ans corresponde à la valeur donnée.
 * C'est une approximation : elle ne remplace pas une table de mortalité, et l'espérance de vie « du moment »
 * ignore les gains futurs de longévité (l'augmenter est une façon d'en tenir compte).
 */
export interface MortalityModel {
  /** Probabilité d'être vivant à l'âge `to`, sachant qu'on est vivant à l'âge `from` (âges exacts). */
  survival(from: number, to: number): number;
  /** Âge exact auquel la probabilité d'être décédé, sachant qu'on est vivant à l'âge `from`, atteint `p`. */
  quantileAge(from: number, p: number): number;
}

export const GOMPERTZ_BETA = 0.12;

export function gompertz(lifeExpectancyAt65: number, beta = GOMPERTZ_BETA): MortalityModel {
  if (!(lifeExpectancyAt65 > 0)) throw new Error("L'espérance de vie à 65 ans doit être positive.");
  const e65 = (alpha: number): number => {
    const a = Math.exp(alpha) / beta;
    const dt = 0.25;
    let total = 0;
    let prev = 1;
    for (let t = dt; t <= 70; t += dt) {
      const s = Math.exp(-a * (Math.exp(beta * (65 + t)) - Math.exp(beta * 65)));
      total += ((prev + s) / 2) * dt;
      prev = s;
    }
    return total;
  };
  let lo = -20, hi = 0; // e65 diminue quand alpha augmente
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (e65(mid) > lifeExpectancyAt65) lo = mid; else hi = mid;
  }
  const A = Math.exp((lo + hi) / 2);
  return {
    survival: (from, to) => Math.exp(-(A / beta) * (Math.exp(beta * to) - Math.exp(beta * from))),
    quantileAge: (from, p) => Math.log(Math.exp(beta * from) - (beta / A) * Math.log(1 - p)) / beta,
  };
}

/**
 * Âges de décès représentatifs d'une personne : les médianes de `states` tranches égales de probabilité
 * de sa durée de vie restante (avec 5 états : 10 %, 30 %, 50 %, 70 % et 90 % de chances d'être décédée).
 * Chaque état pèse donc 1/`states`. `ageAtStart` est l'âge atteint durant la première année du plan
 * (année de départ - année de naissance); un âge supérieur à `endAge` devient `undefined` (vit jusqu'à la fin du plan).
 */
export function representativeDeathAges(model: MortalityModel, ageAtStart: number, states: number, endAge: number): (number | undefined)[] {
  const from = ageAtStart - 0.5; // âge moyen au 1er janvier de l'année de départ
  const out: (number | undefined)[] = [];
  for (let k = 0; k < states; k++) {
    const age = Math.max(ageAtStart, Math.round(model.quantileAge(from, (k + 0.5) / states)));
    out.push(age > endAge ? undefined : age);
  }
  return out;
}
