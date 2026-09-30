import { runJob } from "./compute";
import type { Job } from "./compute";

// Exécute les calculs lourds hors du fil de l'interface.
self.onmessage = (e: MessageEvent<{ id: number; job: Job }>) => {
  const { id, job } = e.data;
  try {
    (self as unknown as Worker).postMessage({ id, ok: true, result: runJob(job) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
