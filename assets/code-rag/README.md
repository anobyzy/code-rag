# Code RAG in your project

This package indexes the source code of your Git checkout in a dedicated PostgreSQL database. A coding agent can search by name, words, or similarity and retrieve relevant excerpts with their file paths.

## Everyday commands

From `packages/code-rag`, run:

```bash
npm run ingest -- ../..
npm run query -- "Where is WebhookController tested?" --module api --budget 3000
```

Ingest reads the current contents of eligible tracked files. Use `git add` to make new files eligible. Queries use the last successful index. If you enabled hooks, `.code-rag-ingest.log` records the last automatic attempt.

## Install or upgrade

For a new installation, configure `src/constants.ts` and `.env` as described in the [skill guide](https://github.com/anobyzy/code-rag/blob/main/SKILL.md). Then run `docker compose up -d --wait`, `npm ci`, `npm run build`, `npm run migrate`, and `npm run ingest -- ../..`.

To upgrade an existing installation, merge the new template while keeping project settings and the PostgreSQL volume. Then run `npm ci`, `npm run build`, `npm run migrate`, and `npm run ingest -- ../..`.

Embeddings run offline by default. Enable Voyage only after approving the transmission of source excerpts and query text. See the [Code RAG README](https://github.com/anobyzy/code-rag#code-rag) for the full guide and database diagram.
