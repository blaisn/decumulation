// Préférences d'affichage conservées entre deux ouvertures (stockage local).

export interface Prefs {
  real: boolean; // montants en dollars constants (true) ou courants avec l'inflation (false)
  hideForm: boolean; // panneau du formulaire masqué pour donner toute la largeur aux résultats
  hideDetailNote: boolean; // note explicative du Détail annuel masquée
}

/** Lit les préférences; toute valeur absente, invalide ou d'une ancienne version reprend sa valeur par défaut. */
export function parsePrefs(text: string | null): Prefs {
  try {
    const p = JSON.parse(text ?? "{}") as Partial<Prefs> | null;
    return { real: p?.real === true, hideForm: p?.hideForm === true, hideDetailNote: p?.hideDetailNote === true };
  } catch {
    return { real: false, hideForm: false, hideDetailNote: false };
  }
}
