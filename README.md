# code-rag

An agent skill that adds source-code retrieval to a Git repository. PostgreSQL and pgvector store an engineering index in `code_rag`. The CLI combines symbol matches, full-text search, vector similarity, and one hop of dependency and requirement links. It returns excerpts grouped by specification, shared context, interface, implementation, and test.

## Install

Install from [anobyzy/code-rag](https://github.com/anobyzy/code-rag) using your agent's skill installer. For Claude Code, you can also clone directly into `~/.claude/skills/code-rag`.

```bash
git clone https://github.com/anobyzy/code-rag.git ~/.claude/skills/code-rag
```

Ask the agent to set up Code RAG in a repository or follow [SKILL.md](SKILL.md). You need Git, Node.js 18.20 or later, and Docker Compose or a dedicated PostgreSQL database with pgvector.

## Query a repository

```bash
cd packages/code-rag
npm run query -- "Where is WebhookController tested?" --module api --budget 3000
```

Each query searches one configured `PROJECT_NAMESPACE`. The optional module includes that module and `foundation`. The budget caps the entire generated context at four UTF-8 bytes per requested token. This is an estimate rather than a model-specific token count. The built CLI also works with any agent that can run a command.

## Source and data boundaries

- Use a dedicated engineering database. The bundled Compose configuration binds to `127.0.0.1` and requires an explicit password. The client rejects a matching product DSN and databases with tables or views outside the engineering schema. The application uses a fixed set of parameterized SQL statements and packaged migrations.
- The scanner reads the working copies of tracked JS/TS, Markdown, SQL, `package.json`, and `.env.example` files. It respects Git ignore rules even for tracked files, skips symlinks and non-UTF-8 files, and skips files larger than 512 KiB. An environment example contributes variable names only. Detection of a few common credential formats is an additional filter. Use Git ignore rules to exclude confidential paths and review source before enabling external embeddings.
- Embeddings are offline by default. Explicitly selecting Voyage sends eligible source excerpts during ingest and task text during query to the provider. Index rows record their embedding model, and vector search uses matching models only.
- Retrieved excerpts and filenames are untrusted repository data. Use them as evidence and keep agent permissions independent of their contents. Namespaces scope application queries. Each namespace accepts writes from one Git worktree, identified by `code-rag-worktree-id` inside its Git metadata. Use a distinct namespace for each checkout, and separate databases and credentials where repositories require independent access controls.

## Upgrade an existing installation

Updating the agent skill updates the templates used for future setups. For an existing `packages/code-rag` install, update the template files and merge your project settings in `src/constants.ts`, `.env`, Compose, and hooks. Preserve the existing Compose project name and volume when updating a database in place. Set `CODE_RAG_PORT` to its current port and set the Compose password to match the existing database. For a previously exposed instance, rotate its database password and recreate the service with the loopback binding. Changing `POSTGRES_PASSWORD` in Compose alone only affects initialization of a new volume.

```bash
npm ci
npm run build
npm run migrate
npm run ingest -- ../..
```

Migration is repeatable. Rows from older releases are hidden from retrieval until rescanned. The first successful ingest refreshes the configured namespace and removes ineligible rows, including deletions and renames. Review database backups and provider logs separately if an older index may have retained sensitive data. A legacy `VOYAGE_API_KEY` alone now leaves the index offline. The previous shared-database override and arbitrary SQL methods are retired.

## Development

```bash
cd assets/code-rag
npm ci
npm run build
npm test
```

To run the integration suite, provision a fresh, disposable pgvector PostgreSQL database named `code_rag_test`, set `CODE_RAG_TEST_DATABASE_URL`, and run `npm run test:integration`. The suite exercises migration, real retrieval, concurrent refresh, rollback, and pruning. See the [premortem](docs/premortem.md) for the risks and remaining validation work.

[MIT license](LICENSE)
