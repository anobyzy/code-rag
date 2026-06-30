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

const SECRET_FILE = /(^|[/\\])\.env(\.|$)/;
const EXAMPLE_ENV = /\.env\.example$/;

export function moduleFromPath(p: string): Module {
  const low = p.toLowerCase();
  for (const m of MODULES) {
    if (m !== "foundation" && low.includes(m)) return m;
  }
  return "foundation";
}

function detectInvariants(text: string): string[] {
  return INVARIANT_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.tag);
}

function detectRequirements(text: string): string[] {
  return [...new Set((text.match(REQUIREMENT_RE) ?? []))];
}

function importPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:import\s[^'"]*from|require\()\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
  for (const m of text.matchAll(/['"`]([\w./-]+\.(?:ts|tsx|js|sql|md))['"`]/g)) out.add(m[1]);
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

  if (SECRET_FILE.test(file) && !EXAMPLE_ENV.test(file)) return []; // never index real secrets
  if (EXAMPLE_ENV.test(file)) return [envExampleChunk(file, content)];
  if (ext === ".md") return splitMarkdown(file, content);
  if (ext === ".sql") return splitSql(file, content);
  if (base === "package.json") return [makeChunk(file, { content, layer: "global" })];
  if (ext === ".ts" || ext === ".tsx" || ext === ".js") return splitCode(file, content);
  return [];
}

function envExampleChunk(file: string, content: string): Chunk {
  const keys = content
    .split(/\r?\n/)
    .map((l) => l.split("=")[0].trim())
    .filter((k) => k && !k.startsWith("#"));
  return makeChunk(file, { content: keys.join("\n"), layer: "global", dependencies_imported: [] });
}

function splitMarkdown(file: string, content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) chunks.push(makeChunk(file, { content: text, layer: "spec" }));
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
    .map((s) => s.trim())
    .filter((s) => /^(create|alter)/i.test(s))
    .map((stmt) => {
      const sym = stmt.match(/create\s+(?:table|policy|index|function|materialized view)?\s*(?:if not exists\s+)?["']?([\w.]+)/i);
      return makeChunk(file, {
        content: stmt,
        layer: "global",
        symbols_defined: sym ? [sym[1]] : [],
      });
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

function splitCode(file: string, content: string): Chunk[] {
  const symbols = new Set<string>();
  for (const re of SYMBOL_RES) for (const m of content.matchAll(re)) symbols.add(m[1]);
  for (const m of content.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*['"]([^'"]*)['"]/g)) {
    symbols.add(`${m[1].toUpperCase()} /${m[2].replace(/^\//, "")}`);
  }
  return [
    makeChunk(file, {
      content,
      layer: codeLayer(file, content),
      symbols_defined: [...symbols],
    }),
  ];
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
