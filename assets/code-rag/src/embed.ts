import { createHash } from "node:crypto";
import { EMBED_DIM, ENV } from "./constants.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-code-3";
const MAX_BATCH = 32; // inputs per request
const MAX_BATCH_CHARS = 24000; // ~6K tokens/request — safe under the free-tier 10K TPM cap
const MAX_RETRIES = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type EmbedKind = "document" | "query";

export function getEmbedder(): { model: string; embed: (texts: string[], kind: EmbedKind) => Promise<number[][]> } {
  const provider = process.env[ENV.EMBEDDING_PROVIDER] ?? "offline";
  if (provider === "offline") {
    return { model: "offline-hash-v1", embed: async (texts) => texts.map(fallbackEmbed) };
  }
  if (provider !== "voyage") throw new Error(`${ENV.EMBEDDING_PROVIDER} must be offline or voyage.`);
  const key = process.env[ENV.VOYAGE_API_KEY];
  if (!key) throw new Error(`${ENV.VOYAGE_API_KEY} is required when Voyage is explicitly enabled.`);
  return { model: VOYAGE_MODEL, embed: (texts, kind) => voyageEmbed(texts, kind, key) };
}

async function voyageEmbed(texts: string[], kind: EmbedKind, key: string): Promise<number[][]> {
  const out: number[][] = [];
  let batch: string[] = [];
  let chars = 0;
  const flush = async () => {
    if (batch.length) out.push(...(await voyageBatch(batch, kind, key)));
    batch = [];
    chars = 0;
  };
  for (const t of texts) {
    if (batch.length >= MAX_BATCH || (batch.length && chars + t.length > MAX_BATCH_CHARS)) await flush();
    batch.push(t);
    chars += t.length;
  }
  await flush();
  return out;
}

async function voyageBatch(input: string[], kind: EmbedKind, key: string): Promise<number[][]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(VOYAGE_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ input, model: VOYAGE_MODEL, input_type: kind, output_dimension: EMBED_DIM }),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get("retry-after");
      const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 2 ** attempt * 3;
      await res.body?.cancel();
      const wait = Math.min(30, seconds) * 1000;
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Voyage embeddings request failed with HTTP ${res.status}.`);
    }
    const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    if (!Array.isArray(json?.data) || json.data.length !== input.length) {
      throw new Error("Voyage returned an unexpected number of embeddings.");
    }
    return json.data.sort((a, b) => a?.index - b?.index).map((entry, index) => {
      if (entry?.index !== index || !Array.isArray(entry.embedding) || entry.embedding.length !== EMBED_DIM ||
          !entry.embedding.every(Number.isFinite) || !entry.embedding.some((value) => value !== 0)) {
        throw new Error("Voyage returned an invalid embedding.");
      }
      return entry.embedding;
    });
  }
}

/** Hashed bag-of-tokens projected into EMBED_DIM, L2-normalized. Deterministic, offline. */
function fallbackEmbed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (const tok of text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) {
    const h = createHash("md5").update(tok).digest();
    const idx = h.readUInt32LE(0) % EMBED_DIM;
    v[idx] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function toPgVector(v: number[]): string | null {
  return v.some((value) => value !== 0) ? `[${v.join(",")}]` : null;
}
