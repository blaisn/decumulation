import path from "node:path";

/**
 * Mémoire du dernier dossier utilisé par les boîtes d'ouverture et d'enregistrement.
 *
 * Depuis Electron 43, ces boîtes s'ouvrent dans « Téléchargements » quand aucun dossier de départ n'est fourni, et le système ne
 * retient plus le dernier dossier visité. On le retient donc nous-mêmes, d'une session à l'autre. Ce module ne dépend pas d'Electron
 * (le stockage est injecté) : il est testé sans lancer l'application.
 */
export interface DialogDirStore {
  read(): Promise<string | null>; // dossier mémorisé lors d'une session précédente, ou null
  write(dir: string): Promise<void>;
  isDirectory(dir: string): Promise<boolean>;
}

export function createDialogDir(store: DialogDirStore, fallback: () => string) {
  let loaded = false;
  let current: string | null = null;

  /** Le dossier, s'il est un chemin absolu qui existe encore (il a pu être supprimé ou déplacé). */
  async function usable(dir: string | null): Promise<string | null> {
    if (!dir || !path.isAbsolute(dir)) return null;
    try { return (await store.isDirectory(dir)) ? dir : null; } catch { return null; }
  }

  return {
    /** Dossier de départ de la prochaine boîte de dialogue : le dernier utilisé s'il existe encore, sinon `fallback()` (Documents). */
    async get(): Promise<string> {
      if (!loaded) {
        loaded = true;
        try { current = ((await store.read()) ?? "").trim() || null; } catch { current = null; }
      }
      return (await usable(current)) ?? fallback();
    },
    /** Mémorise le dossier d'un fichier choisi ou enregistré. Un échec d'écriture est sans conséquence : la mémoire est facultative. */
    async remember(filePath: string): Promise<void> {
      const dir = path.dirname(filePath);
      if (!path.isAbsolute(dir)) return;
      loaded = true;
      current = dir;
      try { await store.write(dir); } catch { /* ignoré */ }
    },
  };
}
