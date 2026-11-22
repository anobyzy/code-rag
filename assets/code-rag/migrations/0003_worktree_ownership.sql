create table if not exists code_rag.index_owners (
  project_namespace text primary key,
  worktree_id uuid not null
);
