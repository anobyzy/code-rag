-- Legacy vectors have unknown provenance. Ingest safely refreshes them from Git.
alter table code_rag.chunks add column if not exists embedding_model text;
alter table code_rag.chunks alter column project_namespace drop default;
