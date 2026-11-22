# Code RAG no seu projeto

Este pacote indexa o código-fonte do seu checkout Git em um banco PostgreSQL dedicado. O agente pode buscar símbolos, palavras e trechos semelhantes e receber o caminho dos arquivos junto com o contexto.

## Comandos do dia a dia

Execute em `packages/code-rag`:

```bash
npm run ingest -- ../..
npm run query -- "Onde WebhookController é testado?" --module api --budget 3000
```

O ingest lê a versão atual dos arquivos rastreados. Para incluir arquivos novos, use `git add` antes. A consulta lê o último índice disponível. Se os hooks estiverem ativos, confira `.code-rag-ingest.log` para ver o resultado do último ingest automático.

## Instalação e atualização

Para uma instalação nova, configure `src/constants.ts` e `.env` conforme o [guia da skill](https://github.com/anobyzy/code-rag/blob/main/SKILL.md). Depois execute `docker compose up -d --wait`, `npm ci`, `npm run build`, `npm run migrate` e `npm run ingest -- ../..`.

Ao atualizar este pacote, preserve as configurações do projeto e o volume do PostgreSQL. Depois de mesclar o template novo, rode `npm ci`, `npm run build`, `npm run migrate` e `npm run ingest -- ../..`.

Os embeddings são locais por padrão. A ativação da Voyage requer autorização para enviar trechos de código e texto das consultas. Consulte o [README do Code RAG](https://github.com/anobyzy/code-rag#code-rag) para ver o diagrama do banco e o guia completo.
