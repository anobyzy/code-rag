import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionFile, moduleFromPath } from "../src/partition.ts";
import { INVARIANT_PATTERNS } from "../src/constants.ts";

test("skips real .env, indexes only keys of .env.example", () => {
  assert.deepEqual(partitionFile("apps/api/.env", "SECRET=hunter2\n"), []);
  const ex = partitionFile("apps/api/.env.example", "API_TOKEN=changeme\nDB_URL=x\n# c\n");
  assert.equal(ex.length, 1);
  assert.ok(!ex[0].content.includes("changeme"));
  assert.ok(ex[0].content.includes("API_TOKEN"));
});

test("extracts requirement refs from spec markdown (default RF-NN scheme)", () => {
  const c = partitionFile("docs/spec.md", "## RF-04 Broadcast\nbehavior to implement\n").at(-1)!;
  assert.equal(c.layer, "spec");
  assert.ok(c.requirement_refs.includes("RF-04"));
});

test("classifies a controller as interface and extracts route symbols", () => {
  const ts = "@Controller()\nexport class WebhookController {\n @Post('webhook') async h() {} }";
  const c = partitionFile("apps/api/src/webhook.controller.ts", ts)[0];
  assert.equal(c.layer, "interface");
  assert.ok(c.symbols_defined.includes("WebhookController"));
  assert.ok(c.symbols_defined.some((s) => s.startsWith("POST /webhook")));
});

test("infers module from path using configured MODULES", () => {
  assert.equal(moduleFromPath("apps/worker/src/x.ts"), "worker");
  assert.equal(moduleFromPath("apps/unknown/src/x.ts"), "foundation");
  assert.equal(moduleFromPath("src/webhook.ts"), "foundation");
});

test("environment examples contain only valid variable names", () => {
  const [chunk] = partitionFile(".ENV.EXAMPLE", "export TOKEN=value\n# comment\nprivate key material\nNAME = value\n");
  assert.equal(chunk.content, "TOKEN\nNAME");
});

test("splits oversized source without dropping declarations at the end", () => {
  const chunks = partitionFile("src/index.ts", `${"// padding\n".repeat(2000)}export function bottom() {}\n`);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 8000));
  assert.ok(chunks.at(-1)?.symbols_defined.includes("bottom"));
});

test("invariant tags are stable when configured with global regexes", () => {
  INVARIANT_PATTERNS.push({ tag: "fixture", re: /fixture/g });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(partitionFile("fixture.ts", "fixture")[0].invariant_tags, ["fixture"]);
    }
  } finally {
    INVARIANT_PATTERNS.pop();
  }
});
