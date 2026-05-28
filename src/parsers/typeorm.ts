import path from "node:path";
import { Project, SyntaxKind, type ClassDeclaration, type Decorator } from "ts-morph";
import { CLIError } from "../util/errors.js";
import { ColumnIR, ScalarKind, SchemaIR, TableIR } from "../ir/types.js";

interface PendingRelation {
  fromTable: string;
  fromColumn: string;
  toClass: string;
  toColumn?: string; // defaults to "id"
}

const TYPE_TO_KIND: Record<string, ScalarKind> = {
  string: "string",
  varchar: "string",
  nvarchar: "string",
  text: "string",
  tinytext: "string",
  mediumtext: "string",
  longtext: "string",
  char: "string",
  citext: "string",
  clob: "string",
  uuid: "uuid",
  int: "int",
  int2: "int",
  int4: "int",
  integer: "int",
  smallint: "int",
  tinyint: "int",
  mediumint: "int",
  serial: "int",
  smallserial: "int",
  bigint: "bigint",
  int8: "bigint",
  bigserial: "bigint",
  float: "float",
  float4: "float",
  float8: "float",
  double: "float",
  "double precision": "float",
  real: "float",
  decimal: "decimal",
  numeric: "decimal",
  money: "decimal",
  boolean: "boolean",
  bool: "boolean",
  date: "date",
  datetime: "datetime",
  timestamp: "datetime",
  timestamptz: "datetime",
  json: "json",
  jsonb: "json",
  "simple-json": "json",
  "simple-array": "string",
  set: "string",
};

const TS_TO_KIND: Record<string, ScalarKind> = {
  String: "string",
  string: "string",
  Number: "int",
  number: "int",
  Boolean: "boolean",
  boolean: "boolean",
  Date: "datetime",
};

export async function parseTypeOrmEntities(entityFiles: string[]): Promise<SchemaIR> {
  if (entityFiles.length === 0) {
    throw new CLIError("No TypeORM entity files found.", 2, "Pass --schema or place entities under src/**/*.entity.ts.");
  }
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      // Lenient — we only parse decorators, not type-check.
      allowJs: false,
      experimentalDecorators: true,
      target: 99, // ESNext
    },
  });
  for (const f of entityFiles) project.addSourceFileAtPath(f);

  const tables: TableIR[] = [];
  const warnings: string[] = [];
  const pendingRelations: PendingRelation[] = [];
  // Map class name → table name (so relations can resolve cross-file).
  const classToTable = new Map<string, string>();

  // Pre-pass: collect class → table name, and a registry of TS enums so that
  // `@Column({ type: "enum", enum: SomeEnum })` can resolve its member values.
  const enumRegistry = new Map<string, string[]>();
  for (const sf of project.getSourceFiles()) {
    for (const cls of sf.getClasses()) {
      const tableName = readEntityName(cls);
      if (tableName) classToTable.set(cls.getName() ?? tableName, tableName);
    }
    for (const en of sf.getEnums()) {
      const vals = en.getMembers().map((mem) => {
        const v = mem.getValue();
        return v !== undefined ? String(v) : mem.getName();
      });
      if (vals.length > 0) enumRegistry.set(en.getName(), vals);
    }
  }

  for (const sf of project.getSourceFiles()) {
    for (const cls of sf.getClasses()) {
      const tableName = readEntityName(cls);
      if (!tableName) continue;
      const className = cls.getName() ?? tableName;

      const columns: ColumnIR[] = [];
      const uniqueGroups: string[][] = [];
      const primaryKey: string[] = [];

      // Class-level @Unique decorators
      for (const dec of cls.getDecorators()) {
        if (dec.getName() === "Unique") {
          const cols = readStringArrayArg(dec);
          if (cols.length > 0) uniqueGroups.push(cols);
        }
      }

      for (const prop of cls.getInstanceProperties()) {
        if (prop.getKind() !== SyntaxKind.PropertyDeclaration) continue;
        const propName = prop.getName();
        const propAny = prop as { getDecorators?: () => Decorator[]; getType?: () => { getText: () => string } };
        const decorators = propAny.getDecorators?.() ?? [];
        if (decorators.length === 0) continue;

        const decByName = new Map<string, Decorator>();
        for (const d of decorators) decByName.set(d.getName(), d);

        const isPk =
          decByName.has("PrimaryGeneratedColumn") || decByName.has("PrimaryColumn");
        const isAutoInc = decByName.has("PrimaryGeneratedColumn");

        // Relation decorators
        const relationDec =
          decByName.get("ManyToOne") ??
          decByName.get("OneToOne") ??
          undefined;

        if (relationDec) {
          // Capture target class
          const targetClass = readRelationTargetClassName(relationDec);
          if (targetClass) {
            // The actual FK column may be declared with @JoinColumn; if absent, fall back to `${propName}Id`.
            const joinDec = decByName.get("JoinColumn");
            let fkColName = `${propName}Id`;
            let refColName = "id";
            if (joinDec) {
              const props = readObjectArg(joinDec);
              if (props.name) fkColName = props.name;
              if (props.referencedColumnName) refColName = props.referencedColumnName;
            }
            // Insert a synthetic FK column (TypeORM infers FK columns from relation when not explicitly declared)
            const fkCol: ColumnIR = {
              name: fkColName,
              kind: "int",
              rawType: "int",
              nullable: relationDecIsNullable(relationDec),
              isPrimaryKey: false,
              isUnique: decByName.has("OneToOne"),
              isAutoIncrement: false,
              hasDefault: false,
            };
            pendingRelations.push({
              fromTable: tableName,
              fromColumn: fkColName,
              toClass: targetClass,
              toColumn: refColName,
            });
            // Avoid duplicate if @Column also declared on the same property (rare).
            if (!columns.find((c) => c.name === fkColName)) columns.push(fkCol);
          }
          continue; // virtual relation property itself is not a column
        }

        if (decByName.has("OneToMany")) continue; // inverse side, no column

        const colDec =
          decByName.get("Column") ??
          decByName.get("CreateDateColumn") ??
          decByName.get("UpdateDateColumn") ??
          decByName.get("DeleteDateColumn") ??
          decByName.get("PrimaryGeneratedColumn") ??
          decByName.get("PrimaryColumn");
        if (!colDec) continue;

        const colOpts = readColumnOptions(colDec);

        let kind: ScalarKind = "unknown";
        let rawType = colOpts.type ?? "";
        if (colOpts.type) {
          kind = TYPE_TO_KIND[colOpts.type.toLowerCase()] ?? "unknown";
        }
        if (kind === "unknown") {
          const tsType = propAny.getType?.().getText() ?? "";
          const baseTs = tsType.replace(/\s*\|\s*null\b/g, "").replace(/\s*\|\s*undefined\b/g, "");
          kind = TS_TO_KIND[baseTs] ?? "unknown";
          if (!rawType) rawType = baseTs;
        }
        // CreateDateColumn / UpdateDateColumn → datetime
        if (decByName.has("CreateDateColumn") || decByName.has("UpdateDateColumn")) {
          kind = "datetime";
          rawType = rawType || "timestamp";
        }
        if (decByName.has("PrimaryGeneratedColumn")) {
          if (kind === "unknown") kind = "int";
          if (!rawType) rawType = "int";
        }

        // Enum — values may be an inline array or a reference to a TS enum.
        let enumValues: string[] | undefined;
        if (colOpts.enum && colOpts.enum.length > 0) {
          kind = "enum";
          enumValues = colOpts.enum;
        } else if (colOpts.enumRef) {
          const resolved = enumRegistry.get(colOpts.enumRef);
          if (resolved && resolved.length > 0) {
            kind = "enum";
            enumValues = resolved;
          }
        }

        const col: ColumnIR = {
          name: colOpts.name ?? propName,
          kind,
          rawType: rawType || "unknown",
          nullable: colOpts.nullable ?? false,
          isPrimaryKey: isPk,
          isUnique: !!colOpts.unique,
          isAutoIncrement: isAutoInc,
          hasDefault: colOpts.hasDefault ?? false,
        };
        if (enumValues) col.enumValues = enumValues;
        if (colOpts.length !== undefined) col.maxLength = colOpts.length;

        if (kind === "unknown") {
          warnings.push(
            `${tableName}.${col.name}: could not infer type — fallback applied.`,
          );
        }

        columns.push(col);
        if (isPk) primaryKey.push(col.name);
      }

      tables.push({ name: tableName, columns, primaryKey, uniqueGroups });
    }
  }

  // Second pass: resolve pending relations against discovered class→table map.
  for (const r of pendingRelations) {
    const targetTable = classToTable.get(r.toClass);
    if (!targetTable) {
      warnings.push(
        `Relation from ${r.fromTable}.${r.fromColumn} → ${r.toClass}: target entity not found.`,
      );
      continue;
    }
    const t = tables.find((tt) => tt.name === r.fromTable);
    if (!t) continue;
    const c = t.columns.find((cc) => cc.name === r.fromColumn);
    if (!c) continue;
    const refColName = r.toColumn || "id";
    c.foreignKey = { table: targetTable, column: refColName };
    // Synthetic FK columns are created as `int` by default; align their kind with
    // the referenced PK (e.g. a uuid PK) so generated FK values match the parent type.
    const targetT = tables.find((tt) => tt.name === targetTable);
    const targetCol =
      targetT?.columns.find((cc) => cc.name === refColName) ??
      targetT?.columns.find((cc) => cc.isPrimaryKey);
    if (targetCol) {
      c.kind = targetCol.kind;
      c.rawType = targetCol.rawType;
    }
  }

  return { source: "typeorm", tables, warnings };
}

function readEntityName(cls: ClassDeclaration): string | undefined {
  const dec = cls.getDecorator("Entity");
  if (!dec) return undefined;
  const args = dec.getArguments();
  // @Entity()  → use class name
  // @Entity('table_name') → use literal
  // @Entity({ name: 'table_name' }) → read name property
  if (args.length === 0) return cls.getName();
  const first = args[0]!;
  if (first.getKind() === SyntaxKind.StringLiteral) {
    return first.getText().replace(/^['"`]|['"`]$/g, "");
  }
  if (first.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const obj = readObjectArg(dec);
    if (obj.name) return obj.name;
  }
  return cls.getName();
}

interface ColumnOpts {
  name?: string;
  type?: string;
  length?: number;
  nullable?: boolean;
  unique?: boolean;
  enum?: string[];
  enumRef?: string;
  hasDefault?: boolean;
}

function readColumnOptions(dec: Decorator): ColumnOpts {
  const args = dec.getArguments();
  const opts: ColumnOpts = {};
  if (args.length === 0) return opts;

  // @Column('varchar', { ... }) — first arg may be a string type
  let idx = 0;
  const first = args[0]!;
  if (first.getKind() === SyntaxKind.StringLiteral) {
    opts.type = first.getText().replace(/^['"`]|['"`]$/g, "");
    idx = 1;
  }
  const objArg = args[idx];
  if (objArg && objArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const parsed = readObjectArg(dec, idx);
    if (parsed.name) opts.name = parsed.name;
    if (parsed.type) opts.type = parsed.type;
    if (parsed.length !== undefined) opts.length = Number(parsed.length);
    if (parsed.nullable !== undefined) opts.nullable = parsed.nullable === "true";
    if (parsed.unique !== undefined) opts.unique = parsed.unique === "true";
    if (parsed.default !== undefined) opts.hasDefault = true;
    if (parsed.enumArr && parsed.enumArr.length > 0) {
      opts.enum = parsed.enumArr; // inline array literal: enum: ['a','b']
    } else if (parsed.enum && parsed.enum !== "1") {
      opts.enumRef = parsed.enum; // identifier reference: enum: SomeEnum
    }
  }
  return opts;
}

interface ParsedObj {
  [k: string]: string | undefined;
  // Special: when an `enum: [...]` array literal is found we stash the values here.
  enumArr?: never;
}

function readObjectArg(
  dec: Decorator,
  argIndex = 0,
): {
  name?: string;
  type?: string;
  length?: string;
  nullable?: string;
  unique?: string;
  default?: string;
  referencedColumnName?: string;
  enum?: string;
  enumArr?: string[];
} {
  const args = dec.getArguments();
  const arg = args[argIndex];
  if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) return {};
  const out: Record<string, unknown> = {};
  for (const prop of (arg as unknown as { getProperties: () => Array<{ getKindName: () => string; getName?: () => string; getInitializer?: () => { getKind: () => SyntaxKind; getText: () => string; getElements?: () => Array<{ getText: () => string }> } }> }).getProperties()) {
    if (prop.getKindName() !== "PropertyAssignment") continue;
    const name = prop.getName?.();
    const init = prop.getInitializer?.();
    if (!name || !init) continue;
    if (init.getKind() === SyntaxKind.ArrayLiteralExpression) {
      const els = init.getElements?.() ?? [];
      out.enum = "1"; // truthy marker so caller knows enum was present
      out.enumArr = els.map((e) => e.getText().replace(/^['"`]|['"`]$/g, ""));
    } else {
      out[name] = init.getText().replace(/^['"`]|['"`]$/g, "");
    }
  }
  return out as ReturnType<typeof readObjectArg>;
}

function readStringArrayArg(dec: Decorator): string[] {
  const args = dec.getArguments();
  for (const a of args) {
    if (a.getKind() === SyntaxKind.ArrayLiteralExpression) {
      const els = (a as unknown as { getElements: () => Array<{ getText: () => string }> }).getElements();
      return els.map((e) => e.getText().replace(/^['"`]|['"`]$/g, ""));
    }
  }
  return [];
}

function readRelationTargetClassName(dec: Decorator): string | undefined {
  // @ManyToOne(() => Foo, …) — first arg is an arrow function returning the class.
  const args = dec.getArguments();
  if (args.length === 0) return undefined;
  const text = args[0]!.getText();
  // Match patterns like `() => Foo` or `type => Foo`
  const m = text.match(/=>\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (m) return m[1];
  // Could also be just `Foo` (string class reference)
  const ident = text.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
  return ident?.[1];
}

function relationDecIsNullable(dec: Decorator): boolean {
  const args = dec.getArguments();
  for (const a of args) {
    if (a.getKind() === SyntaxKind.ObjectLiteralExpression) {
      const t = a.getText();
      if (/nullable\s*:\s*true/.test(t)) return true;
      if (/nullable\s*:\s*false/.test(t)) return false;
    }
  }
  // TypeORM @ManyToOne / @OneToOne relations are nullable unless explicitly
  // marked { nullable: false }. Defaulting to nullable also lets the engine break
  // otherwise-"hard" FK cycles on these edges.
  return true;
}

// Helper exported only for the detector module.
export function defaultTypeOrmGlobs(cwd: string): string[] {
  return [
    path.join(cwd, "src/**/*.entity.ts"),
    path.join(cwd, "src/entity/**/*.ts"),
    path.join(cwd, "src/entities/**/*.ts"),
    path.join(cwd, "entities/**/*.ts"),
  ];
}
