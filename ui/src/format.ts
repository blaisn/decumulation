const money = new Intl.NumberFormat("fr-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
const plain = new Intl.NumberFormat("fr-CA", { maximumFractionDigits: 0 });

/** Montant en dollars canadiens, sans décimales (évite « -0 $ »). */
export const fmtMoney = (x: number) => money.format(Math.abs(x) < 0.5 ? 0 : x);
export const fmtNum = (x: number) => plain.format(Math.abs(x) < 0.5 ? 0 : x);

/** Montant abrégé pour les axes : 850 k$, 1,2 M$. */
export function fmtCompact(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e6) return `${(x / 1e6).toLocaleString("fr-CA", { maximumFractionDigits: 1 })} M$`;
  if (a >= 1e3) return `${Math.round(x / 1e3).toLocaleString("fr-CA")} k$`;
  return `${Math.round(x)} $`;
}

/** Pourcentage à deux décimales : 0.3612 -> « 36,12 % ». */
export const fmtPct = (x: number) => `${(x * 100).toLocaleString("fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
