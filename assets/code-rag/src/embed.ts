import { createHash } from "node:crypto";
import { EMBED_DIM, ENV } from "./constants.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-code-3";
const MAX_BATCH = 32; // inputs per request
const MAX_BATCH_CHARS = 24000; // ~6K tokens/request — safe under the free-tier 10K TPM cap
const MAX_TEXT_CHARS = 32000; // truncate a single oversized chunk (embedding input only)
const MAX_RETRIES = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type EmbedKind = "document" | "query";

/**
 * Embed code/text. Uses Voyage voyage-code-3 (code-specialized; recommended pairing for
 * Anthropic stacks) when VOYAGE_API_KEY is set, else a deterministic offline fallback so
 * ingest/query stay runnable and testable without network. The fallback is NON-semantic.
 */
export async function embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
  if (texts.length === 0) return [];
  const key = process.env[ENV.VOYAGE_API_KEY];
  if (!key) return texts.map(fallbackEmbed);

  const capped = texts.map((t) => (t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) : t));
  const out: number[][] = [];
  let batch: string[] = [];
  let chars = 0;
  const flush = async () => {
    if (batch.length) out.push(...(await voyageBatch(batch, kind, key)));
    batch = [];
    chars = 0;
  };
  for (const t of capped) {
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
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ input, model: VOYAGE_MODEL, input_type: kind, output_dimension: EMBED_DIM }),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const wait = (Number(res.headers.get("retry-after")) || Math.min(30, 2 ** attempt * 3)) * 1000;
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`voyage embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
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

export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
