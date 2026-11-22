// v0 partitioner: lightweight, dependency-free chunking + metadata extraction.
// AST upgrade (ts-morph for .ts, @babel/parser for the legacy .js JSX shell) is the
// documented next step; the chunk contract below does not change when it lands.

import path from "node:path";
import { INVARIANT_PATTERNS, REQUIREMENT_RE, Layer, Module, MODULES } from "./constants.js";

export interface Chunk {
  file_path: string;
  layer: Layer;
  module: Module;
  symbols_defined: string[];
  dependencies_imported: string[];
  requirement_refs: string[];
  invariant_tags: string[];
  content: string;
}

const SECRET_FILE = /(^|[/\\])\.env(\.|$)/i;
const EXAMPLE_ENV = /(^|[/\\])\.env\.example$/i;
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const MAX_CHUNK_CHARS = 8000;

export function isIndexablePath(file: string): boolean {
  const base = path.posix.basename(file.replace(/\\/g, "/")).toLowerCase();
  const ext = path.extname(base);
  if (base === ".env.example") return !SECRET_FILE.test(file.slice(0, -base.length));
  if (SECRET_FILE.test(file)) return false;
  return base === "package.json" || ext === ".md" || ext === ".sql" || CODE_EXT.has(ext);
}

export function moduleFromPath(p: string): Module {
  const directories = p.toLowerCase().split(/[/\\]/).slice(0, -1);
  for (const m of MODULES) {
    if (m !== "foundation" && directories.includes(m)) return m;
  }
  return "foundation";
}

function detectInvariants(text: string): string[] {
  return INVARIANT_PATTERNS.filter(({ re }) => {
    re.lastIndex = 0;
    return re.test(text);
  }).map(({ tag }) => tag);
}

function detectRequirements(text: string): string[] {
  return [...new Set((text.match(REQUIREMENT_RE) ?? []))];
}

function importPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:\bfrom\s*|\b(?:import|require)\s*\(\s*|\bimport\s+)['"]([^'"\r\n]+)['"]/g)) out.add(m[1]);
  for (const m of text.matchAll(/[`]([\w./-]+\.(?:ts|tsx|js|sql|md))[`]/g)) out.add(m[1]);
  return [...out];
}

function makeChunk(file: string, partial: Partial<Chunk> & { content: string; layer: Layer }): Chunk {
  const text = partial.content;
  return {
    file_path: file,
    layer: partial.layer,
    module: partial.module ?? moduleFromPath(file),
    symbols_defined: partial.symbols_defined ?? [],
    dependencies_imported: partial.dependencies_imported ?? importPaths(text),
    requirement_refs: partial.requirement_refs ?? detectRequirements(text),
    invariant_tags: partial.invariant_tags ?? detectInvariants(text),
    content: text,
  };
}

export function partitionFile(file: string, content: string): Chunk[] {
  const base = path.basename(file).toLowerCase();
  const ext = path.extname(file).toLowerCase();

  if (!isIndexablePath(file)) return [];
  if (EXAMPLE_ENV.test(file)) return splitText(envNames(content)).map((text) =>
    makeChunk(file, { content: text, layer: "global", dependencies_imported: [] }));
  if (ext === ".md") return splitMarkdown(file, content);
  if (ext === ".sql") return splitSql(file, content);
  if (base === "package.json") return splitText(content).map((text) => makeChunk(file, { content: text, layer: "global" }));
  const layer = codeLayer(file, content);
  return splitText(content).map((text) => codeChunk(file, text, layer));
}

function envNames(content: string): string {
  return [...new Set(Array.from(content.matchAll(/^\s*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm), (match) => match[1]))].join("\n");
}

function splitText(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline >= start) end = newline + 1;
      else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const part = text.slice(start, end);
    if (part.trim()) parts.push(part);
    start = end;
  }
  return parts;
}

function splitMarkdown(file: string, content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    for (const part of splitText(text)) chunks.push(makeChunk(file, { content: part, layer: "spec" }));
    buf = [];
  };
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && buf.length) flush();
    buf.push(line);
  }
  flush();
  return chunks;
}

function splitSql(file: string, content: string): Chunk[] {
  return content
    .split(/;\s*\n/)
    .map((s) => s.replace(/^(?:\s*--[^\n]*\n)*/, "").trim())
    .filter((s) => /^(create|alter)/i.test(s))
    .flatMap((stmt) => {
      const sym = stmt.match(/create\s+(?:table|policy|index|function|materialized view)?\s*(?:if not exists\s+)?["']?([\w.]+)/i);
      return splitText(stmt).map((content, i) => makeChunk(file, {
        content,
        layer: "global",
        symbols_defined: sym && i === 0 ? [sym[1]] : [],
      }));
    });
}

const SYMBOL_RES: RegExp[] = [
  /export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/g,
  /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
  /export\s+(?:const|let)\s+(\w+)/g,
  /(?:export\s+)?(?:interface|type)\s+(\w+)/g,
  /const\s+([A-Z]\w+)\s*=\s*\(/g, // React component
  /const\s+(use[A-Z]\w+)\s*=/g, // hook
];

function codeChunk(file: string, content: string, layer: Layer): Chunk {
  const symbols = new Set<string>();
  for (const re of SYMBOL_RES) for (const m of content.matchAll(re)) symbols.add(m[1]);
  for (const m of content.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*['"]([^'"]*)['"]/g)) {
    symbols.add(`${m[1].toUpperCase()} /${m[2].replace(/^\//, "")}`);
  }
  return makeChunk(file, { content, layer, symbols_defined: [...symbols] });
}

function codeLayer(file: string, content: string): Layer {
  const low = file.toLowerCase();
  if (/\.(test|spec)\.[jt]sx?$/.test(low)) return "test";
  if (/\.module\.ts$/.test(low)) return "global";
  if (/\.controller\.ts$/.test(low) || /@Controller|@(Get|Post|Put|Patch|Delete)\(/.test(content)) return "interface";
  if (/\.dto\.ts$|\.contract\.ts$|[/\\]shared[/\\]/.test(low)) return "interface";
  if (/routes\.js$|menu-items\.js$/.test(low)) return "interface";
  return "implementation";
}
