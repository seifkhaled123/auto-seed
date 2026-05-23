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
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: DIALECT_MAP[dialect] });
  } catch (err) {
    throw new CLIError(
      `SQL parse failed: ${(err as Error).message}`,
      2,
      "Try --dialect mysql|sqlite|postgresql.",
    );
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  const tables: TableIR[] = [];
  const warnings: string[] = [];

  for (const stmt of statements as Array<Record<string, unknown>>) {
    if (stmt?.type !== "create" || stmt?.keyword !== "table") continue;
    const tbl = parseCreateTable(stmt, warnings);
    if (tbl) tables.push(tbl);
  }

  if (tables.length === 0) {
    warnings.push(
      "No CREATE TABLE statements found. Make sure the file contains DDL, not just DML.",
    );
  }

  return { source: "sql", dialect, tables, warnings };
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
  const kind = sqlTypeToKind(dataType);
  const length = (dt.length as number | undefined) ?? undefined;

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

  if (kind === "unknown") {
    warnings.push(`${tableName}.${name}: unrecognized type "${dataType}" — using fallback.`);
  }
  return col;
}

function sqlTypeToKind(t: string): ScalarKind {
  const x = t.toLowerCase();
  if (
    x.includes("char") ||
    x === "text" ||
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
  return "unknown";
}
