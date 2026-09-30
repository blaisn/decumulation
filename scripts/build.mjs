// Assemble l'application dans dist/ : interface (navigateur), worker, et processus Electron.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/renderer", { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: "info" };
await build({ ...common, entryPoints: { main: "ui/src/main.ts", worker: "ui/src/worker.ts" }, outdir: "dist/renderer", platform: "browser", format: "iife", target: "chrome120" });
await build({ ...common, entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts" }, outdir: "dist/electron", platform: "node", format: "cjs", target: "node20", external: ["electron"] });
await cp("ui/index.html", "dist/renderer/index.html");
await cp("ui/styles.css", "dist/renderer/styles.css");
