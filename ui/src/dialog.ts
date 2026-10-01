import { esc } from "./format";

// Boîte de confirmation intégrée à la page.
//
// On évite `window.confirm` et les autres boîtes bloquantes du navigateur : sous Electron (Windows),
// elles font perdre le focus clavier à la fenêtre, et les champs de saisie ne répondent plus ensuite.

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
}

/** Affiche la boîte et retourne `true` si l'utilisateur confirme; Échap, « Annuler » ou un clic à côté retournent `false`. */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const opener = document.activeElement as HTMLElement | null;
    const id = `dlg-${Math.random().toString(36).slice(2, 9)}`;
    const dlg = document.createElement("dialog");
    dlg.className = "confirm";
    dlg.setAttribute("aria-labelledby", `${id}-t`);
    dlg.setAttribute("aria-describedby", `${id}-m`);
    dlg.innerHTML = `<h2 id="${id}-t">${esc(o.title)}</h2><p id="${id}-m">${esc(o.message)}</p>` +
      `<div class="buttons"><button type="button" class="ghost dark" data-result="">${esc(o.cancelLabel ?? "Annuler")}</button>` +
      `<button type="button" class="primary" data-result="ok">${esc(o.confirmLabel)}</button></div>`;
    dlg.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-result]") as HTMLElement | null;
      if (b) { dlg.close(b.dataset.result!); return; }
      const r = dlg.getBoundingClientRect();      // clic sur le fond assombri : annuler
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close("");
    });
    dlg.addEventListener("close", () => {
      const confirmed = dlg.returnValue === "ok";
      dlg.remove();
      if (opener?.isConnected) opener.focus();     // rend le focus à l'élément d'origine, s'il existe encore
      resolve(confirmed);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    (dlg.querySelector('button[data-result=""]') as HTMLElement).focus();   // par défaut : « Annuler »
  });
}
