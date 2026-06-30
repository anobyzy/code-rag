import pg from "pg";
import { resolveDsn, assertCodeRagSql } from "./guard.js";
import { CODE_RAG_SCHEMA } from "./constants.js";

const { Pool } = pg;

/**
 * The ONLY sanctioned handle to the code index. Pins search_path to code_rag and runs
 * every statement through the separation guard. Named CodeRagClient (never RagClient)
 * so an agent cannot import it by accident expecting the product RAG.
 */
export class CodeRagClient {
  private pool: pg.Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: resolveDsn(),
      options: `-c search_path=${CODE_RAG_SCHEMA}`,
    });
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    assertCodeRagSql(sql);
    return this.pool.query<T>(sql, params);
  }

  /** Raw escape for DDL/migrations only (CREATE SCHEMA/EXTENSION have no table refs). */
  async raw(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
