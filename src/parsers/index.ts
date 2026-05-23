import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CLIError } from "../util/errors.js";
import { SchemaIR, SqlDialect } from "../ir/types.js";
import { parsePrismaSchema } from "./prisma.js";
import { parseSqlSchema } from "./sql.js";
import { defaultTypeOrmGlobs, parseTypeOrmEntities } from "./typeorm.js";

const SQL_EXTS = [".sql"];

export interface DetectResult {
  source: "prisma" | "sql" | "typeorm";
  paths: string[];
}

export async function detectSchema(cwd = process.cwd()): Promise<DetectResult[]> {
  const candidates: DetectResult[] = [];

  const prismaPaths = [
    path.join(cwd, "prisma/schema.prisma"),
    path.join(cwd, "schema.prisma"),
  ].filter((p) => fs.existsSync(p));
  if (prismaPaths.length > 0) candidates.push({ source: "prisma", paths: prismaPaths });

  const sqlPaths = [
    path.join(cwd, "schema.sql"),
    path.join(cwd, "db/schema.sql"),
  ].filter((p) => fs.existsSync(p));
  // Also check for *.sql at the root (cheap glob)
  try {
    for (const f of await fsp.readdir(cwd)) {
      const full = path.join(cwd, f);
      if (SQL_EXTS.includes(path.extname(f)) && !sqlPaths.includes(full)) sqlPaths.push(full);
    }
  } catch {
    /* ignore */
  }
  if (sqlPaths.length > 0) candidates.push({ source: "sql", paths: sqlPaths });

  const tsEntities = await globTypeOrm(cwd);
  if (tsEntities.length > 0) candidates.push({ source: "typeorm", paths: tsEntities });

  return candidates;
}

async function globTypeOrm(cwd: string): Promise<string[]> {
  const results: string[] = [];
  // Stick to a small set of well-known locations.
  const roots = ["src", "entities"];
  for (const r of roots) {
    const full = path.join(cwd, r);
    if (!fs.existsSync(full)) continue;
    walk(full, (file) => {
      if (file.endsWith(".entity.ts")) results.push(file);
    });
  }
  return results;
}

function walk(dir: string, cb: (file: string) => void) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, cb);
      else if (entry.isFile()) cb(full);
    }
  } catch {
    /* ignore */
  }
}

export interface ParseInput {
  schemaPath?: string;
  cwd?: string;
  dialect?: SqlDialect;
}

export async function parseSchema(input: ParseInput): Promise<SchemaIR> {
  const cwd = input.cwd ?? process.cwd();

  if (input.schemaPath) {
    if (!fs.existsSync(input.schemaPath)) {
      throw new CLIError(`Schema not found: ${input.schemaPath}`, 2);
    }
    return await dispatchSingle(input.schemaPath, input.dialect);
  }

  const found = await detectSchema(cwd);
  if (found.length === 0) {
    throw new CLIError(
      "No schema found.",
      2,
      "Pass --schema explicitly. Searched: prisma/schema.prisma, schema.prisma, schema.sql, db/schema.sql, *.sql, src/**/*.entity.ts.",
    );
  }
  if (found.length > 1) {
    throw new CLIError(
      `Multiple schemas detected: ${found
        .map((c) => `${c.source} (${c.paths.length} file${c.paths.length === 1 ? "" : "s"})`)
        .join(", ")}`,
      1,
      "Pass --schema <path> to disambiguate.",
    );
  }
  const choice = found[0]!;
  if (choice.source === "typeorm") {
    void defaultTypeOrmGlobs; // referenced for completeness
    return parseTypeOrmEntities(choice.paths);
  }
  return dispatchSingle(choice.paths[0]!, input.dialect);
}

async function dispatchSingle(filePath: string, dialect?: SqlDialect): Promise<SchemaIR> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".prisma") return parsePrismaSchema(filePath);
  if (ext === ".sql") return parseSqlSchema(filePath, dialect ?? "postgresql");
  if (ext === ".ts") return parseTypeOrmEntities([filePath]);
  throw new CLIError(`Unsupported schema file extension: ${ext}`, 2);
}
