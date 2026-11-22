#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CodeRagClient } from "./client.js";
import { ingest, reembed } from "./ingest.js";
import { buildContextPrompt } from "./query.js";
import { ENV, MODULES } from "./constants.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function loadDotenv(): void {
  const file = path.resolve(here, "../.env");
  if (!existsSync(file)) return;
  const supported = new Set<string>(Object.values(ENV));
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const entry = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (entry && supported.has(entry[1]) && process.env[entry[1]] === undefined) {
      process.env[entry[1]] = entry[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
}

async function main(): Promise<void> {
  loadDotenv();
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "migrate": {
      if (args.length) throw new Error("Usage: code-rag migrate");
      const client = new CodeRagClient();
      try {
        await client.migrate();
      } finally {
        await client.end();
      }
      return;
    }
    case "reembed": {
      if (args.length > 1 || args[0]?.startsWith("--")) throw new Error("Usage: code-rag reembed [repo-root]");
      const n = await reembed(path.resolve(args[0] ?? repoRoot));
      process.stderr.write(`re-embedded ${n} chunks\n`);
      return;
    }
    case "ingest": {
      const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { commit: { type: "string" } } });
      if (positionals.length > 1) throw new Error("Usage: code-rag ingest [repo-root] [--commit SHA]");
      const root = path.resolve(positionals[0] ?? repoRoot);
      const result = await ingest(root, values.commit);
      process.stderr.write(`indexed ${result.total} chunks (${result.embedded} embedded, ${result.pruned} pruned)\n`);
      return;
    }
    case "query": {
      const { positionals, values } = parseArgs({ args, allowPositionals: true,
        options: { module: { type: "string" }, budget: { type: "string" } } });
      if (positionals.length !== 1) throw new Error('Usage: code-rag query "<task>" [--module <name>] [--budget 6000]');
      const module = MODULES.find((name) => name === values.module);
      if (values.module !== undefined && !module) throw new Error(`Unknown module. Choose from ${MODULES.join(", ")}.`);
      const prompt = await buildContextPrompt(positionals[0], {
        module,
        budgetTokens: values.budget === undefined ? undefined : Number(values.budget),
      });
      process.stdout.write(prompt + "\n");
      return;
    }
    default:
      throw new Error('Commands: migrate | ingest [repo-root] | reembed [repo-root] | query "<task>"');
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
