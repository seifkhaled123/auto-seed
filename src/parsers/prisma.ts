import fsp from "node:fs/promises";
import { CLIError } from "../util/errors.js";
import { ColumnIR, ScalarKind, SchemaIR, TableIR } from "../ir/types.js";

// Lazy/dynamic so users without Prisma installed can still load other parsers.
type DMMF = {
  datamodel: {
    models: PrismaModel[];
    enums: { name: string; values: { name: string }[] }[];
  };
};

interface PrismaField {
  name: string;
  kind: "scalar" | "object" | "enum";
  type: string;
  isList: boolean;
  isRequired: boolean;
  isId: boolean;
  isUnique: boolean;
  hasDefaultValue: boolean;
  default?: unknown;
  relationName?: string;
  relationFromFields?: string[];
  relationToFields?: string[];
  documentation?: string;
}

interface PrismaModel {
  name: string;
  dbName?: string | null;
  fields: PrismaField[];
  primaryKey?: { fields: string[] } | null;
  uniqueFields?: string[][];
  uniqueIndexes?: { fields: string[] }[];
}

const PRISMA_TO_KIND: Record<string, ScalarKind> = {
  String: "string",
  Int: "int",
  BigInt: "bigint",
  Float: "float",
  Decimal: "decimal",
  Boolean: "boolean",
  DateTime: "datetime",
  Json: "json",
  Bytes: "string",
};

export async function parsePrismaSchema(filePath: string): Promise<SchemaIR> {
  const datamodel = await fsp.readFile(filePath, "utf8");

  let getDMMF: (args: { datamodel: string }) => Promise<DMMF>;
  try {
    const mod = (await import("@prisma/internals")) as unknown as {
      getDMMF?: typeof getDMMF;
      default?: { getDMMF?: typeof getDMMF };
    };
    const fn = mod.getDMMF ?? mod.default?.getDMMF;
    if (!fn) throw new Error("getDMMF not exported by @prisma/internals");
    getDMMF = fn;
  } catch (err) {
    throw new CLIError(
      "Failed to load @prisma/internals — is it installed?",
      2,
      (err as Error).message,
    );
  }

  let dmmf: DMMF;
  try {
    dmmf = await getDMMF({ datamodel });
  } catch (err) {
    throw new CLIError(
      `Prisma schema parse failed: ${(err as Error).message}`,
      2,
    );
  }

  const enums = new Map(dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]));
  const warnings: string[] = [];

  const tables: TableIR[] = dmmf.datamodel.models.map((model) => {
    const tableName = model.dbName || model.name;

    // Build a map of relation virtuals so we can resolve scalar FK columns.
    const fkMap = new Map<string, { table: string; column: string }>();
    for (const f of model.fields) {
      if (
        f.kind === "object" &&
        f.relationFromFields &&
        f.relationFromFields.length > 0 &&
        f.relationToFields &&
        f.relationToFields.length > 0
      ) {
        // Map each local scalar field to its target model + column.
        f.relationFromFields.forEach((fromCol, i) => {
          const toCol = f.relationToFields![i] ?? f.relationToFields![0]!;
          // Resolve target table name (model name; we'll resolve dbName later in a 2nd pass)
          fkMap.set(fromCol, { table: f.type, column: toCol });
        });
      }
    }

    const columns: ColumnIR[] = [];
    for (const f of model.fields) {
      if (f.kind === "object") continue; // virtual relation field; not a real column
      if (f.isList && f.kind !== "enum") {
        warnings.push(`${model.name}.${f.name}: scalar list — skipped (unsupported in v1).`);
        continue;
      }

      const kind: ScalarKind =
        f.kind === "enum"
          ? "enum"
          : PRISMA_TO_KIND[f.type] ?? "unknown";

      const col: ColumnIR = {
        name: f.name,
        kind,
        rawType: f.type,
        nullable: !f.isRequired,
        isPrimaryKey: f.isId,
        isUnique: f.isUnique,
        isAutoIncrement:
          f.hasDefaultValue &&
          typeof f.default === "object" &&
          f.default !== null &&
          (f.default as { name?: string }).name === "autoincrement",
        hasDefault: f.hasDefaultValue,
      };

      if (kind === "enum") {
        col.enumValues = enums.get(f.type) ?? [];
      }
      if (kind === "string" && /uuid/i.test(String((f.default as { name?: string })?.name ?? ""))) {
        col.kind = "uuid";
      }
      const fk = fkMap.get(f.name);
      if (fk) col.foreignKey = fk;

      columns.push(col);
    }

    const primaryKey: string[] =
      model.primaryKey?.fields ?? columns.filter((c) => c.isPrimaryKey).map((c) => c.name);

    const uniqueGroupsSrc = [
      ...(model.uniqueFields ?? []),
      ...((model.uniqueIndexes ?? []).map((u) => u.fields) ?? []),
    ];
    // Dedup
    const seen = new Set<string>();
    const uniqueGroups: string[][] = [];
    for (const g of uniqueGroupsSrc) {
      const k = g.join("\0");
      if (!seen.has(k)) {
        seen.add(k);
        uniqueGroups.push(g);
      }
    }

    return { name: tableName, columns, primaryKey, uniqueGroups };
  });

  // 2nd pass: rewrite FK target model names to the model's effective table name (dbName or name).
  const modelToTable = new Map<string, string>();
  for (const m of dmmf.datamodel.models) {
    modelToTable.set(m.name, m.dbName || m.name);
  }
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.foreignKey) {
        const target = modelToTable.get(c.foreignKey.table);
        if (target) c.foreignKey.table = target;
      }
    }
  }

  return {
    source: "prisma",
    tables,
    warnings,
  };
}
