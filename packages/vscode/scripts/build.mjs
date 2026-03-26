import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, "..");
const distDir = path.join(packageDir, "dist");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: {
    extension: path.join(packageDir, "src", "extension.ts"),
    providerProfile: path.join(packageDir, "src", "providerProfile.ts"),
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outdir: distDir,
  external: ["vscode"],
  sourcemap: watch,
  logLevel: "info",
};

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching extension bundle...");
} else {
  await build(options);
}
