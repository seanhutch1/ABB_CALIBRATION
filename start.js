#!/usr/bin/env node
/**
 * Start the backend (FastAPI/uvicorn) and frontend (Vite dev) together.
 *
 *   npm start
 *
 * Cross-platform. Streams both processes' output to this terminal with a
 * coloured prefix. Ctrl+C terminates both cleanly:
 *   - Children get a grace period to shut down on their own (uvicorn's
 *     lifespan teardown runs, the camera pipeline is released, etc.).
 *   - Anything still alive after the grace period is force-killed.
 *   - The launcher waits for both children to actually exit before itself
 *     exiting.
 *
 * Vite is launched directly via Node (skipping npm.cmd / cmd.exe) so
 * Windows doesn't show the "Terminate batch job (Y/N)?" prompt on Ctrl+C.
 *
 * Configuration (all optional, via env):
 *   PYTHON_BIN     path to python executable (default: `python` on PATH)
 *   BACKEND_HOST   default 127.0.0.1
 *   BACKEND_PORT   default 8000
 *   CAMERA_MODE    auto | usb3 | usb2  (default: auto)
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const isWin = process.platform === "win32";
const PYTHON = process.env.PYTHON_BIN || "python";
const ROOT = __dirname;

const BACKEND_HOST = process.env.BACKEND_HOST || "127.0.0.1";
const BACKEND_PORT = process.env.BACKEND_PORT || "8000";

// uvicorn's default graceful-shutdown timeout is 30 s, which means it waits
// up to 30 s for open MJPEG connections (i.e. your browser tab) to close
// before exiting. Override that to keep Ctrl+C snappy.
const UVICORN_GRACEFUL_S = "1";

const GRACE_MS = 5000;       // graceful-shutdown window before force-kill
const FORCE_WAIT_MS = 2000;  // wait for force-kill to actually finish

const COLORS = {
  backend: "\x1b[36m",  // cyan
  frontend: "\x1b[35m", // magenta
  reset: "\x1b[0m",
};

function prefixedPipe(label, color, stream, target) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      target.write(`${color}[${label}]${COLORS.reset} ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buf.length > 0) target.write(`${color}[${label}]${COLORS.reset} ${buf}\n`);
  });
}

function launch(label, color, cmd, args, cwd) {
  process.stdout.write(`${color}[${label}]${COLORS.reset} starting: ${cmd} ${args.join(" ")}\n`);
  const child = spawn(cmd, args, { cwd, env: process.env });
  prefixedPipe(label, color, child.stdout, process.stdout);
  prefixedPipe(label, color, child.stderr, process.stderr);
  return child;
}

const backend = launch(
  "backend",
  COLORS.backend,
  PYTHON,
  [
    "-m", "uvicorn", "app.main:app",
    "--host", BACKEND_HOST,
    "--port", BACKEND_PORT,
    "--reload",
    "--timeout-graceful-shutdown", UVICORN_GRACEFUL_S,
  ],
  path.join(ROOT, "backend"),
);

const viteJs = path.join(ROOT, "frontend", "node_modules", "vite", "bin", "vite.js");
if (!fs.existsSync(viteJs)) {
  process.stderr.write(
    `\n✗ vite is not installed at ${viteJs}\n  Run \`npm run setup\` first.\n`,
  );
  backend.kill();
  process.exit(1);
}
const frontend = launch(
  "frontend",
  COLORS.frontend,
  process.execPath,  // current Node binary — avoids npm.cmd / cmd.exe
  [viteJs],
  path.join(ROOT, "frontend"),
);

function isAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child) {
  if (!isAlive(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function forceKill(child, label) {
  if (!isAlive(child)) return;
  process.stdout.write(`  force-killing [${label}] (pid ${child.pid})…\n`);
  try {
    if (isWin) {
      // /T = terminate process tree (uvicorn --reload spawns a worker).
      // /F = force.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // ignore — process may have died between checks
  }
}

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\nShutting down (${reason})…\n`);

  // On Unix, send SIGTERM ourselves. On Windows, the console has already
  // broadcast CTRL_C_EVENT to all children if this was triggered by Ctrl+C;
  // if it wasn't (e.g. one child crashed), there's no clean way to signal
  // a console app, so we just wait the grace period and force-kill.
  if (!isWin) {
    for (const child of [backend, frontend]) {
      if (isAlive(child)) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }
  }

  // Wait up to GRACE_MS for both to exit on their own.
  await Promise.race([
    Promise.all([waitForExit(backend), waitForExit(frontend)]),
    sleep(GRACE_MS),
  ]);

  // Force-kill any survivors.
  if (isAlive(backend)) forceKill(backend, "backend");
  if (isAlive(frontend)) forceKill(frontend, "frontend");

  // Wait for the force-kills to actually take effect.
  await Promise.race([
    Promise.all([waitForExit(backend), waitForExit(frontend)]),
    sleep(FORCE_WAIT_MS),
  ]);

  process.exit(0);
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

backend.on("exit", (code) => {
  process.stdout.write(`[backend] exited (${code})\n`);
  if (!shuttingDown) void shutdown("backend exited");
});
frontend.on("exit", (code) => {
  process.stdout.write(`[frontend] exited (${code})\n`);
  if (!shuttingDown) void shutdown("frontend exited");
});
