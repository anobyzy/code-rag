import { createHash } from "node:crypto";
import path from "node:path";
import { CodeRagClient, CodeRagConnection } from "./client.js";
import { getEmbedder, toPgVector } from "./embed.js";
import { Chunk } from "./partition.js";
import { PROJECT_NAMESPACE } from "./constants.js";
import { openWorktree } from "./source.js";
import { SQL } from "./statements.js";

type IndexedChunk = { chunk: Chunk; hash: string; id: string; model: string | null };
type Edge = { source: string; target: string; type: "import" | "satisfies_req"; weight: number };

export interface IngestResult {
  total: number;
  embedded: number;
  pruned: number;
}

export async function ingest(root: string, sourceCommit?: string, forceEmbed = false): Promise<IngestResult> {
  const embedder = getEmbedder();
  const client = new CodeRagClient();
  try {
    return await client.write(async (connection) => {
      const worktree = openWorktree(root);
      const { rows: [owner] } = await connection.query<{ worktree_id: string }>(SQL.readOwner, [PROJECT_NAMESPACE]);
      if (owner && owner.worktree_id !== worktree.id) {
        throw new Error("This namespace is indexed by another Git worktree. Configure a unique namespace for this checkout.");
      }
      if (!owner) await connection.query(SQL.registerOwner, [PROJECT_NAMESPACE, worktree.id]);

      const snapshot = new Map<string, IndexedChunk>();
      for (const chunk of worktree.readChunks()) {
        // Metadata is part of index identity so config and partitioner edits take effect.
        const hash = `sha256:${createHash("sha256").update(JSON.stringify(chunk)).digest("hex")}`;
        snapshot.set(hash, { chunk, hash, id: "", model: null });
      }

      const existing = await connection.query<{ content_hash: string; id: string; embedding_model: string | null }>(
        SQL.existing, [PROJECT_NAMESPACE],
      );
      for (const row of existing.rows) {
        const entry = snapshot.get(row.content_hash);
        if (entry) {
          entry.id = row.id;
          entry.model = row.embedding_model;
        }
      }

      const entries = [...snapshot.values()];
      const topologyChanged = entries.some((entry) => !entry.id) || entries.length !== existing.rows.length;
      const pending = entries.filter((entry) => forceEmbed || entry.model !== embedder.model);
      const vectors = await embedder.embed(pending.map(({ chunk }) => chunk.content), "document");

      for (const [index, entry] of pending.entries()) {
        const { chunk, hash } = entry;
        const { rows } = await connection.query<{ id: string }>(SQL.upsert, [
          PROJECT_NAMESPACE, chunk.file_path, chunk.layer, chunk.module, chunk.symbols_defined,
          chunk.dependencies_imported, chunk.requirement_refs, chunk.invariant_tags, chunk.content,
          toPgVector(vectors[index]), hash, sourceCommit ?? null, embedder.model,
        ]);
        if (!entry.id && chunk.symbols_defined.length) {
          await connection.query(SQL.insertSymbols, [chunk.symbols_defined, rows[0].id, chunk.layer]);
        }
        entry.id = rows[0].id;
      }

      let pruned = 0;
      if (topologyChanged) {
        const ids = entries.map(({ id }) => id);
        pruned = (await connection.query(SQL.prune, [PROJECT_NAMESPACE, ids])).rowCount ?? 0;
        await connection.query(SQL.clearEdges, [ids]);
        await insertEdges(connection, entries);
      }
      return { total: entries.length, embedded: pending.length, pruned };
    });
  } finally {
    await client.end();
  }
}

export async function reembed(root: string): Promise<number> {
  // Reapply current source-selection rules. A legacy database may contain unsafe files.
  return (await ingest(root, undefined, true)).embedded;
}

async function insertEdges(connection: CodeRagConnection, entries: IndexedChunk[]): Promise<void> {
  const byFile = new Map<string, string[]>();
  const specsByRequirement = new Map<string, string[]>();
  for (const { chunk, id } of entries) {
    appendId(byFile, chunk.file_path, id);
    if (chunk.layer === "spec") {
      for (const requirement of chunk.requirement_refs) appendId(specsByRequirement, requirement, id);
    }
  }

  let batch: Edge[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await connection.query(SQL.insertEdges, [
      batch.map((edge) => edge.source), batch.map((edge) => edge.target),
      batch.map((edge) => edge.type), batch.map((edge) => edge.weight),
    ]);
    batch = [];
  };
  for (const { chunk, id } of entries) {
    for (const dependency of chunk.dependencies_imported) {
      const resolved = resolveImport(chunk.file_path, dependency, byFile);
      for (const target of byFile.get(resolved ?? "") ?? []) {
        if (id !== target) batch.push({ source: id, target, type: "import", weight: 1 });
      }
      if (batch.length >= 1000) await flush();
    }
    if (chunk.layer === "spec") continue;
    for (const requirement of chunk.requirement_refs) {
      for (const target of specsByRequirement.get(requirement) ?? []) {
        batch.push({ source: id, target, type: "satisfies_req", weight: 2 });
      }
      if (batch.length >= 1000) await flush();
    }
  }
  await flush();
}

function appendId(index: Map<string, string[]>, key: string, id: string): void {
  const ids = index.get(key);
  if (ids) ids.push(id);
  else index.set(key, [id]);
}

const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const jsToSourceExtensions: Record<string, string[]> = {
  ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"],
};

function resolveImport(file: string, dependency: string, byFile: Map<string, string[]>): string | undefined {
  const relative = dependency.startsWith("./") || dependency.startsWith("../");
  const target = relative ? path.posix.join(path.posix.dirname(file), dependency) : dependency;
  if (byFile.has(target)) return target;
  if (!relative) return undefined;
  const extension = path.posix.extname(target);
  const alternatives = jsToSourceExtensions[extension];
  if (alternatives) {
    const stem = target.slice(0, -extension.length);
    return alternatives.map((suffix) => stem + suffix).find((candidate) => byFile.has(candidate));
  }
  return [target, `${target}/index`]
    .flatMap((stem) => sourceExtensions.map((suffix) => stem + suffix))
    .find((candidate) => byFile.has(candidate));
}
