import assert from "node:assert/strict";
import { test } from "node:test";
import { partitionFile } from "../src/partition.ts";

test("indexes the languages used by the connected projects", () => {
  const cases = [
    ["src/voice.rs", "pub async fn process_audio() {}", "process_audio"],
    ["scripts/sync.py", "async def synchronize():\n    pass", "synchronize"],
    ["src/plugin.php", "<?php\nfinal class LocalPlugin {}", "LocalPlugin"],
    ["modules/truck.gd", "class_name DeliveryTruck\nfunc unload() -> void:\n\tpass", "DeliveryTruck"],
  ];
  for (const [file, source, name] of cases) {
    const [chunk] = partitionFile(file, source);
    assert.ok(chunk, file);
    assert.ok(chunk.symbols_defined.includes(name), file);
  }
});

test("omits WordPress connection configuration", () => {
  assert.deepEqual(partitionFile("www/wp-config.php", "<?php"), []);
  assert.deepEqual(partitionFile("www/wp-config-local.php", "<?php"), []);
});
