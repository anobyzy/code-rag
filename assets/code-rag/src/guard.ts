// Separation guard — the load-bearing anti-confusion mechanism.
// Two RAGs exist in nucleus_crm:
//   1. CODE RAG (this package)  -> schema code_rag, engineering index, no tenant data.
//   2. PRODUCT RAG             -> public.knowledge_chunks, RLS-per-org, runtime agent.
// This module makes mixing them a loud error instead of a silent leak.

import { ENV, ALLOWED_SQL_SCHEMAS, PRODUCT_TABLES } from "./constants.js";

export class RagSeparationError extends Error {
  constructor(message: string) {
    super(`[code-rag separation] ${message}`);
    this.name = "RagSeparationError";
  }
}

/** Resolve the engineering DSN and refuse to reuse the product database. */
export function resolveDsn(): string {
  const dsn = process.env[ENV.DSN];
  if (!dsn) {
    throw new RagSeparationError(
      `${ENV.DSN} is not set. Point it at an ENGINEERING database that holds NO tenant ` +
        `data. Do not reuse the product ${ENV.PRODUCT_DSN}.`,
    );
  }
  const productDsn = process.env[ENV.PRODUCT_DSN];
  const shared = productDsn && normalizeDsn(dsn) === normalizeDsn(productDsn);
  if (shared && process.env[ENV.ALLOW_SHARED_DB] !== "1") {
    throw new RagSeparationError(
      `${ENV.DSN} resolves to the same database as the product ${ENV.PRODUCT_DSN}. ` +
        `The code index must not live next to tenant data. Use a separate database, ` +
        `or set ${ENV.ALLOW_SHARED_DB}=1 to accept schema-only isolation in code_rag.`,
    );
  }
  return dsn;
}

function normalizeDsn(dsn: string): string {
  try {
    const u = new URL(dsn);
    return `${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return dsn.toLowerCase();
  }
}

const TABLE_REF = /\b(?:from|join|into|update|delete\s+from|insert\s+into|table)\s+("?[\w.]+"?)/gi;
const CTE_DEF = /\bwith\s+(\w+)\s+as|,\s*(\w+)\s+as\s*\(/gi;
// keywords that can follow a TABLE_REF trigger but are not tables (e.g. `do update set`)
const SQL_KEYWORDS = new Set(["set", "values", "select", "lateral"]);

/**
 * Positive enforcement: every table reference must be qualified to code_rag.* (or a
 * system schema, or a CTE). Anything else — especially a product table — throws.
 */
export function assertCodeRagSql(sql: string): void {
  const ctes = new Set<string>();
  for (const m of sql.matchAll(CTE_DEF)) {
    const name = (m[1] ?? m[2])?.toLowerCase();
    if (name) ctes.add(name);
  }

  for (const m of sql.matchAll(TABLE_REF)) {
    const raw = m[1].replace(/"/g, "").toLowerCase();
    const [a, b] = raw.split(".");
    const schema = b ? a : null;
    const table = b ?? a;

    if (!b && SQL_KEYWORDS.has(table)) continue;
    if (PRODUCT_TABLES.includes(table as (typeof PRODUCT_TABLES)[number])) {
      throw new RagSeparationError(
        `query references product table "${raw}". The code index must never touch ` +
          `tenant data. This is the code_rag engine, not the product knowledge_chunks RAG.`,
      );
    }
    if (schema) {
      if (!ALLOWED_SQL_SCHEMAS.includes(schema)) {
        throw new RagSeparationError(`query references disallowed schema "${schema}.${table}".`);
      }
      continue;
    }
    if (ctes.has(table)) continue;
    throw new RagSeparationError(
      `unqualified table "${table}". Qualify every table as code_rag.${table} so the ` +
        `code index can never accidentally resolve to a product table.`,
    );
  }
}
