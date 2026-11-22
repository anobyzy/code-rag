-- Codebase RAG (engineering index).
-- Lives in an ISOLATED schema `code_rag`. It must NEVER share storage with the
-- product runtime RAG (public.knowledge_chunks, RLS-per-org). Run this against an
-- engineering database that holds NO tenant data. See packages/code-rag/CLAUDE.md.

create schema if not exists code_rag;
create extension if not exists vector with schema code_rag;
create extension if not exists pg_trgm with schema code_rag;

create table if not exists code_rag.chunks (
  id                    uuid primary key default gen_random_uuid(),
  project_namespace     text not null default 'nucleus_crm',
  file_path             text not null,
  layer                 text not null check (layer in
                          ('spec','global','interface','implementation','test')),
  module                text not null,                 -- foundation|whatsapp|leads|...
  symbols_defined       text[]  not null default '{}',
  dependencies_imported text[]  not null default '{}',
  requirement_refs      text[]  not null default '{}', -- RF-01..RF-16
  invariant_tags        text[]  not null default '{}', -- org_id|rls|idempotency|...
  content               text not null,
  content_tsv           tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding             vector(1024),                  -- voyage-code-3 (default 1024)
  content_hash          text not null,
  source_commit         text,
  updated_at            timestamptz not null default now(),
  unique (project_namespace, file_path, content_hash)
);

create index if not exists chunks_embedding_hnsw
  on code_rag.chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_tsv_gin
  on code_rag.chunks using gin (content_tsv);
create index if not exists chunks_symbols_gin
  on code_rag.chunks using gin (symbols_defined);
create index if not exists chunks_invariants_gin
  on code_rag.chunks using gin (invariant_tags);
create index if not exists chunks_reqs_gin
  on code_rag.chunks using gin (requirement_refs);
create index if not exists chunks_module_layer
  on code_rag.chunks (module, layer);

create table if not exists code_rag.code_symbols (
  symbol   text not null,
  chunk_id uuid not null references code_rag.chunks(id) on delete cascade,
  kind     text not null,
  primary key (symbol, chunk_id)
);
create index if not exists code_symbols_trgm
  on code_rag.code_symbols using gin (symbol gin_trgm_ops);

create table if not exists code_rag.code_edges (
  src_chunk uuid not null references code_rag.chunks(id) on delete cascade,
  dst_chunk uuid not null references code_rag.chunks(id) on delete cascade,
  edge_type text not null,        -- import|defines|satisfies_req|shares_contract|...
  weight    real not null default 1.0,
  primary key (src_chunk, dst_chunk, edge_type)
);
create index if not exists code_edges_dst on code_rag.code_edges (dst_chunk);
