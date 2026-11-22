import { ENV } from "./constants.js";
import { SQL } from "./statements.js";

export class RagSeparationError extends Error {
  constructor(message: string) {
    super(`[code-rag separation] ${message}`);
    this.name = "RagSeparationError";
  }
}

const connectionOptions = new Set(["sslmode", "application_name", "channel_binding"]);
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function databaseAddress(url: URL, product = false): string {
  const host = (product ? url.searchParams.get("host") ?? url.hostname : url.hostname)
    .toLowerCase().replace(/\.$/, "");
  const port = (product ? url.searchParams.get("port") ?? url.port : url.port) || "5432";
  const name = (product && (url.searchParams.get("database") ?? url.searchParams.get("dbname")))
    || decodeURIComponent(url.pathname.slice(1) || url.username);
  return JSON.stringify([loopbackHosts.has(host) ? "loopback" : host, Number(port), name]);
}

export function resolveDsn(): string {
  const dsn = process.env[ENV.DSN];
  if (!dsn) throw new RagSeparationError(`${ENV.DSN} must point to a dedicated engineering database.`);

  let engineering: URL;
  let address: string;
  try {
    engineering = new URL(dsn);
    if (!/^postgres(?:ql)?:$/.test(engineering.protocol) || !engineering.hostname ||
        engineering.pathname.length < 2 || engineering.hash ||
        [...engineering.searchParams.keys()].some((key) => !connectionOptions.has(key))) {
      throw new Error("unsupported connection URL");
    }
    if (engineering.password === "REPLACE_WITH_RANDOM_HEX") {
      throw new RagSeparationError("Replace the example database password before connecting.");
    }
    address = databaseAddress(engineering);
  } catch (error) {
    if (error instanceof RagSeparationError) throw error;
    throw new RagSeparationError(`${ENV.DSN} must specify an explicit PostgreSQL host and database. Supported options: sslmode, application_name and channel_binding.`);
  }

  const productDsn = process.env[ENV.PRODUCT_DSN];
  if (productDsn) {
    let productAddress: string | undefined;
    try {
      const product = new URL(productDsn);
      if (/^postgres(?:ql)?:$/.test(product.protocol)) productAddress = databaseAddress(product, true);
    } catch {
      if (/^postgres/i.test(productDsn)) {
        throw new RagSeparationError(`${ENV.PRODUCT_DSN} could not be compared to the engineering database.`);
      }
    }
    if (address === productAddress) {
      throw new RagSeparationError(`${ENV.DSN} and ${ENV.PRODUCT_DSN} refer to the same database. Use a dedicated engineering database.`);
    }
  }
  return dsn;
}

const statements = new Set<string>(Object.values(SQL));

/** The code index accepts its own fixed, parameterized queries only. */
export function assertCodeRagSql(sql: string): void {
  if (!statements.has(sql)) throw new RagSeparationError("SQL is outside the code index's supported operations.");
}
