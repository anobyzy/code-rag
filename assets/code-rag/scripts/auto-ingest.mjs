// Shared entrypoint for the Claude Code Stop hook and the git post-commit/post-merge
// hooks. Re-indexes the repo into code_rag. ALWAYS exits 0: never block a turn or a commit
// just because the index could not be refreshed (e.g. container down). Failures go to
// .code-rag-ingest.log next to the package.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");          // packages/code-rag
const repoRoot = path.resolve(pkg, "../..");   // nucleus-crm
const cli = path.join(pkg, "dist", "cli.js");
const log = path.join(pkg, ".code-rag-ingest.log");

const r = spawnSync(process.execPath, [cli, "ingest", repoRoot], {
  cwd: pkg,
  encoding: "utf8",
  timeout: 120000,
});

if (r.status !== 0) {
  try {
    writeFileSync(log, `[${new Date().toISOString()}] ingest failed\n${r.stderr ?? r.error ?? ""}\n`);
  } catch {
    /* ignore */
  }
}
process.exit(0);
