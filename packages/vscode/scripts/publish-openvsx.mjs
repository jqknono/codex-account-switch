import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, "..");
const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
const vsixPath = path.join(packageDir, `${packageJson.name}-${packageJson.version}.vsix`);
const forwardedArgs = process.argv.slice(2);
const env = {
  ...process.env,
  OVSX_PAT: process.env.OVSX_PAT || process.env.OPEN_VSX_TOKEN,
};

await access(vsixPath);

const child = spawn("npx", ["ovsx", "publish", vsixPath, ...forwardedArgs], {
  cwd: packageDir,
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});