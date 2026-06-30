# code-rag

RAG over the **source code** of this repo, so coding agents retrieve dependency-aware
context. Configure per-project values in `src/constants.ts`.

> **This is not the product RAG.** Your application's runtime retrieval (if any) runs over
> your product DB with tenant isolation. This package indexes code in the `code_rag` schema
> of a separate engineering DB. The separation is enforced at runtime — see `CLAUDE.md`.

## Architecture

- **Storage:** Postgres + pgvector, isolated schema `code_rag` (`migrations/0001_code_rag.sql`).
- **Hybrid:** `code_symbols` (exact identifiers), `tsvector` (lexical), `embedding`
  (dense, `voyage-code-3` or offline fallback), `code_edges` (dependency graph for multi-hop).
- **Per-chunk metadata:** `project_namespace, file_path, layer, module, symbols_defined,`
  `dependencies_imported, requirement_refs, invariant_tags`.
- **Re-rank:** dense + lexical + dependency distance + layer + module match + requirement match.

## Commands

```
docker compose up -d        # isolated Postgres + pgvector (default port 5433)
npm install
npm run migrate             # create the code_rag schema
npm run ingest -- ../..     # index the repo root
npx tsx src/cli.ts query "<task>" [--module m] [--budget n]
npm run reembed             # regenerate all vectors (after switching embedder)
npm test                    # guard + partitioner tests (offline)
```

> `query` runs the cli directly: `npm run query -- --flag` is mangled by npm (flags vanish).

## Automatic ingest (no manual command)

- **Claude Code Stop hook** (`.claude/settings.json`): re-indexes at the end of each agent turn.
- **Git hooks** (`.githooks/post-commit`, `post-merge` via `core.hooksPath`): re-index after
  commit/merge/pull — covers manual edits too.

Both call `scripts/auto-ingest.mjs`, which is **incremental** (re-embeds only changed chunks)
and **failure-tolerant** (always exit 0; logs to `.code-rag-ingest.log` if the DB is down). A
no-change turn is read-only. The wrapper uses `dist/cli.js`, so after editing **this package's
own code** run `npm run build`.

## Known limits (v0)

- Partitioner is heuristic (regex), not AST. Upgrade path: `ts-morph` (.ts) + `@babel/parser`
  (.js JSX). The chunk contract does not change when AST lands.
- True BM25 needs an extension (e.g. ParadeDB); `ts_rank_cd` is the lexical channel for now.
- Free-tier Voyage (no payment method) is rate-limited (3 RPM / 10K TPM); the client retries
  on 429 with backoff, but a bulk `reembed` is slow until you add a payment method (free
  tokens still apply).
