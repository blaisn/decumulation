import type { BenefitChoice, ChoiceResult, CompareOptions, Scenario } from "../../src/index";
import type { Job, JobResult } from "./compute";

// Exécution parallèle d'une optimisation : les combinaisons sont découpées en petits lots, distribués à plusieurs Web Workers.
// Si les workers ne sont pas disponibles ou échouent, le calcul se poursuit dans le fil principal, par lots, en laissant
// l'interface respirer entre deux lots. Aucune dépendance au navigateur : tout passe par `PoolDeps`, ce qui permet de tester.

export class OptimizationCancelled extends Error {
  constructor() { super("Optimisation annulée"); this.name = "OptimizationCancelled"; }
}

export interface PoolWorker {
  postMessage(message: { id: number; job: Job }): void;
  terminate(): void;
  onmessage: ((e: { data: { id: number; ok: boolean; result?: unknown; error?: string } }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface PoolDeps {
  /** Crée un worker; s'il est absent ou lève une erreur, tout est calculé dans le fil principal. */
  createWorker?: () => PoolWorker;
  workers?: number;
  chunkSize?: number;
  /** Calcul dans le fil principal (solution de secours). */
  evaluate: (job: Job) => JobResult;
  /** Rend la main à l'interface entre deux lots du calcul de secours. */
  yieldToUi?: () => Promise<void>;
}

export interface OptimizationRun {
  promise: Promise<ChoiceResult[]>;
  cancel(): void;
}

export function chunkChoices<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Nombre de workers à utiliser : un cœur reste libre pour l'interface. */
export function workerCount(hardwareConcurrency: number | undefined): number {
  return Math.max(1, Math.min(8, (hardwareConcurrency || 4) - 1));
}

export function runChoices(scenario: Scenario, options: CompareOptions, choices: BenefitChoice[], onProgress: (done: number, total: number) => void, deps: PoolDeps): OptimizationRun {
  const tasks = chunkChoices(choices, deps.chunkSize ?? 4);
  const total = choices.length;
  const results: (ChoiceResult[] | undefined)[] = tasks.map(() => undefined);
  const workers: PoolWorker[] = [];
  let done = 0, cancelled = false, settled = false, fellBack = false;
  let resolveRun!: (r: ChoiceResult[]) => void, rejectRun!: (e: Error) => void;
  const promise = new Promise<ChoiceResult[]>((res, rej) => { resolveRun = res; rejectRun = rej; });

  const jobFor = (k: number): Job => ({ kind: "choices", scenario, options, choices: tasks[k] });
  const stopWorkers = () => { workers.splice(0).forEach((w) => { try { w.terminate(); } catch { /* déjà arrêté */ } }); };
  const finish = () => { if (settled) return; settled = true; stopWorkers(); resolveRun(results.flatMap((r) => r!)); };
  const fail = (e: Error) => { if (settled) return; settled = true; stopWorkers(); rejectRun(e); };
  const record = (k: number, r: ChoiceResult[]) => { results[k] = r; done += tasks[k].length; onProgress(done, total); };
  const complete = () => results.every((r) => r !== undefined);

  /**
   * Calcule dans le fil principal les lots qui manquent encore, une combinaison à la fois : la page reste utilisable
   * (et l'annulation possible) entre deux combinaisons, au lieu d'être bloquée pendant tout un lot.
   */
  async function inlineRest() {
    for (let k = 0; k < tasks.length; k++) {
      if (cancelled || settled) return;
      if (results[k]) continue;
      const part: ChoiceResult[] = [];
      for (const c of tasks[k]) {
        await (deps.yieldToUi ? deps.yieldToUi() : Promise.resolve());
        if (cancelled || settled) return;
        try { part.push(...(deps.evaluate({ kind: "choices", scenario, options, choices: [c] }) as ChoiceResult[])); } catch (e) { fail(e as Error); return; }
        onProgress(done + part.length, total);
      }
      record(k, part);
    }
    if (complete()) finish();
  }
  const fallBack = () => { if (fellBack || settled) return; fellBack = true; stopWorkers(); void inlineRest(); };

  function startWorkers(n: number) {
    let next = 0;
    const feed = (w: PoolWorker) => {
      while (next < tasks.length && results[next]) next++;
      if (next >= tasks.length) return;
      const id = next++;
      w.postMessage({ id, job: jobFor(id) });
    };
    for (let i = 0; i < n; i++) {
      const w = deps.createWorker!();
      w.onmessage = (e) => {
        if (cancelled || settled || fellBack) return;
        if (!e.data.ok) { fallBack(); return; }
        record(e.data.id, e.data.result as ChoiceResult[]);
        if (complete()) finish(); else feed(w);
      };
      w.onerror = () => { if (!cancelled) fallBack(); };
      workers.push(w);
    }
    [...workers].forEach(feed);
  }

  onProgress(0, total);
  if (!tasks.length) finish();
  else if (deps.createWorker) {
    try { startWorkers(Math.max(1, Math.min(deps.workers ?? 1, tasks.length))); }
    catch { fallBack(); }
  } else void inlineRest();

  return { promise, cancel() { if (settled) return; cancelled = true; fail(new OptimizationCancelled()); } };
}
