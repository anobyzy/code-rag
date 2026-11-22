import assert from "node:assert/strict";
import { test } from "node:test";
import { ENV } from "../src/constants.ts";
import { getEmbedder, toPgVector } from "../src/embed.ts";

test("a Voyage key alone leaves embeddings offline", async () => {
  delete process.env[ENV.EMBEDDING_PROVIDER];
  process.env[ENV.VOYAGE_API_KEY] = "unused-test-key";
  const embedder = getEmbedder();
  assert.equal(embedder.model, "offline-hash-v1");
  const [vector, empty] = await embedder.embed(["source code", ""], "document");
  assert.ok(toPgVector(vector));
  assert.equal(toPgVector(empty), null);
});

test("explicit Voyage mode rejects malformed vectors and sanitizes HTTP errors", async (t) => {
  process.env[ENV.EMBEDDING_PROVIDER] = "voyage";
  process.env[ENV.VOYAGE_API_KEY] = "unused-test-key";
  const mockFetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ data: [{ index: 0, embedding: [1] }] }));
  await assert.rejects(getEmbedder().embed(["test input"], "document"), /invalid embedding/);
  mockFetch.mock.mockImplementation(async () => new Response("raw provider response", { status: 400 }));
  await assert.rejects(getEmbedder().embed(["test input"], "query"), { message: "Voyage embeddings request failed with HTTP 400." });
});
