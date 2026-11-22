import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCodeRagSql, resolveDsn, RagSeparationError } from "../src/guard.ts";
import { ENV } from "../src/constants.ts";
import { SQL } from "../src/statements.ts";

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

test("accepts only the parameterized index operations", () => {
  for (const sql of Object.values(SQL)) assert.doesNotThrow(() => assertCodeRagSql(sql));
  assert.throws(() => assertCodeRagSql("select id from code_rag.chunks"), RagSeparationError);
});

test("rejects connection parameters that could override the engineering target", () => {
  process.env[ENV.DSN] = "postgresql://u@localhost/code_rag?database=app";
  try {
    assert.throws(() => resolveDsn(), RagSeparationError);
  } finally {
    delete process.env[ENV.DSN];
  }
});

test("resolveDsn refuses reusing the product DB despite URL spelling and legacy override", () => {
  process.env[ENV.DSN] = "postgres://engineering@localhost/%61pp";
  process.env[ENV.PRODUCT_DSN] = "postgresql://product@127.0.0.1:5432/app";
  process.env.CODE_RAG_ALLOW_SHARED_DB = "1";
  try {
    assert.throws(() => resolveDsn(), RagSeparationError);
  } finally {
    delete process.env[ENV.DSN];
    delete process.env[ENV.PRODUCT_DSN];
    delete process.env.CODE_RAG_ALLOW_SHARED_DB;
  }
});
