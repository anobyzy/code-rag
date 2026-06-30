# code-rag

A [Claude Code](https://claude.com/claude-code) skill that bootstraps a **codebase RAG** —
a retrieval index over your **source code**, for coding agents — into any repository, and
keeps it fed automatically. It is built around one hard invariant: the code index stays
**strictly separate** from any product/runtime RAG and never touches tenant data.

> **Two RAGs, never mixed.** Many apps already have a *product RAG* (a runtime feature that
> answers end-user questions over application data, e.g. a `knowledge_chunks` table with
> tenant isolation). This skill creates a *different* thing: an *engineering* index of the
> source code so a coding agent can retrieve contracts → implementations → tests while it
> works. Confusing the two is a data-leak waiting to happen, so the package enforces the wall
> in code.

---

## What you get

When you invoke the skill in a project, it drops a self-contained `packages/code-rag/`
package and wires it up:

- **Isolated storage** — a dedicated Postgres + `pgvector` `code_rag` schema in an
  *engineering* database (Docker Compose), never your product DB.
- **A separation guard** — a runtime guard that refuses a DB URL equal to your product
  `DATABASE_URL` and asserts every SQL statement is `code_rag`-qualified. Anything that looks
  like a product table throws `RagSeparationError`.
- **Hybrid retrieval** — exact symbol lookup + lexical (`tsvector`) + dense vectors, expanded
  over a dependency graph and re-ranked by dependency distance, layer, module and requirement.
- **Embeddings** — Voyage `voyage-code-3` when a key is present, with a deterministic
  **offline fallback** so it runs and tests with no network and no API key.
- **Incremental ingest** — re-embeds only changed chunks (by content hash), prunes stale
  ones, rebuilds the graph only when something changed.
- **Automatic feeding** — a Claude Code *Stop* hook (re-index at end of each agent turn) plus
  git `post-commit`/`post-merge` hooks (covers manual edits). Both share one failure-tolerant
  entrypoint that never blocks a turn or a commit.

---

## How it works

```
repo files ──► partition (per-file-type chunks + metadata) ──► embed ──► code_rag schema
                                                                          │
  query "task" ─► hybrid search (symbol + tsvector + vector)             │
                  └─► 1-hop graph expansion ─► re-rank ─► budget ─► prompt (with banner)
```

| Piece | File | Role |
|---|---|---|
| Schema | `migrations/0001_code_rag.sql` | `chunks` (vector + tsvector), `code_symbols` (exact), `code_edges` (graph) |
| Guard | `src/guard.ts` | the separation wall — DSN check + `code_rag`-only SQL enforcement |
| Client | `src/client.ts` | the only sanctioned DB handle; pins `search_path`, runs every query through the guard |
| Partitioner | `src/partition.ts` | heuristic per-file-type chunking + metadata (skips real `.env`, indexes only keys of `.env.example`) |
| Embeddings | `src/embed.ts` | Voyage `voyage-code-3` (token-batched, retries 429 with backoff) or offline fallback |
| Ingest | `src/ingest.ts` | incremental upsert + prune + edge rebuild; `reembed` to regenerate vectors after switching embedder |
| Query | `src/query.ts` | hybrid search → graph expansion → re-rank → dedupe → budget → prompt |
| Auto-ingest | `scripts/auto-ingest.mjs` | shared, incremental, exit-0 entrypoint for the Stop and git hooks |

Every chunk carries: `project_namespace, file_path, layer, module, symbols_defined,
dependencies_imported, requirement_refs, invariant_tags`. Layers are
`spec · global · interface · implementation · test`.

---

## Install

The skill is a directory under `~/.claude/skills/`:

```bash
git clone https://github.com/<your-username>/code-rag ~/.claude/skills/code-rag
```

Claude Code auto-discovers it. Requirements: **Docker** and **Node 18+** (and Claude Code to
run the skill and the turn hook).

## Use

In any repository, ask Claude Code to set up a codebase RAG (or invoke `/code-rag`). It will:

1. Copy `packages/code-rag/`, `.githooks/`, and a Stop-hook snippet into the repo.
2. Have you set the per-project config in `packages/code-rag/src/constants.ts` — most
   importantly `PRODUCT_TABLES`, the tables the guard must block (this is the separation).
3. Provision the isolated DB (`docker compose up -d`), migrate, and index the repo.
4. Install the git + Stop hooks and verify (guard test, a sample query, a live block check).

After setup it runs itself — the agent edits code and the index refreshes at end of turn; you
commit and the git hook refreshes it. Query it directly:

```bash
cd packages/code-rag
npx tsx src/cli.ts query "implement broadcast respecting rate limit" --module worker
```

### Configuration (`src/constants.ts`)

| Knob | Controls |
|---|---|
| `PROJECT_NAMESPACE` | id stamped on every chunk; required on every query |
| `PRODUCT_TABLES` | tables the guard blocks — **the two-RAG separation** |
| `MODULES` | retrieval scoping; `foundation` is always pulled |
| `PRODUCT_RAG_LABEL` | text shown in the query banner |
| `INVARIANT_PATTERNS` / `INVARIANT_HINTS` | project invariants tagged and surfaced in prompts |
| `CRITICAL_INVARIANTS` | invariant chunks that survive the token budget |
| `REQUIREMENT_RE` | requirement-id scheme for spec↔code traceability edges |

---

## Does it work for…? (scope & honest limitations)

**Any project type / language?** — *Partially.* The architecture (pgvector, guard, hybrid
search, graph, hooks, incremental) is language-agnostic, but the **v0 partitioner is
JS/TS-first**. It ingests `.md, .sql, .ts, .tsx, .js, .json` and extracts symbols with
JS/TS-oriented regexes (classes, functions, React components, NestJS decorators) plus SQL
`CREATE` statements. In a **Python/Go/Rust/Java/PHP** project the code files are not even
ingested yet — you would extend `TEXT_EXT` and add per-language symbol rules (or take the
documented AST upgrade). Out of the box this is a **JS/TS-first** tool.

**Any agent (Codex, Gemini, …)?** — *The index is, the automation is partly Claude-specific.*
The query CLI is just a binary over Postgres, so **any** agent can shell out to
`code-rag query "..."` and use the output. The **git-hook** auto-ingest is universal. The
**Stop-hook** auto-ingest is **Claude Code only** (it lives in `.claude/settings.json`) — on
Codex/Gemini you'd use their own turn hook or simply rely on the git hook. The skill *bootstrapper*
itself is in Claude Code's skill format; the package it generates is portable.

**Any project state?** — *Yes.* It works at the **start** (specs only — it indexes Markdown
and builds requirement→code traceability), in the **middle** (the ideal case), and on a
**finished** codebase (mapping it into a queryable knowledge base). Caveats for large/finished
repos: code is chunked **one chunk per file** until the AST upgrade (coarse for big files),
and the first full index of a huge repo can be slow (the incremental path keeps later runs
cheap). Note this builds a **machine-queryable** index (chunks + dependency graph), **not**
human-readable documentation.

**Without a Voyage key?** — *Yes, with degraded semantics.* It falls back to a deterministic
offline embedder, so it runs and tests with no network. But that embedder is **non-semantic**
(hashed bag-of-tokens): pure "find code about X by meaning" queries are weak. What carries
relevance without Voyage is the rest of the ranking — **exact symbol match + lexical +
dependency graph + layer/module/requirement**. For real semantic retrieval, add a Voyage key
(`voyage-code-3`) and run `npm run reembed` once. Voyage's free tier (no payment method) is
rate-limited to 3 RPM / 10K TPM; the client retries 429 with backoff, but a bulk reembed is
slow until a payment method is added (the free token grant still applies).

---

## Roadmap

To make it truly universal:

- **Local embedder** (e.g. Ollama `nomic-embed-text` / fastembed) — real semantics, no API,
  no cost, fully offline. Small change in `src/embed.ts`.
- **Multilingual partitioner** — extend `TEXT_EXT` + symbol rules, or adopt AST parsing
  (`ts-morph` for TS, `@babel/parser` for JSX, tree-sitter for other languages).
- **Cross-agent turn hooks** — equivalents of the Stop hook for Codex / Gemini CLI.
- **True BM25** — swap `ts_rank_cd` for a BM25 extension (e.g. ParadeDB) where available.

---

## Security

This index holds source code, not user data. The guard makes the boundary explicit:

- `CODE_RAG_DATABASE_URL` must differ from the product `DATABASE_URL` (override only via
  `CODE_RAG_ALLOW_SHARED_DB=1`, which still isolates by schema).
- Every query must be `code_rag`-qualified; product tables throw `RagSeparationError`.
- The partitioner never indexes a real `.env` and stores only the **keys** of `.env.example`.

A secret never belongs in the index; keep your `.env` out of version control (the bundled
`.gitignore` already excludes it).

## License

MIT — see [LICENSE](LICENSE).
