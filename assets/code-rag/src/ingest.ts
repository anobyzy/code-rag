import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { CodeRagClient } from "./client.js";
import { embed, toPgVector } from "./embed.js";
import { partitionFile, Chunk } from "./partition.js";
import { PROJECT_NAMESPACE } from "./constants.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "__MACOSX"]);
const TEXT_EXT = new Set([".md", ".sql", ".ts", ".tsx", ".js", ".json"]);
const NUL = String.fromCharCode(0);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase()) || entry.name.startsWith(".env")) {
      yield full;
    }
  }
}

const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Postgres `text` rejects NUL (0x00); strip it (e.g. files saved as UTF-16). */
const sanitize = (s: string) => s.split(NUL).join("");

type Hashed = { c: Chunk; hash: string; key: string };

export interface IngestResult {
  total: number;
  embedded: number;
  pruned: number;
}

/**
 * Incremental: embeds only new/changed chunks (by content_hash), prunes stale chunks of
 * seen files, and rebuilds outgoing edges of current chunks. A run with no code change
 * does no embedding and no writes — cheap enough to call on every agent turn / commit.
 */
export async function ingest(root: string, sourceCommit?: string): Promise<IngestResult> {
  const client = new CodeRagClient();
  try {
    const chunks: Chunk[] = [];
    const seenFiles = new Set<string>();
    for (const file of walk(root)) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      const fileChunks = partitionFile(rel, sanitize(readFileSync(file, "utf8")));
      for (const c of fileChunks) seenFiles.add(c.file_path);
      chunks.push(...fileChunks);
    }

    const existing = await client.query<{ file_path: string; content_hash: string; id: string }>(
      `select file_path, content_hash, id from code_rag.chunks where project_namespace = $1`,
      [PROJECT_NAMESPACE],
    );
    const idByKey = new Map<string, string>();
    for (const r of existing.rows) idByKey.set(`${r.file_path} ${r.content_hash}`, r.id);

    const hashed: Hashed[] = chunks.map((c) => {
      const hash = sha(c.content);
      return { c, hash, key: `${c.file_path} ${hash}` };
    });
    const currentKeys = new Set(hashed.map((h) => h.key));
    const toEmbed = hashed.filter((h) => !idByKey.has(h.key));

    const vectors = toEmbed.length ? await embed(toEmbed.map((h) => h.c.content), "document") : [];
    for (let i = 0; i < toEmbed.length; i++) {
      const { c, hash, key } = toEmbed[i];
      const { rows } = await client.query<{ id: string }>(
        `insert into code_rag.chunks
           (project_namespace, file_path, layer, module, symbols_defined,
            dependencies_imported, requirement_refs, invariant_tags, content,
            embedding, content_hash, source_commit)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11,$12)
         on conflict (project_namespace, file_path, content_hash)
           do update set updated_at = now(), source_commit = excluded.source_commit
         returning id`,
        [
          PROJECT_NAMESPACE, c.file_path, c.layer, c.module, c.symbols_defined,
          c.dependencies_imported, c.requirement_refs, c.invariant_tags, c.content,
          toPgVector(vectors[i]), hash, sourceCommit ?? null,
        ],
      );
      idByKey.set(key, rows[0].id);
      for (const sym of c.symbols_defined) {
        await client.query(
          `insert into code_rag.code_symbols (symbol, chunk_id, kind)
           values ($1,$2,$3) on conflict do nothing`,
          [sym, idByKey.get(key), c.layer],
        );
      }
    }

    let pruned = 0;
    if (seenFiles.size) {
      const del = await client.query(
        `delete from code_rag.chunks
         where project_namespace = $1 and file_path = any($2)
           and (file_path || ' ' || content_hash) <> all($3)`,
        [PROJECT_NAMESPACE, [...seenFiles], [...currentKeys]],
      );
      pruned = del.rowCount ?? 0;
    }

    if (toEmbed.length || pruned) await rebuildEdges(client, hashed, idByKey);
    return { total: chunks.length, embedded: toEmbed.length, pruned };
  } finally {
    await client.end();
  }
}

async function rebuildEdges(
  client: CodeRagClient,
  hashed: Hashed[],
  idByKey: Map<string, string>,
): Promise<void> {
  const currentIds = hashed.map((h) => idByKey.get(h.key)).filter((x): x is string => !!x);
  if (currentIds.length === 0) return;
  await client.query(`delete from code_rag.code_edges where src_chunk = any($1)`, [currentIds]);

  const idsByFile = new Map<string, string[]>();
  const reqDefiners = new Map<string, string[]>(); // RF-XX -> spec chunk ids
  for (const h of hashed) {
    const id = idByKey.get(h.key);
    if (!id) continue;
    (idsByFile.get(h.c.file_path) ?? idsByFile.set(h.c.file_path, []).get(h.c.file_path)!).push(id);
    if (h.c.layer === "spec") {
      for (const rf of h.c.requirement_refs) {
        (reqDefiners.get(rf) ?? reqDefiners.set(rf, []).get(rf)!).push(id);
      }
    }
  }

  for (const h of hashed) {
    const srcId = idByKey.get(h.key);
    if (!srcId) continue;
    for (const dep of h.c.dependencies_imported) {
      const norm = dep.replace(/^[./]+/, "");
      if (!norm) continue;
      for (const [file, ids] of idsByFile) {
        if (file.endsWith(norm)) for (const dst of ids) await edge(client, srcId, dst, "import");
      }
    }
    if (h.c.layer !== "spec") {
      for (const rf of h.c.requirement_refs) {
        for (const dst of reqDefiners.get(rf) ?? []) await edge(client, srcId, dst, "satisfies_req", 2.0);
      }
    }
  }
}

/**
 * Regenerate embeddings for ALL chunks with the current embedder. Run once after switching
 * provider (e.g. fallback -> Voyage): content_hash is unchanged so plain ingest would skip them.
 */
export async function reembed(): Promise<number> {
  const client = new CodeRagClient();
  try {
    const { rows } = await client.query<{ id: string; content: string }>(
      `select id, content from code_rag.chunks where project_namespace = $1 order by id`,
      [PROJECT_NAMESPACE],
    );
    if (rows.length === 0) return 0;
    const vectors = await embed(rows.map((r) => r.content), "document");
    for (let i = 0; i < rows.length; i++) {
      await client.query(
        `update code_rag.chunks set embedding = $1::vector, updated_at = now() where id = $2`,
        [toPgVector(vectors[i]), rows[i].id],
      );
    }
    return rows.length;
  } finally {
    await client.end();
  }
}

async function edge(client: CodeRagClient, src: string, dst: string, type: string, weight = 1.0): Promise<void> {
  if (src === dst) return;
  await client.query(
    `insert into code_rag.code_edges (src_chunk, dst_chunk, edge_type, weight)
     values ($1,$2,$3,$4) on conflict do nothing`,
    [src, dst, type, weight],
  );
}
