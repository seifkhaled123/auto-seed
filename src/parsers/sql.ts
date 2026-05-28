import fsp from "node:fs/promises";
import sqlParserPkg from "node-sql-parser";
import { CLIError } from "../util/errors.js";
import { ColumnIR, ScalarKind, SchemaIR, SqlDialect, TableIR } from "../ir/types.js";

const { Parser } = sqlParserPkg as unknown as {
  Parser: new () => { astify: (sql: string, opts: { database: string }) => unknown };
};

const DIALECT_MAP: Record<SqlDialect, "Postgresql" | "MySQL" | "Sqlite"> = {
  postgresql: "Postgresql",
  mysql: "MySQL",
  sqlite: "Sqlite",
};

export async function parseSqlSchema(
  filePath: string,
  dialect: SqlDialect = "postgresql",
): Promise<SchemaIR> {
  const sql = await fsp.readFile(filePath, "utf8");
  const parser = new Parser();
  const warnings: string[] = [];

  // node-sql-parser parses the whole file atomically and chokes on advanced DDL
  // (CREATE TYPE/DOMAIN/EXTENSION/TRIGGER/VIEW/FUNCTION, PRAGMA, GENERATED columns,
  // custom enum/domain typed columns, …). So we split into statements, resolve the
  // pieces we care about ourselves, keep only CREATE TABLE, sanitize each, and parse
  // them individually — skipping (not aborting on) any statement we can't handle.
  const rawStatements = splitSqlStatements(sql);
  const enumTypes = extractEnumTypes(sql); // custom enum type name → values
  const domains = extractDomains(sql); // domain name → base type token

  const tables: TableIR[] = [];

  for (const raw of rawStatements) {
    if (!isCreateTableStmt(raw)) continue;
    // Partition child tables duplicate the parent's columns and have no own column list.
    if (/\bPARTITION\s+OF\b/i.test(raw)) continue;

    // Record column-level facts that sanitizing would erase, keyed by column name.
    const enumCols = scanEnumTypedColumns(raw, enumTypes); // col → values
    const generatedCols = scanGeneratedColumns(raw); // computed STORED/VIRTUAL cols to omit
    const identityCols = scanIdentityColumns(raw); // GENERATED ... AS IDENTITY cols

    const sanitized = sanitizeCreateTable(raw, enumTypes, domains);

    let ast: unknown;
    try {
      ast = parser.astify(sanitized, { database: DIALECT_MAP[dialect] });
    } catch (err) {
      const nameMatch = /CREATE\s+(?:[A-Z]+\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/i.exec(raw);
      const tblName = nameMatch ? unquoteIdent(nameMatch[1]!) : "(unknown)";
      warnings.push(
        `Skipped table "${tblName}": could not parse (${(err as Error).message.split("\n")[0]})`,
      );
      continue;
    }
    const stmt = (Array.isArray(ast) ? ast[0] : ast) as Record<string, unknown> | undefined;
    if (!stmt || stmt.type !== "create" || stmt.keyword !== "table") continue;

    const tbl = parseCreateTable(stmt, warnings);
    if (!tbl) continue;

    // Overlay facts lost during sanitizing.
    for (const c of tbl.columns) {
      const vals = enumCols.get(c.name);
      if (vals && vals.length > 0) {
        c.kind = "enum";
        c.enumValues = vals;
      }
      if (identityCols.has(c.name)) c.isAutoIncrement = true;
      if (generatedCols.has(c.name)) c.isGenerated = true;
    }
    tables.push(tbl);
  }

  if (tables.length === 0) {
    warnings.push(
      "No CREATE TABLE statements found. Make sure the file contains DDL, not just DML.",
    );
  }

  return { source: "sql", dialect, tables, warnings };
}

/**
 * Splits a SQL string into top-level statements on `;`, respecting line/block
 * comments, single-quoted strings, and Postgres dollar-quoted bodies ($tag$…$tag$).
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      // Drop line comments so they don't get prepended to the next statement.
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (two === "/*") {
      // Drop block comments.
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function isCreateTableStmt(stmt: string): boolean {
  const s = stmt.replace(/^\s+/, "");
  if (/^CREATE\s+(?:GLOBAL\s+|LOCAL\s+|TEMP(?:ORARY)?\s+|UNLOGGED\s+)*VIRTUAL\s+TABLE/i.test(s)) return false;
  return /^CREATE\s+(?:GLOBAL\s+|LOCAL\s+|TEMP(?:ORARY)?\s+|UNLOGGED\s+)*TABLE/i.test(s);
}

function unquoteIdent(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, "");
}

/** CREATE TYPE x AS ENUM ('a','b',…) → Map(name → [a,b,…]) */
function extractEnumTypes(sql: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const re = /CREATE\s+TYPE\s+("?[\w]+"?)\s+AS\s+ENUM\s*\(([\s\S]*?)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const name = unquoteIdent(m[1]!).toLowerCase();
    const values = [...m[2]!.matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1]!.replace(/''/g, "'"));
    if (values.length > 0) map.set(name, values);
  }
  return map;
}

/** CREATE DOMAIN x AS basetype … → Map(name → basetype token, e.g. "varchar(320)") */
function extractDomains(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /CREATE\s+DOMAIN\s+("?[\w]+"?)\s+AS\s+([A-Za-z0-9_]+(?:\s*\([^)]*\))?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    map.set(unquoteIdent(m[1]!).toLowerCase(), m[2]!.trim());
  }
  return map;
}

/** Body between the outermost parens of a CREATE TABLE statement. */
function tableBody(stmt: string): string {
  const open = stmt.indexOf("(");
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < stmt.length; i++) {
    if (stmt[i] === "(") depth++;
    else if (stmt[i] === ")") { depth--; if (depth === 0) return stmt.slice(open + 1, i); }
  }
  return stmt.slice(open + 1);
}

/** Column-definition lines (top-level commas only) from a table body. */
function splitColumnDefs(body: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

const COLUMN_DEF_START = /^("?[\w]+"?)\s+/;
const CONSTRAINT_KEYWORDS = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE|LIKE)\b/i;

function scanEnumTypedColumns(stmt: string, enumTypes: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (enumTypes.size === 0) return out;
  for (const def of splitColumnDefs(tableBody(stmt))) {
    if (CONSTRAINT_KEYWORDS.test(def)) continue;
    const m = COLUMN_DEF_START.exec(def);
    if (!m) continue;
    const colName = unquoteIdent(m[1]!);
    const typeToken = def.slice(m[0].length).split(/[\s(]/)[0]!.toLowerCase().replace(/\[\]$/, "");
    const vals = enumTypes.get(typeToken);
    if (vals) out.set(colName, vals);
  }
  return out;
}

function scanGeneratedColumns(stmt: string): Set<string> {
  const out = new Set<string>();
  for (const def of splitColumnDefs(tableBody(stmt))) {
    if (CONSTRAINT_KEYWORDS.test(def)) continue;
    // computed column: GENERATED ALWAYS AS ( … )  [STORED|VIRTUAL]  (NOT "AS IDENTITY")
    if (/GENERATED\s+ALWAYS\s+AS\s*\(/i.test(def)) {
      const m = COLUMN_DEF_START.exec(def);
      if (m) out.add(unquoteIdent(m[1]!));
    }
  }
  return out;
}

function scanIdentityColumns(stmt: string): Set<string> {
  const out = new Set<string>();
  for (const def of splitColumnDefs(tableBody(stmt))) {
    if (CONSTRAINT_KEYWORDS.test(def)) continue;
    if (/GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i.test(def)) {
      const m = COLUMN_DEF_START.exec(def);
      if (m) out.add(unquoteIdent(m[1]!));
    }
  }
  return out;
}

/** Rewrites a CREATE TABLE statement into something node-sql-parser accepts. */
function sanitizeCreateTable(
  stmt: string,
  enumTypes: Map<string, string[]>,
  domains: Map<string, string>,
): string {
  let s = stmt;

  // Strip GENERATED … AS IDENTITY [( … )]
  s = s.replace(/GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY(\s*\([^)]*\))?/gi, "");
  // Strip GENERATED ALWAYS AS ( … ) [STORED|VIRTUAL] — balanced-paren aware.
  s = stripGeneratedExpr(s);
  // Strip NULLS [NOT] DISTINCT
  s = s.replace(/\bNULLS\s+(?:NOT\s+)?DISTINCT\b/gi, "");
  // CITEXT base type → varchar
  s = s.replace(/\bCITEXT\b/gi, "VARCHAR(255)");
  // Range types node-sql-parser rejects → varchar (we don't generate true ranges).
  s = s.replace(/\b(?:date|ts|tstz|int4|int8|num)(?:multi)?range\b/gi, "VARCHAR(255)");
  // Table options after the column list that node-sql-parser dislikes.
  s = s.replace(/\bINHERITS\s*\([^)]*\)/gi, "");
  s = s.replace(/\bPARTITION\s+BY[\s\S]*$/gi, "");

  // Replace custom enum/domain typed columns with a parseable base type.
  const body = tableBody(s);
  if (body) {
    const defs = splitColumnDefs(body).map((def) => {
      if (CONSTRAINT_KEYWORDS.test(def)) return def;
      const m = COLUMN_DEF_START.exec(def);
      if (!m) return def;
      const rest = def.slice(m[0].length);
      const rawTypeToken = rest.split(/[\s(]/)[0]!; // may carry a trailing []
      const typeToken = rawTypeToken.toLowerCase().replace(/\[\]$/, "");
      // Replace the whole type token incl. any [] array suffix with a parseable base.
      const tokenRe = new RegExp("^" + escapeRe(typeToken) + "(\\s*\\[\\])?", "i");
      if (enumTypes.has(typeToken)) {
        return m[0] + rest.replace(tokenRe, "VARCHAR(255)");
      }
      const domainBase = domains.get(typeToken);
      if (domainBase) {
        return m[0] + rest.replace(tokenRe, domainBase);
      }
      return def;
    });
    const newBody = defs.join(",\n  ");
    const open = s.indexOf("(");
    const close = closingParen(s, open);
    if (open !== -1 && close !== -1) {
      s = s.slice(0, open + 1) + "\n  " + newBody + "\n" + s.slice(close);
    }
  }
  return s;
}

function stripGeneratedExpr(s: string): string {
  const re = /GENERATED\s+ALWAYS\s+AS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const parenStart = m.index + m[0].length - 1;
    const close = closingParen(s, parenStart);
    if (close === -1) break;
    let end = close + 1;
    const tail = s.slice(end).match(/^\s*(STORED|VIRTUAL)\b/i);
    if (tail) end += tail[0].length;
    s = s.slice(0, m.index) + s.slice(end);
    re.lastIndex = m.index;
  }
  return s;
}

function closingParen(s: string, open: number): number {
  if (open < 0 || s[open] !== "(") return -1;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCreateTable(
  stmt: Record<string, unknown>,
  warnings: string[],
): TableIR | null {
  const tableInfo = (stmt.table as Array<{ table: string }> | undefined)?.[0];
  if (!tableInfo) return null;
  const tableName = tableInfo.table;

  const defs = (stmt.create_definitions as Array<Record<string, unknown>> | undefined) ?? [];

  const columns: ColumnIR[] = [];
  let primaryKey: string[] = [];
  const uniqueGroups: string[][] = [];

  for (const def of defs) {
    const resource = def.resource as string | undefined;
    if (resource === "column") {
      const col = parseColumnDef(def, tableName, warnings);
      if (col) {
        columns.push(col);
        if (col.isPrimaryKey) primaryKey.push(col.name);
      }
    } else if (resource === "constraint") {
      const ctype = String(def.constraint_type ?? "").toLowerCase();
      if (ctype === "primary key") {
        primaryKey = extractColRefList(def.definition);
      } else if (ctype === "unique key" || ctype === "unique") {
        const cols = extractColRefList(def.definition);
        if (cols.length > 0) uniqueGroups.push(cols);
      } else if (ctype === "foreign key") {
        const cols = extractColRefList(def.definition);
        const ref = def.reference_definition as Record<string, unknown> | undefined;
        if (ref && cols.length > 0) {
          const refTable = (ref.table as Array<{ table: string }> | undefined)?.[0]?.table;
          const refCols = extractColRefList(ref.definition);
          if (refTable && refCols.length === cols.length) {
            cols.forEach((c, i) => {
              const col = columns.find((cc) => cc.name === c);
              if (col) col.foreignKey = { table: refTable, column: refCols[i]! };
            });
          }
        }
      }
    } else if (resource === "index") {
      const indexType = String(def.index_type ?? "").toLowerCase();
      if (indexType === "unique") {
        const cols = extractColRefList(def.index_columns ?? def.definition);
        if (cols.length > 0) uniqueGroups.push(cols);
      }
    }
  }

  // Mark PK on columns (table-level PK may name columns not flagged inline)
  for (const c of columns) {
    if (primaryKey.includes(c.name)) c.isPrimaryKey = true;
  }

  return { name: tableName, columns, primaryKey, uniqueGroups };
}

/**
 * Pulls a string column-name out of node-sql-parser's column_ref shape:
 *   { type: "column_ref", column: { expr: { type: "default", value: "name" } } }
 * or sometimes:
 *   { type: "column_ref", column: "name" }
 */
function colRefName(ref: unknown): string | undefined {
  if (!ref || typeof ref !== "object") return undefined;
  const r = ref as { column?: unknown; expr?: { value?: string } };
  if (typeof r.column === "string") return r.column;
  if (r.column && typeof r.column === "object") {
    const inner = r.column as { expr?: { value?: string }; value?: string };
    if (inner.expr?.value) return inner.expr.value;
    if (typeof inner.value === "string") return inner.value;
  }
  if (r.expr?.value) return r.expr.value;
  return undefined;
}

function extractColRefList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => colRefName(entry))
    .filter((s): s is string => Boolean(s));
}

function parseColumnDef(
  def: Record<string, unknown>,
  tableName: string,
  warnings: string[],
): ColumnIR | null {
  const name = colRefName(def.column);
  if (!name) return null;

  const dt = def.definition as Record<string, unknown> | undefined;
  if (!dt) return null;
  const dataTypeRaw = String(dt.dataType ?? "");
  const dataType = dataTypeRaw.toLowerCase();
  let kind = sqlTypeToKind(dataType);
  const length = (dt.length as number | undefined) ?? undefined;

  // MySQL inline enum(...) / set(...) carry their members in the AST.
  let enumValues: string[] | undefined;
  if (dataType === "enum" || dataType === "set") {
    const vals = extractEnumMembers(dt);
    if (vals.length > 0) {
      kind = "enum";
      enumValues = vals;
    }
  }

  const nullableField = def.nullable as { type?: string; value?: string } | undefined;
  const nullable =
    nullableField?.type === "not null" || nullableField?.value === "not null" ? false : true;

  let isPrimaryKey = false;
  let isUnique = false;
  let foreignKey: { table: string; column: string } | undefined;
  let hasDefault = def.default_val !== undefined && def.default_val !== null;
  let isAutoIncrement = false;

  // Inline PK / UNIQUE
  if (typeof def.primary_key === "string" && def.primary_key.toLowerCase().includes("primary")) {
    isPrimaryKey = true;
  }
  if (typeof def.unique === "string" && def.unique.toLowerCase() === "unique") {
    isUnique = true;
  }
  // Older shapes
  const upo = def.unique_or_primary;
  if (typeof upo === "string") {
    if (upo.toLowerCase().includes("primary")) isPrimaryKey = true;
    if (upo.toLowerCase() === "unique") isUnique = true;
  }

  const autoInc = (def.auto_increment as string | undefined)?.toLowerCase();
  if (autoInc === "auto_increment") isAutoIncrement = true;

  // Postgres serial types are inherently auto-incrementing.
  if (["serial", "bigserial", "smallserial"].includes(dataType)) {
    isAutoIncrement = true;
    hasDefault = true;
  }

  // Inline REFERENCES
  const ref = def.reference_definition as Record<string, unknown> | undefined;
  if (ref) {
    const refTable = (ref.table as Array<{ table: string }> | undefined)?.[0]?.table;
    const refCols = extractColRefList(ref.definition);
    if (refTable && refCols[0]) foreignKey = { table: refTable, column: refCols[0] };
  }

  const col: ColumnIR = {
    name,
    kind,
    rawType: dataType,
    nullable,
    isPrimaryKey,
    isUnique,
    isAutoIncrement,
    hasDefault,
  };
  if (length !== undefined && kind === "string") col.maxLength = length;
  if (foreignKey) col.foreignKey = foreignKey;
  if (enumValues) col.enumValues = enumValues;

  if (kind === "unknown") {
    warnings.push(`${tableName}.${name}: unrecognized type "${dataType}" — using fallback.`);
  }
  return col;
}

/**
 * Pulls enum/set member strings out of node-sql-parser's MySQL shape:
 *   { dataType: "ENUM", expr: { type: "expr_list", value: [{ value: "male" }, ...] } }
 */
function extractEnumMembers(dt: Record<string, unknown>): string[] {
  const expr = dt.expr as { value?: unknown } | undefined;
  if (!expr || !Array.isArray(expr.value)) return [];
  return expr.value
    .map((e) => (e && typeof e === "object" ? (e as { value?: unknown }).value : undefined))
    .filter((v): v is string => typeof v === "string");
}

function sqlTypeToKind(t: string): ScalarKind {
  const x = t.toLowerCase();
  if (
    x.includes("char") ||
    x.includes("text") ||
    x.includes("clob") ||
    x === "string" ||
    x === "citext"
  )
    return "string";
  if (x === "uuid") return "uuid";
  if (x === "boolean" || x === "bool") return "boolean";
  if (x === "json" || x === "jsonb") return "json";
  if (
    x === "smallint" ||
    x === "integer" ||
    x === "int" ||
    x === "int4" ||
    x === "int2" ||
    x === "tinyint" ||
    x === "mediumint" ||
    x === "serial" ||
    x === "smallserial"
  )
    return "int";
  if (x === "bigint" || x === "int8" || x === "bigserial") return "bigint";
  if (
    x === "real" ||
    x === "float" ||
    x === "double" ||
    x === "double precision" ||
    x === "float4" ||
    x === "float8"
  )
    return "float";
  if (x === "numeric" || x === "decimal" || x === "money") return "decimal";
  if (x === "timestamp" || x === "timestamptz" || x === "datetime") return "datetime";
  if (x === "date") return "date";
  if (x === "time" || x === "interval") return "string";
  // Network / binary / misc types → string (no specialized generation).
  if (x === "inet" || x === "cidr" || x === "macaddr" || x === "macaddr8") return "string";
  if (x === "blob" || x === "bytea" || x === "varbinary" || x === "binary") return "string";
  if (x === "tsvector" || x === "tsquery" || x === "xml") return "string";
  // Spatial types: approximated as strings (no true WKT/geometry generation in v1).
  if (
    x === "point" ||
    x === "geometry" ||
    x === "linestring" ||
    x === "polygon" ||
    x === "multipoint" ||
    x === "multilinestring" ||
    x === "multipolygon" ||
    x === "geometrycollection"
  )
    return "string";
  return "unknown";
}
