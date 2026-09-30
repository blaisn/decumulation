// Ouvrir et enregistrer des fichiers : boîtes de dialogue d'Electron si disponibles, sinon le navigateur.

export interface RetraiteBridge {
  openFile(): Promise<{ name: string; content: string } | null>;
  saveFile(suggestedName: string, content: string, kind: "json" | "csv"): Promise<boolean>;
}
declare global { interface Window { retraite?: RetraiteBridge } }

export async function openScenarioFile(): Promise<{ name: string; content: string } | null> {
  if (window.retraite) return window.retraite.openFile();
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, content: await f.text() } : null);
    };
    input.click();
  });
}

export async function saveFile(name: string, content: string, kind: "json" | "csv"): Promise<boolean> {
  if (window.retraite) return window.retraite.saveFile(name, content, kind);
  const blob = new Blob([content], { type: kind === "json" ? "application/json" : "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}
