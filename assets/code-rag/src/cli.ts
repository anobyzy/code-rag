#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeRagClient } from "./client.js";
import { ingest, reembed } from "./ingest.js";
import { buildContextPrompt } from "./query.js";
import { Module } from "./constants.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../migrations");

/** Auto-load packages/code-rag/.env so commands need no manual env export. */
function loadDotenv(): void {
  const f = path.resolve(here, "../.env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadDotenv();

async function migrate(): Promise<void> {
  const client = new CodeRagClient();
  try {
    for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      process.stderr.write(`applying ${f}\n`);
      await client.raw(readFileSync(path.join(migrationsDir, f), "utf8"));
    }
  } finally {
    await client.end();
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "migrate":
      await migrate();
      return;
    case "reembed": {
      const n = await reembed();
      process.stderr.write(`re-embedded ${n} chunks\n`);
      return;
    }
    case "ingest": {
      const root = args.find((a) => !a.startsWith("--")) ?? ".";
      const r = await ingest(path.resolve(root), flag(args, "--commit"));
      process.stderr.write(
        `indexed ${r.total} chunks from ${root} (${r.embedded} (re)embedded, ${r.pruned} pruned)\n`,
      );
      return;
    }
    case "query": {
      const task = args.find((a) => !a.startsWith("--"));
      if (!task) throw new Error('usage: code-rag query "<task>" [--module whatsapp] [--budget 6000]');
      const prompt = await buildContextPrompt(task, {
        module: flag(args, "--module") as Module | undefined,
        budgetTokens: flag(args, "--budget") ? Number(flag(args, "--budget")) : undefined,
      });
      process.stdout.write(prompt + "\n");
      return;
    }
    default:
      process.stderr.write("commands: migrate | ingest <path> | reembed | query \"<task>\"\n");
      process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
