// ── PER-PROJECT CONFIG ──────────────────────────────────────────────────────────
// Edit this block when bootstrapping a new project. The rest of the package is generic.

/** Unique id for THIS codebase. Stamped on every chunk and required on every query. */
export const PROJECT_NAMESPACE = "my_project"; // <-- CHANGE ME

/**
 * Product / runtime tables this code index must NEVER read or write. This is the core of
 * the two-RAG separation: if your app has a runtime RAG (e.g. a `knowledge_chunks` table)
 * or any tenant/PII tables, LIST THEM HERE so the guard blocks them with an explicit error.
 * The client rejects a database if any of these names appear inside the code_rag schema.
 */
export const PRODUCT_TABLES: readonly string[] = [
  // "knowledge_chunks", "users", "messages",
];

/** Domain modules used to scope retrieval. `foundation` = shared code pulled with any module. */
export const MODULES = ["foundation", "api", "web", "worker", "shared"] as const;

/** Optional directory names that belong to a listed module. */
export const MODULE_PATH_ALIASES: Partial<Record<string, readonly string[]>> = {};

/** One-line label of your PRODUCT RAG, shown in the query banner so agents don't confuse them. */
export const PRODUCT_RAG_LABEL = "the product/runtime RAG (application/tenant data)";

/** Optional invariants to tag + surface. tag = canonical name, re = how to detect it in text. */
export const INVARIANT_PATTERNS: { tag: string; re: RegExp }[] = [
  // { tag: "tenant", re: /\btenant_id\b|\borg_id\b/i },
  // { tag: "rls", re: /\bRLS\b|row[- ]level security/i },
];

/** Optional short reminder per invariant tag, appended to the assembled prompt. */
export const INVARIANT_HINTS: Record<string, string> = {
  // tenant: "propagate the tenant id end to end",
};

/** Invariants whose chunks get priority within the token budget. */
export const CRITICAL_INVARIANTS: readonly string[] = [
  // "tenant", "rls",
];

/** Requirement-id convention extracted from specs and used for traceability edges. */
export const REQUIREMENT_RE = /\bRF-\d{2}\b/g; // e.g. RF-01 .. RF-99; change to your scheme

// ── GENERIC (rarely changed) ─────────────────────────────────────────────────────
export const CODE_RAG_SCHEMA = "code_rag";
export const EMBED_DIM = 1024; // voyage-code-3 default

export const ENV = {
  /** DSN of the ENGINEERING database that holds the code index. Never the product DB. */
  DSN: "CODE_RAG_DATABASE_URL",
  /** Product DSN — only read to assert it is NOT reused for the code index. */
  PRODUCT_DSN: "DATABASE_URL",
  EMBEDDING_PROVIDER: "CODE_RAG_EMBEDDING_PROVIDER",
  VOYAGE_API_KEY: "VOYAGE_API_KEY",
} as const;


export type Module = (typeof MODULES)[number];

export const LAYERS = ["spec", "global", "interface", "implementation", "test"] as const;
export type Layer = (typeof LAYERS)[number];

/** Layer ordering used when assembling the context prompt. */
export const LAYER_ORDER: Layer[] = ["spec", "interface", "global", "implementation", "test"];
