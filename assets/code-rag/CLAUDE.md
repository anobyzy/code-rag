# code-rag — READ BEFORE USING

**There are TWO RAGs. Do not confuse them.**

| | CODE RAG (this package) | PRODUCT RAG |
|---|---|---|
| Purpose | index the **source code** for coding agents | your app's runtime retrieval feature |
| Where | schema `code_rag` (an **engineering** DB) | your product DB (e.g. a `knowledge_chunks` table) |
| Isolation | by `module` | by tenant / `org_id` (e.g. RLS) |
| Data | code, specs, SQL, infra | **tenant data / PII** |
| Env | `CODE_RAG_DATABASE_URL` | `DATABASE_URL` (product) |
| Client | `CodeRagClient` | (your app's DB client) |

## Inviolable rules

1. This package **never** reads/writes product tables. List them in `src/constants.ts`
   (`PRODUCT_TABLES`); `guard.ts` throws `RagSeparationError` on any query that tries — and
   every query must be `code_rag.`-qualified regardless.
2. `CODE_RAG_DATABASE_URL` **must not** be the same database as `DATABASE_URL`. Use a
   separate engineering DB. Same instance only with `CODE_RAG_ALLOW_SHARED_DB=1`
   (schema-only isolation — weaker).
3. To index your product's runtime knowledge base, **do NOT use this package** — that is a
   separate pipeline against your product DB with tenant isolation.
4. Every `query` output starts with a banner declaring it is the CODE RAG. If you are
   generating an answer for an end user, you are in the wrong RAG.

## Usage

The `.env` points at the engineering DB and is auto-loaded by the CLI — export nothing.

```
docker compose up -d        # isolated Postgres + pgvector (default port 5433)
npm run migrate             # create the code_rag schema
npm run ingest -- ../..     # index the repo root
npx tsx src/cli.ts query "<task>" --module <module>
```

`query` runs the cli **directly** (`npx tsx src/cli.ts query ...`): `npm run query -- --flag`
gets mangled by npm (the `--module`/`--budget` flags vanish). `migrate`/`ingest` via npm are fine.

`ingest` also runs **automatically** (Claude Code Stop hook + git hooks via `core.hooksPath`
→ `.githooks/`). The commands above are for bootstrap/debugging.

Without `VOYAGE_API_KEY`, embeddings use a deterministic offline fallback (NON-semantic —
fine for tests, weak for real retrieval). Set the key (`voyage-code-3`) and run
`npm run reembed` once to regenerate existing vectors (content_hash is unchanged, so plain
`ingest` would skip them).

Per-project config lives in `src/constants.ts`: `PROJECT_NAMESPACE`, `PRODUCT_TABLES`,
`MODULES`, `PRODUCT_RAG_LABEL`, `INVARIANT_PATTERNS`, `CRITICAL_INVARIANTS`, `REQUIREMENT_RE`.
