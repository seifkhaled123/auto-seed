/**
 * Common Schema Intermediate Representation produced by every parser.
 * See PRD §9.1.
 */

export type ScalarKind =
  | "string"
  | "int"
  | "bigint"
  | "float"
  | "decimal"
  | "boolean"
  | "datetime"
  | "date"
  | "uuid"
  | "json"
  | "enum"
  | "unknown";

export interface ColumnIR {
  name: string;
  kind: ScalarKind;
  rawType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  isAutoIncrement: boolean;
  hasDefault: boolean;
  enumValues?: string[];
  foreignKey?: { table: string; column: string };
  maxLength?: number;
  /** Computed/generated column (e.g. Postgres GENERATED ALWAYS AS (...) STORED). Cannot be inserted; omitted from output. */
  isGenerated?: boolean;
  /** Array-typed column (e.g. Postgres TEXT[] / BIGINT[]). Rendered as an array literal. */
  isArray?: boolean;
}

export interface TableIR {
  name: string;
  columns: ColumnIR[];
  primaryKey: string[];
  uniqueGroups: string[][];
}

export type SchemaSource = "prisma" | "sql" | "typeorm";
export type SqlDialect = "postgresql" | "mysql" | "sqlite";

export interface SchemaIR {
  source: SchemaSource;
  dialect?: SqlDialect;
  tables: TableIR[];
  warnings: string[];
}

export function findTable(ir: SchemaIR, name: string): TableIR | undefined {
  return ir.tables.find((t) => t.name === name);
}

export function findColumn(table: TableIR, name: string): ColumnIR | undefined {
  return table.columns.find((c) => c.name === name);
}
