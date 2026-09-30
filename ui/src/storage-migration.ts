// Clés du stockage local de l'interface. Les anciennes clés (nom « retraite-planner ») sont migrées au démarrage.

export const KEYS = {
  form: "decumulation.form.v1",
  base: "decumulation.base.v1",
  prefs: "decumulation.prefs.v1",
} as const;

const LEGACY: [string, string][] = [
  ["retraite-planner.form.v1", KEYS.form],
  ["retraite-planner.base.v1", KEYS.base],
  ["retraite-planner.prefs.v1", KEYS.prefs],
];

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Copie chaque ancienne clé vers la nouvelle, puis supprime l'ancienne. Si la nouvelle clé existe déjà,
 * elle est conservée (elle est plus récente). Retourne les nouvelles clés écrites.
 */
export function migrateLegacyKeys(storage: StorageLike): string[] {
  const moved: string[] = [];
  for (const [oldKey, newKey] of LEGACY) {
    try {
      const value = storage.getItem(oldKey);
      if (value === null) continue;
      if (storage.getItem(newKey) === null) { storage.setItem(newKey, value); moved.push(newKey); }
      storage.removeItem(oldKey);
    } catch { /* stockage indisponible : on garde les anciennes clés */ }
  }
  return moved;
}
