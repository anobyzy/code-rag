import { CodeRagClient } from "./client.js";
import { embed, toPgVector } from "./embed.js";
import {
  CODE_RAG_SCHEMA, CRITICAL_INVARIANTS, INVARIANT_HINTS, LAYER_ORDER, Module,
  PRODUCT_RAG_LABEL, REQUIREMENT_RE,
} from "./constants.js";

const BANNER =
  `=== CODEBASE RAG (engineering / ${CODE_RAG_SCHEMA}). NOT ${PRODUCT_RAG_LABEL}. ` +
  `Use this to write code for the repo. ===`;

type Row = {
  id: string;
  file_path: string;
  layer: string;
  module: string;
  symbols_defined: string[];
  requirement_refs: string[];
  invariant_tags: string[];
  content: string;
  content_hash: string;
  vdist: number | null;
  frank: number | null;
  symhit: number;
}

export interface QueryOpts {
  module?: Module;
  budgetTokens?: number;
}

export async function buildContextPrompt(task: string, opts: QueryOpts = {}): Promise<string> {
  const activeModule = opts.module ?? "foundation";
  const budget = opts.budgetTokens ?? 6000;
  const client = new CodeRagClient();
  try {
    const terms = extractTerms(task);
    const reqRefs = task.match(REQUIREMENT_RE) ?? [];
    const [vec] = await embed([task], "query");

    const { rows } = await client.query<Row>(
      `with vec as (
         select id, embedding <=> $1::vector as vdist
         from code_rag.chunks order by embedding <=> $1::vector limit 40
       ),
       fts as (
         select id, ts_rank_cd(content_tsv, websearch_to_tsquery('simple', $2)) as frank
         from code_rag.chunks
         where content_tsv @@ websearch_to_tsquery('simple', $2) limit 40
       ),
       sym as (
         select distinct chunk_id as id from code_rag.code_symbols
         where symbol = any($3)
       ),
       seeds as (
         select id from vec union select id from fts union select id from sym
       ),
       expanded as (
         select dst_chunk as id from code_rag.code_edges
         where src_chunk in (select id from seeds)
         union
         select src_chunk as id from code_rag.code_edges
         where dst_chunk in (select id from seeds)
       ),
       universe as (select id from seeds union select id from expanded)
       select c.id, c.file_path, c.layer, c.module, c.symbols_defined,
              c.requirement_refs, c.invariant_tags, c.content, c.content_hash,
              vec.vdist, fts.frank,
              (case when sym.id is not null then 1 else 0 end) as symhit
       from code_rag.chunks c
       join universe u on u.id = c.id
       left join vec on vec.id = c.id
       left join fts on fts.id = c.id
       left join sym on sym.id = c.id`,
      [toPgVector(vec), task, terms],
    );

    const seedIds = new Set(rows.filter((r) => r.vdist !== null || r.frank !== null || r.symhit).map((r) => r.id));
    const scored = rows
      .map((r) => ({ r, score: score(r, { activeModule, reqRefs, isSeed: seedIds.has(r.id) }) }))
      .sort((a, b) => b.score - a.score);

    const picked = budgetPick(scored.map((s) => s.r), budget);
    return assemble(task, activeModule, picked);
  } finally {
    await client.end();
  }
}

function extractTerms(task: string): string[] {
  const ids = task.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? [];
  const rfs = task.match(REQUIREMENT_RE) ?? [];
  return [...new Set([...ids, ...rfs])];
}

function score(r: Row, ctx: { activeModule: string; reqRefs: string[]; isSeed: boolean }): number {
  const sVec = r.vdist !== null ? 1 - r.vdist : 0;
  const sLex = (r.frank ?? 0) * 4 + r.symhit;
  const dDep = ctx.isSeed ? 0 : 1;
  const moduleMatch = r.module === ctx.activeModule || r.module === "foundation" ? 1 : -0.5;
  const reqOverlap = jaccard(r.requirement_refs, ctx.reqRefs);
  return (
    0.35 * sVec +
    0.3 * Math.min(sLex, 1) +
    0.15 * (1 / (1 + dDep)) +
    0.08 * layerPrior(r.layer) +
    0.06 * moduleMatch +
    0.04 * reqOverlap
  );
}

function layerPrior(layer: string): number {
  return ({ spec: 1, interface: 0.9, global: 0.6, implementation: 0.5, test: 0.4 } as Record<string, number>)[layer] ?? 0.5;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  return inter / (a.length + b.length - inter);
}

function budgetPick(rows: Row[], budget: number): Row[] {
  const seenHash = new Set<string>();
  const seenImplSym = new Set<string>();
  const out: Row[] = [];
  let used = 0;
  for (const r of rows) {
    if (seenHash.has(r.content_hash)) continue;
    if (r.layer === "implementation" && r.symbols_defined.some((s) => seenImplSym.has(s))) continue;
    const cost = Math.ceil(r.content.length / 4);
    const critical = r.invariant_tags.some((t) => CRITICAL_INVARIANTS.includes(t));
    if (used + cost > budget && !critical) continue;
    out.push(r);
    used += Math.min(cost, budget);
    seenHash.add(r.content_hash);
    if (r.layer === "implementation") r.symbols_defined.forEach((s) => seenImplSym.add(s));
  }
  return out;
}

function assemble(task: string, module: string, rows: Row[]): string {
  const parts: string[] = [BANNER, `task: ${task}`, `module: ${module}`, ""];
  const invariants = new Set<string>();
  for (const layer of LAYER_ORDER) {
    const inLayer = rows.filter((r) => r.layer === layer);
    if (inLayer.length === 0) continue;
    parts.push(`## ${layer}`);
    for (const r of inLayer) {
      r.invariant_tags.forEach((t) => invariants.add(t));
      parts.push(`// ${r.file_path}${r.requirement_refs.length ? ` [${r.requirement_refs.join(",")}]` : ""}`);
      parts.push(r.content, "");
    }
  }
  if (invariants.size) {
    parts.push("## invariants to respect");
    for (const t of invariants) parts.push(`- ${t}: ${INVARIANT_HINTS[t] ?? t}`);
  }
  return parts.join("\n");
}
