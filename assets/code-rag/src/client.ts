import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertCodeRagSql, RagSeparationError, resolveDsn } from "./guard.js";
import { PRODUCT_TABLES, PROJECT_NAMESPACE } from "./constants.js";

const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface CodeRagConnection {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

export class CodeRagClient implements CodeRagConnection {
  readonly #pool = new pg.Pool({
    connectionString: resolveDsn(),
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    lock_timeout: 15000,
  });

  async query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    assertCodeRagSql(sql);
    return this.#withConnection((connection) => connection.query<T>(sql, params));
  }

  async write<T>(work: (connection: CodeRagConnection) => Promise<T>): Promise<T> {
    return this.#transaction(async (connection) => {
      await connection.query("select pg_catalog.pg_advisory_xact_lock_shared(1129464135, 0)");
      await connection.query("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 1129464135))", [PROJECT_NAMESPACE]);
      return work({
        query(sql, params = []) {
          assertCodeRagSql(sql);
          return connection.query(sql, params);
        },
      });
    });
  }

  /** Only packaged migration files can execute as DDL. */
  async migrate(): Promise<void> {
    await this.#transaction(async (connection) => {
      await connection.query("select pg_catalog.pg_advisory_xact_lock(1129464135, 0)");
      for (const file of readdirSync(migrationDirectory).filter((file) => /^\d+_[\w]+\.sql$/.test(file)).sort()) {
        process.stderr.write(`applying ${file}\n`);
        await connection.query(readFileSync(path.join(migrationDirectory, file), "utf8"));
      }
    });
  }

  async end(): Promise<void> {
    await this.#pool.end();
  }

  async #withConnection<T>(work: (connection: pg.PoolClient) => Promise<T>): Promise<T> {
    const connection = await this.#pool.connect();
    try {
      await connection.query("set search_path = pg_catalog, code_rag, public");
      const check = await connection.query(
        `select 1 from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'p', 'v', 'm', 'f')
           and n.nspname not in ('pg_catalog', 'information_schema')
           and n.nspname not like 'pg_toast%'
           and (n.nspname <> 'code_rag' or lower(c.relname) = any($1::text[]))
         limit 1`,
        [PRODUCT_TABLES.map((name) => name.toLowerCase())],
      );
      if (check.rows.length) {
        throw new RagSeparationError("The target database contains relations outside the engineering index or a configured product table.");
      }
      return await work(connection);
    } finally {
      connection.release();
    }
  }

  async #transaction<T>(work: (connection: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.#withConnection(async (connection) => {
      await connection.query("begin");
      try {
        const result = await work(connection);
        await connection.query("commit");
        return result;
      } catch (error) {
        await connection.query("rollback");
        throw error;
      }
    });
  }
}
