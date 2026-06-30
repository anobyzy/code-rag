import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionFile, moduleFromPath } from "../src/partition.ts";

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
});
