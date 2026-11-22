import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Chunk, isIndexablePath, partitionFile } from "./partition.js";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", "__macosx", ".next", ".turbo", ".aws", ".ssh"]);
const SECRET_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/;

function git(root: string, args: string[], input?: string): string {
  // Git hooks and users can export GIT_DIR/GIT_INDEX_FILE. Always use the requested worktree.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
      env, input, maxBuffer: MAX_GIT_OUTPUT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    if (args[0] === "check-ignore" && (error as { status?: number }).status === 1) return "";
    throw new Error(`Git ${args[0]} failed. Check that the path is the root of a readable Git worktree.`);
  }
}

function resolveWorktree(root: string): string {
  const worktree = realpathSync(root);
  if (git(worktree, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]).trim() !== "true") {
    throw new Error("Ingest requires the Git worktree root. The existing index was preserved.");
  }
  return worktree;
}

export function openWorktree(root: string): { id: string; readChunks: () => Chunk[] } {
  const worktree = resolveWorktree(root);
  const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"]).replace(/\r?\n$/, "");
  const idFile = path.join(gitDir, "code-rag-worktree-id");
  try {
    writeFileSync(idFile, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const id = readRegularFile(idFile)?.trim();
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
    throw new Error("The Git worktree has an invalid code-rag-worktree-id. The existing index was preserved.");
  }
  return { id, readChunks: () => readSourceChunks(worktree) };
}

function readSourceChunks(worktree: string): Chunk[] {
  const candidates: string[] = [];
  for (const entry of git(worktree, ["ls-files", "--cached", "--stage", "-t", "-z"]).split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\t");
    const [tag, mode, , stage] = entry.slice(0, separator).split(" ");
    if (stage !== "0") throw new Error("Resolve Git index conflicts before refreshing the index.");
    if (tag === "S") throw new Error("Ingest requires a complete worktree without sparse checkout or skip-worktree entries.");
    const file = entry.slice(separator + 1);
    if ((mode === "100644" || mode === "100755") && !file.includes("\uFFFD") && isIndexablePath(file) &&
        !file.toLowerCase().split("/").slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir))) {
      candidates.push(file);
    }
  }
  const ignored = new Set(candidates.length
    ? git(worktree, ["check-ignore", "--no-index", "-z", "--stdin"], `${candidates.join("\0")}\0`).split("\0")
    : []);
  return candidates.flatMap((relative) => {
    if (ignored.has(relative)) return [];
    const file = path.resolve(worktree, relative);
    const within = path.relative(worktree, file);
    if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) return [];
    const text = readRegularFile(file);
    if (text === undefined || (!/(^|\/)\.env\.example$/i.test(relative) && SECRET_CONTENT.test(text))) return [];
    return partitionFile(relative, text);
  });
}

function readRegularFile(file: string): string | undefined {
  try {
    const metadata = lstatSync(file);
    // realpath also rejects a tracked file reached through a replaced parent directory.
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES || path.relative(file, realpathSync(file))) return;
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES || opened.ino !== metadata.ino || opened.dev !== metadata.dev) return;
      const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (!read) break;
        length += read;
      }
      const data = buffer.subarray(0, length);
      if (length > MAX_FILE_BYTES || data.includes(0)) return;
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        return undefined;
      }
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}
