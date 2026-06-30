import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCodeRagSql, resolveDsn, RagSeparationError } from "../src/guard.ts";
import { ENV } from "../src/constants.ts";

test("rejects product tables", () => {
  assert.throws(
    () => assertCodeRagSql("select * from knowledge_chunks where org_id = $1"),
    RagSeparationError,
  );
  assert.throws(() => assertCodeRagSql("select id from public.messages"), RagSeparationError);
});

test("rejects unqualified tables", () => {
  assert.throws(() => assertCodeRagSql("select * from chunks"), RagSeparationError);
});

test("accepts code_rag-qualified queries", () => {
  assert.doesNotThrow(() => assertCodeRagSql("select id from code_rag.chunks where module = $1"));
  assert.doesNotThrow(() =>
    assertCodeRagSql("insert into code_rag.code_symbols (symbol, chunk_id, kind) values ($1,$2,$3)"),
  );
});

test("accepts upsert with DO UPDATE SET (not a table ref)", () => {
  assert.doesNotThrow(() =>
    assertCodeRagSql(
      "insert into code_rag.chunks (file_path) values ($1) " +
        "on conflict (file_path) do update set updated_at = now() returning id",
    ),
  );
});

test("accepts CTE references", () => {
  assert.doesNotThrow(() =>
    assertCodeRagSql("with seeds as (select id from code_rag.chunks) select * from seeds"),
  );
});

test("resolveDsn refuses reusing the product DB", () => {
  const prev = { dsn: process.env[ENV.DSN], prod: process.env[ENV.PRODUCT_DSN], allow: process.env[ENV.ALLOW_SHARED_DB] };
  process.env[ENV.DSN] = "postgres://u:p@db:5432/app";
  process.env[ENV.PRODUCT_DSN] = "postgres://u:p@db:5432/app";
  delete process.env[ENV.ALLOW_SHARED_DB];
  assert.throws(() => resolveDsn(), RagSeparationError);
  process.env[ENV.ALLOW_SHARED_DB] = "1";
  assert.equal(resolveDsn(), "postgres://u:p@db:5432/app");
  process.env[ENV.DSN] = prev.dsn ?? "";
  if (prev.prod === undefined) delete process.env[ENV.PRODUCT_DSN]; else process.env[ENV.PRODUCT_DSN] = prev.prod;
  if (prev.allow === undefined) delete process.env[ENV.ALLOW_SHARED_DB]; else process.env[ENV.ALLOW_SHARED_DB] = prev.allow;
});
