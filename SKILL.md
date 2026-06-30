---
name: code-rag
description: >-
  Bootstrap a codebase RAG (retrieval index over the SOURCE CODE, for coding agents) into a
  project. Use whenever the user wants a code/repository RAG, dependency-aware code retrieval,
  an index of their codebase for an agent, "set up RAG for this repo", AST/chunked code search,
  pgvector code index, or automatic ingestion of code into a vector DB on commit/turn. Sets up
  an isolated Postgres+pgvector `code_rag` schema, a runtime guard that keeps this engineering
  index strictly separate from any product/runtime RAG (no tenant data, ever), Voyage
  voyage-code-3 embeddings with an offline fallback, incremental ingest, and auto-ingest hooks
  (Claude Code Stop + git). NOT for building a product's end-user RAG feature over app data —
  that is a separate system this skill deliberately keeps walled off.
---

# code-rag — bootstrap a codebase RAG

Drops a self-contained `code-rag` package into a repo so coding agents can retrieve
dependency-aware context (contracts → implementations → tests), kept fed automatically.

The load-bearing invariant: **two RAGs must never mix.** This indexes *source code* into an
isolated `code_rag` schema on an *engineering* database. A project's product/runtime RAG (if
any) lives in the product DB over tenant data. The package enforces the wall in code — your
job during setup is to tell it what the product side is (`PRODUCT_TABLES`) so the guard can
block it.

## Prerequisites

- Docker (for the isolated Postgres+pgvector) and Node 18+.
- The target should be a git repo if you want the git hooks (run `git init` first if not).

## Steps

### 1. Copy the templates

From this skill's `assets/`:

- `assets/code-rag/` → `<repo>/packages/code-rag/` (keep this path: the auto-ingest wrapper
  resolves the repo root as `../..` from the package; if you place it elsewhere, adjust
  `scripts/auto-ingest.mjs` and the hook paths accordingly).
- `assets/githooks/` → `<repo>/.githooks/`.
- Merge `assets/claude-settings.snippet.json` into `<repo>/.claude/settings.json` (create the
  file if missing; if it exists, merge the `hooks.Stop` array — do not clobber existing hooks).

Add `node_modules/`, `dist/`, `.env`, `*.log` to the repo's `.gitignore` (a package-local
`.gitignore` is included).

### 2. Configure `packages/code-rag/src/constants.ts` (the only required edit)

This is the single per-project config point. Set:

- `PROJECT_NAMESPACE` — a unique id for this codebase.
- `PRODUCT_TABLES` — **critical.** List the product/runtime tables this index must never
  touch (tenant tables, PII, and especially any product RAG table like `knowledge_chunks`).
  The guard already blocks every non-`code_rag`-qualified table; this list makes the error
  explicit for your most sensitive tables. Get them from the project's schema/migrations.
- `MODULES` — the domain modules used to scope retrieval (`foundation` = shared, always
  pulled). Derive from the repo layout (e.g. `apps/*`, bounded contexts).
- `PRODUCT_RAG_LABEL` — one line naming the product RAG, shown in the query banner.
- Optional: `INVARIANT_PATTERNS` + `INVARIANT_HINTS` (project invariants to tag and surface),
  `CRITICAL_INVARIANTS` (invariant tags whose chunks survive the token budget),
  `REQUIREMENT_RE` (requirement-id scheme used for spec↔code traceability edges).

### 3. Provision the engineering DB

Pick a host port that is free (default `5433`; if taken, change it in both
`docker-compose.yml` and `.env`). Then:

```
cd packages/code-rag
cp .env.example .env          # adjust port/creds if you changed them
docker compose up -d          # wait until the container is healthy
npm install
npm run migrate               # creates the code_rag schema
```

Verify the schema landed in the container (not some other Postgres):
`docker exec code-rag-db psql -U code_rag -d code_rag -c "\dt code_rag.*"` → 3 tables.

### 4. Embeddings (optional but recommended)

Without a key, ingest uses a deterministic **offline fallback** (non-semantic; fine to prove
the pipeline, weak for real retrieval). For real semantic retrieval, put a Voyage key in
`.env` (`VOYAGE_API_KEY=...`, model `voyage-code-3`). Note the free tier (no payment method)
is rate-limited to 3 RPM / 10K TPM — the client retries on 429 with backoff, but a bulk
`reembed` will be slow until a payment method is added (free tokens still apply).

### 5. Build, index, install hooks

```
npm run build                 # dist/ — the hooks/wrapper run from dist
npm run ingest -- ../..       # first full index of the repo
git config core.hooksPath .githooks      # (run at repo root) enables post-commit/post-merge
```

The Claude Code Stop hook is already in `.claude/settings.json`. Because the settings watcher
only picks up `.claude/` files that existed at session start, if you created the file this
session the user must open `/hooks` once (or restart Claude Code) to activate it. Git hooks
are active immediately on the next commit.

If you added `VOYAGE_API_KEY` *after* the first ingest, run `npm run reembed` once —
incremental ingest skips unchanged content, so it won't re-embed existing chunks otherwise.

### 6. Verify (do not skip)

- `npm test` → guard + partitioner tests pass (proves the separation guard and secret-skip).
- A query returns the banner + layered context:
  `npx tsx src/cli.ts query "<a real task in this repo>" --module <module>`
- Live separation check — this MUST throw:
  ```
  npx tsx -e "import('./src/client.ts').then(async m=>{const c=new m.CodeRagClient();try{await c.query('select 1 from some_product_table');console.log('LEAK');}catch(e){console.log('blocked:',e.message);}finally{await c.end().catch(()=>{});}})"
  ```

## Daily use (after setup)

Nothing manual. The agent edits code → Stop hook re-indexes at end of turn; the user commits
→ git hook re-indexes. Query the index directly with `npx tsx src/cli.ts query "..."`.

## Config reference

| Knob (`constants.ts`) | What it controls |
|---|---|
| `PROJECT_NAMESPACE` | id stamped on every chunk; required on every query |
| `PRODUCT_TABLES` | tables the guard blocks (two-RAG separation) |
| `MODULES` | retrieval scoping; `foundation` always included |
| `PRODUCT_RAG_LABEL` | text in the query banner |
| `INVARIANT_PATTERNS` / `INVARIANT_HINTS` | invariants tagged + surfaced in prompts |
| `CRITICAL_INVARIANTS` | invariant chunks that survive the token budget |
| `REQUIREMENT_RE` | requirement-id scheme for traceability edges |

## How it works (so you can adapt it)

- **Storage:** isolated `code_rag` schema; `chunks` (dense `embedding` + `tsvector`),
  `code_symbols` (exact identifier lookup), `code_edges` (import/satisfies_req graph).
- **Guard** (`guard.ts`): refuses a DSN equal to the product `DATABASE_URL`, and asserts every
  SQL statement is `code_rag`-qualified — anything else throws `RagSeparationError`.
- **Partitioner** (`partition.ts`): heuristic per-file-type chunking with metadata; skips real
  `.env`, indexes only keys of `.env.example`. AST upgrade (ts-morph/@babel) is the documented
  next step and does not change the chunk contract.
- **Ingest** (`ingest.ts`): incremental by `content_hash`; prunes stale chunks; rebuilds edges
  only when something changed. `reembed` regenerates all vectors after an embedder switch.
- **Query** (`query.ts`): hybrid (symbol + tsvector + vector) → 1-hop graph expansion →
  re-rank (dense, lexical, dependency distance, layer, module, requirement) → dedupe → budget
  → assemble, always prefixed with the CODE-RAG banner.
- **Auto-ingest** (`scripts/auto-ingest.mjs`): shared, incremental, exit-0 entrypoint for both
  the Stop hook and the git hooks.
