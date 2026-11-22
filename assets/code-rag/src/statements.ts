export const SQL = {
  registerOwner: `insert into code_rag.index_owners (project_namespace, worktree_id)
    values ($1, $2) on conflict do nothing`,

  readOwner: `select worktree_id from code_rag.index_owners where project_namespace = $1`,

  existing: `select file_path, content_hash, id, embedding_model from code_rag.chunks
    where project_namespace = $1`,

  upsert: `insert into code_rag.chunks
      (project_namespace, file_path, layer, module, symbols_defined, dependencies_imported,
       requirement_refs, invariant_tags, content, embedding, content_hash, source_commit, embedding_model)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11,$12,$13)
    on conflict (project_namespace, file_path, content_hash) do update
      set embedding = excluded.embedding, embedding_model = excluded.embedding_model,
          updated_at = now(), source_commit = excluded.source_commit
    returning id`,

  prune: `delete from code_rag.chunks where project_namespace = $1 and id <> all($2::uuid[])`,

  insertSymbols: `insert into code_rag.code_symbols (symbol, chunk_id, kind)
    select unnest($1::text[]), $2, $3 on conflict do nothing`,

  clearEdges: `delete from code_rag.code_edges where src_chunk = any($1::uuid[])`,

  insertEdges: `insert into code_rag.code_edges (src_chunk, dst_chunk, edge_type, weight)
    select * from unnest($1::uuid[], $2::uuid[], $3::text[], $4::real[]) on conflict do nothing`,

  search: `with scoped as materialized (
      select id, embedding, embedding_model from code_rag.chunks
      where project_namespace = $4 and embedding_model is not null
        and ($6::text is null or module in ($6, 'foundation'))
    ),
    vec as (
      select id, embedding <=> $1::vector as vdist from scoped
      where $1::vector is not null and embedding is not null and embedding_model = $5
      order by vdist, id limit 40
    ),
    fts as (
      select c.id, ts_rank_cd(c.content_tsv, q.terms) as frank
      from code_rag.chunks c join scoped s on s.id = c.id
      cross join websearch_to_tsquery('simple', $2) as q(terms)
      where c.content_tsv @@ q.terms order by frank desc, c.id limit 40
    ),
    sym as (
      select distinct x.chunk_id as id from code_rag.code_symbols x
      join scoped s on s.id = x.chunk_id
      where x.symbol = any($3::text[]) order by id limit 40
    ),
    req as (
      select c.id from code_rag.chunks c join scoped s on s.id = c.id
      where c.requirement_refs && $7::text[] order by c.id limit 40
    ),
    seeds as (select id from vec union select id from fts union select id from sym union select id from req),
    neighbors as (
      select e.dst_chunk as id, e.weight from code_rag.code_edges e join seeds s on s.id = e.src_chunk
      union all
      select e.src_chunk, e.weight from code_rag.code_edges e join seeds s on s.id = e.dst_chunk
    ),
    expanded as (
      select n.id from neighbors n join scoped s on s.id = n.id
      where n.id not in (select id from seeds)
      group by n.id order by max(n.weight) desc, count(*) desc, n.id limit 100
    ),
    universe as (select id from seeds union all select id from expanded)
    select c.id, c.file_path, c.layer, c.module, c.requirement_refs, c.invariant_tags, c.content,
           vec.vdist, fts.frank, (sym.id is not null) as symhit, (seeds.id is not null) as is_seed
    from scoped s join universe u on u.id = s.id
    join code_rag.chunks c on c.id = s.id
    left join vec on vec.id = c.id
    left join fts on fts.id = c.id
    left join sym on sym.id = c.id
    left join seeds on seeds.id = c.id`,
} as const;
