#!/usr/bin/env node
/**
 * One-time setup: install Python backend deps + frontend npm deps.
 *
 *   npm run setup
 *
 * Cross-platform. Requires `python` on PATH (use whatever env you like:
 * conda, venv, system Python). Override with `PYTHON_BIN=...` if needed.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const isWin = process.platform === "win32";
const PYTHON = process.env.PYTHON_BIN || "python";
const ROOT = __dirname;

function run(label, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n▸ [${label}] ${cmd} ${args.join(" ")}\n`);
    // Windows + Node 20+ requires shell:true to spawn .cmd/.bat (npm).
    const child = spawn(cmd, args, { stdio: "inherit", shell: isWin, ...opts });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`[${label}] exited with code ${code}`));
    });
  });
}

(async () => {
  await run(
    "backend",
    PYTHON,
    ["-m", "pip", "install", "-r", path.join("backend", "requirements.txt")],
    { cwd: ROOT },
  );
  await run("frontend", "npm", ["install"], { cwd: path.join(ROOT, "frontend") });
  process.stdout.write("\n✓ Setup complete. Run `npm start` to launch.\n");
})().catch((err) => {
  process.stderr.write(`\n✗ Setup failed: ${err.message}\n`);
  process.exit(1);
});
