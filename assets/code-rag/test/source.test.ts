import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openWorktree } from "../src/source.ts";

test("ingest reads eligible tracked working files and excludes ignored and sensitive content", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "code-rag-source-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  const write = (file: string, content: string | Buffer) => writeFileSync(path.join(root, file), content);
  try {
    git("init");
    mkdirSync(path.join(root, "src"));
    write(".gitignore", "ignored.ts\n");
    write("src/tracked.ts", "export const original = true;\n");
    write("untracked.ts", "export const untracked = true;\n");
    write("ignored.ts", "export const ignored = true;\n");
    write(".ENV.LOCAL.ts", "export const hidden = true;\n");
    write(".env.example", "TOKEN=secretExampleValue\n");
    write("key.md", ["-----BEGIN ", "PRIVATE KEY-----\n", "synthetic"].join(""));
    write("binary.ts", Buffer.from([0xff, 0xfe, 0x01]));
    write("large.ts", "x".repeat(512 * 1024 + 1));
    write("link.md", "link contents\n");
    git("add", "-f", ".gitignore", "src/tracked.ts", "ignored.ts", ".ENV.LOCAL.ts", ".env.example", "key.md", "binary.ts", "large.ts", "link.md");
    const [, linkHash] = git("ls-files", "--stage", "link.md").toString().split(" ");
    git("update-index", "--cacheinfo", `120000,${linkHash},link.md`);
    write("src/tracked.ts", "export const edited = true;\n");

    const worktree = openWorktree(root);
    const chunks = worktree.readChunks();
    assert.equal(openWorktree(root).id, worktree.id);
    assert.deepEqual(chunks.map((chunk) => chunk.file_path), [".env.example", "src/tracked.ts"]);
    assert.equal(chunks[0].content, "TOKEN");
    assert.ok(chunks[1].content.includes("edited"));
    assert.throws(() => openWorktree(path.join(root, "src")), /Git worktree root/);
    assert.throws(() => openWorktree(path.join(root, ".git")), /Git worktree root/);
    git("update-index", "--skip-worktree", "src/tracked.ts");
    assert.throws(() => worktree.readChunks(), /complete worktree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
