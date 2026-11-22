import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";
import { CodeRagClient } from "../src/client.ts";
import { ENV, PROJECT_NAMESPACE } from "../src/constants.ts";
import { RagSeparationError } from "../src/guard.ts";
import { ingest, reembed } from "../src/ingest.ts";
import { buildContextPrompt } from "../src/query.ts";
import { SQL } from "../src/statements.ts";

test("preserves namespace, eligibility and atomicity across the full PostgreSQL workflow", async (t) => {
  const url = process.env.CODE_RAG_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname === "/code_rag_test", "Set CODE_RAG_TEST_DATABASE_URL to a fresh disposable code_rag_test database.");
  process.env[ENV.DSN] = url;
  process.env[ENV.EMBEDDING_PROVIDER] = "offline";
  delete process.env[ENV.PRODUCT_DSN];
  delete process.env[ENV.VOYAGE_API_KEY];
  const db = new pg.Pool({ connectionString: url });
  const client = new CodeRagClient();
  const root = mkdtempSync(path.join(os.tmpdir(), "code-rag-db-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  const write = (file: string, content: string) => writeFileSync(path.join(root, file), content);

  try {
    assert.equal((await db.query("select to_regnamespace('code_rag') as schema")).rows[0].schema, null);
    await db.query("create table public.product_fixture (id int)");
    await assert.rejects(client.migrate(), RagSeparationError);
    assert.equal((await db.query("select to_regnamespace('code_rag') as schema")).rows[0].schema, null);
    await db.query("drop table public.product_fixture");
    await db.query("set search_path = public, code_rag; " +
      readFileSync(new URL("../migrations/0001_code_rag.sql", import.meta.url), "utf8"));
    await db.query(`insert into code_rag.chunks
      (project_namespace, file_path, layer, module, content, content_hash)
      values ($1, 'untracked.md', 'spec', 'foundation', 'legacySensitiveFixture', 'legacy')`, [PROJECT_NAMESPACE]);
    await client.migrate();
    await client.migrate();
    await assert.rejects(client.query("select * from public.product_fixture"), RagSeparationError);
    assert.doesNotMatch(await buildContextPrompt("legacySensitiveFixture"), /untracked\.md/);

    git("init");
    for (const dir of ["api", "web"]) mkdirSync(path.join(root, dir));
    write("api/index.ts", "import { apiDetail } from './detail.js';\nexport function searchNeedle() { return apiDetail(); }\n");
    write("api/detail.ts", "export function apiDetail() { return 'dependencyEvidence'; }\n");
    write("web/detail.ts", "export function searchNeedle() { return 'otherModuleEvidence'; }\n");
    write("local.ts", "export function searchNeedle() { return 'untrackedEvidence'; }\n");
    git("add", "api", "web");

    const { rows: [foreign] } = await db.query(`insert into code_rag.chunks
      (project_namespace, file_path, layer, module, content, content_hash)
      values ('foreign-project', 'foreign.ts', 'implementation', 'foundation', 'searchNeedle otherNamespaceEvidence', 'foreign') returning id`);
    const first = await Promise.all([ingest(root), ingest(root)]);
    assert.deepEqual(first.map(({ embedded }) => embedded).sort(), [0, 3]);
    assert.deepEqual(first.map(({ pruned }) => pruned).sort(), [0, 1]);
    const wrongRoot = path.join(root, "wrong-worktree");
    mkdirSync(wrongRoot);
    execFileSync("git", ["-C", wrongRoot, "init"], { stdio: "pipe" });
    await assert.rejects(ingest(wrongRoot), /another Git worktree/);
    const { rows: [local] } = await db.query("select id from code_rag.chunks where project_namespace = $1 and file_path = 'api/index.ts'", [PROJECT_NAMESPACE]);
    await db.query(`update code_rag.chunks foreign_chunk set embedding_model = local_chunk.embedding_model,
      embedding = local_chunk.embedding from code_rag.chunks local_chunk
      where foreign_chunk.id = $1 and local_chunk.id = $2`, [foreign.id, local.id]);
    await db.query("insert into code_rag.code_edges values ($1, $2, 'import', 100)", [local.id, foreign.id]);
    await db.query("insert into code_rag.code_symbols values ('searchNeedle', $1, 'implementation')", [foreign.id]);
    const query = await buildContextPrompt("searchNeedle", { module: "api" });
    assert.match(query, /dependencyEvidence/);
    assert.match(query, /untrusted repository data/);
    assert.doesNotMatch(query, /otherNamespaceEvidence|otherModuleEvidence|untrackedEvidence/);
    assert.match(await buildContextPrompt("searchNeedle"), /otherModuleEvidence/);
    const fixtureVector = Array.from({ length: 1024 }, (_, index) => Number(index === 0));
    const mockFetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
      const { input } = JSON.parse(String(options?.body)) as { input: string[] };
      return Response.json({ data: input.map((_, index) => ({ index, embedding: fixtureVector })) });
    });
    process.env[ENV.VOYAGE_API_KEY] = "unused-test-key";
    process.env[ENV.EMBEDDING_PROVIDER] = "voyage";
    assert.doesNotMatch(await buildContextPrompt("zzzxq"), /api\/index\.ts/);
    assert.deepEqual(await ingest(root), { total: 3, embedded: 3, pruned: 0 });
    assert.match(await buildContextPrompt("zzzxq"), /api\/index\.ts/);
    assert.equal(mockFetch.mock.callCount(), 3);
    process.env[ENV.EMBEDDING_PROVIDER] = "offline";
    delete process.env[ENV.VOYAGE_API_KEY];
    assert.doesNotMatch(await buildContextPrompt("zzzxq"), /api\/index\.ts/);
    assert.deepEqual(await ingest(root), { total: 3, embedded: 3, pruned: 0 });
    const limited = await buildContextPrompt("searchNeedle", { budgetTokens: 80 });
    assert.ok(Buffer.byteLength(limited) <= 320);
    assert.equal((await db.query(`select count(*)::int as count from code_rag.code_edges e
      join code_rag.chunks c on c.id = e.dst_chunk where e.src_chunk = $1 and c.file_path = 'api/detail.ts'`, [local.id])).rows[0].count, 1);

    write("api/index.ts", "export function updatedSearchNeedle() {}\n");
    await db.query(`create function code_rag.fail_prune_fixture() returns trigger language plpgsql as $$
      begin raise exception 'fixture failure'; end $$;
      create trigger fail_prune_fixture before delete on code_rag.chunks for each row execute function code_rag.fail_prune_fixture()`);
    await assert.rejects(ingest(root), /fixture failure/);
    assert.equal((await client.query(SQL.existing, [PROJECT_NAMESPACE])).rows.length, 3);
    assert.match(await buildContextPrompt("searchNeedle", { module: "api" }), /export function searchNeedle/);
    await db.query("drop trigger fail_prune_fixture on code_rag.chunks");

    renameSync(path.join(root, "api/detail.ts"), path.join(root, "api/renamed.ts"));
    git("add", "-A", "api");
    const refreshed = await ingest(root);
    assert.deepEqual(refreshed, { total: 3, embedded: 2, pruned: 2 });
    assert.equal(await reembed(root), 3);
    assert.equal((await client.query(SQL.existing, [PROJECT_NAMESPACE])).rows.some((row) => row.file_path === "api/detail.ts"), false);
    git("rm", "-rf", "api", "web");
    assert.deepEqual(await ingest(root), { total: 0, embedded: 0, pruned: 3 });
    assert.equal((await client.query(SQL.existing, ["foreign-project"])).rows.length, 1);
  } finally {
    await client.end();
    await db.end();
    rmSync(root, { recursive: true, force: true });
  }
});
