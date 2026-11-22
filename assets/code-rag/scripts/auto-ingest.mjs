// Shared entrypoint for the Claude Code Stop hook and the git post-commit/post-merge
// hooks. Refreshes asynchronously from hooks; run directly for a foreground attempt.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const script = fileURLToPath(import.meta.url);
const pkg = path.resolve(path.dirname(script), "..");
const repoRoot = path.resolve(pkg, "../..");
const cli = path.join(pkg, "dist", "cli.js");
const log = path.join(pkg, ".code-rag-ingest.log");

function logStatus(message) {
  const temporary = `${log}.${randomUUID()}.log`;
  try {
    writeFileSync(temporary, `[${new Date().toISOString()}] ${message}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    return;
  }
  try {
    renameSync(temporary, log);
  } catch {
    try { unlinkSync(temporary); } catch { /* ignore */ }
  }
}

if (process.argv.includes("--background")) {
  const job = spawn(process.execPath, [script], { cwd: pkg, detached: true, stdio: "ignore", windowsHide: true });
  job.on("error", () => logStatus("Could not start code RAG ingest."));
  job.unref();
} else {
  const result = spawnSync(process.execPath, [cli, "ingest", repoRoot], {
    cwd: pkg, stdio: "ignore", timeout: 120000, windowsHide: true,
  });
  logStatus(result.status === 0 ? "Ingest completed." : "Ingest failed. Run npm run ingest in packages/code-rag to diagnose.");
}
