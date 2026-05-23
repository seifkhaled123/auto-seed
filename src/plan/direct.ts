import { z } from "zod";
import { CLIError } from "../util/errors.js";
import type { LLMProvider } from "../llm/provider.js";
import type { SchemaIR, TableIR } from "../ir/types.js";
import type { Dataset, RowData, RowValue } from "../engine/types.js";
import { topoSort } from "../engine/topoSort.js";
import { serializeSchemaForLLM } from "./prompts.js";

export const DEFAULT_DIRECT_CAP = 200;

interface DirectModeInput {
  ir: SchemaIR;
  rowCounts: Record<string, number>;
  hint?: string;
  locale?: string;
  maxRows?: number;
  maxTokens?: number;
}

export interface DirectModeResult {
  dataset: Dataset;
  orderedTables: TableIR[];
  usage: { inputTokens: number; outputTokens: number };
}

const DIRECT_SHAPE_HINT = `Return JSON shaped as:
{ "tables": { "<tableName>": [ { "<col>": <value>, ... }, ... ] } }
- Use ONLY JSON-serializable values (strings, numbers, booleans, null).
- For dates, use ISO-8601 strings.
- Foreign-key columns MUST reference an id that you also generate in the parent table — produce parent rows first.
- Respect every NOT NULL / UNIQUE constraint and every declared enum.
`;

const DirectModeJson = z.object({
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

export async function runDirectMode(
  provider: LLMProvider,
  input: DirectModeInput,
): Promise<DirectModeResult> {
  const cap = input.maxRows ?? DEFAULT_DIRECT_CAP;
  const totalRequested = Object.values(input.rowCounts).reduce((a, b) => a + b, 0);
  if (totalRequested > cap) {
    throw new CLIError(
      `direct mode is capped at ${cap} total rows (requested ${totalRequested}).`,
      1,
      "Switch to the default plan mode (drop --mode direct) for large datasets — it scales to millions of rows for one API call.",
    );
  }

  const topo = topoSort(input.ir);
  if (topo.hardCycles.length > 0) {
    throw new CLIError(
      `Hard FK cycle detected in direct mode: ${topo.hardCycles.map((c) => c.join(" → ")).join("; ")}`,
      4,
    );
  }

  const system = `You are a database seed-data generator. You output literal rows of mock data as JSON. ${DIRECT_SHAPE_HINT}`;
  const userParts: string[] = [];
  userParts.push(serializeSchemaForLLM(input.ir));
  userParts.push("");
  userParts.push("ROW COUNTS:");
  for (const t of topo.order) userParts.push(`  ${t.name}: ${input.rowCounts[t.name] ?? 0}`);
  if (input.locale) userParts.push(`\nLOCALE: ${input.locale}`);
  if (input.hint) userParts.push(`\nDOMAIN HINT: ${input.hint}`);
  userParts.push("");
  userParts.push("Generate the dataset now as JSON only.");

  const res = await provider.generateJSON({
    system,
    user: userParts.join("\n"),
    maxTokens: input.maxTokens ?? 8000,
  });
  const parsed = DirectModeJson.safeParse(res.json);
  if (!parsed.success) {
    throw new CLIError(
      `direct mode: model returned unexpected shape.`,
      3,
      parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    );
  }

  // Coerce to Dataset and validate FK integrity at our boundary.
  const dataset: Dataset = new Map();
  for (const t of topo.order) dataset.set(t.name, []);
  for (const [tname, rows] of Object.entries(parsed.data.tables)) {
    const table = input.ir.tables.find((tt) => tt.name === tname);
    if (!table) continue;
    const coerced: RowData[] = rows.map((r) => coerceRow(r, table));
    dataset.set(tname, coerced);
  }

  // FK existence
  for (const table of topo.order) {
    const rows = dataset.get(table.name) ?? [];
    for (const col of table.columns) {
      if (!col.foreignKey) continue;
      const parentRows = dataset.get(col.foreignKey.table) ?? [];
      const parentSet = new Set(
        parentRows.map((r) => stringify(r[col.foreignKey!.column] ?? null)),
      );
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i]![col.name] ?? null;
        if (v === null) {
          if (col.nullable) continue;
          throw new CLIError(
            `direct mode: ${table.name}.${col.name} row ${i} is NULL but column is NOT NULL.`,
            4,
          );
        }
        if (!parentSet.has(stringify(v))) {
          throw new CLIError(
            `direct mode: ${table.name}.${col.name} row ${i} references missing ${col.foreignKey.table}.${col.foreignKey.column} = ${String(v)}.`,
            4,
            "Direct mode requires the model to produce relationally-consistent data. Switch to plan mode for guaranteed integrity.",
          );
        }
      }
    }
  }

  return {
    dataset,
    orderedTables: topo.order,
    usage: res.usage,
  };
}

function coerceRow(r: Record<string, unknown>, table: TableIR): RowData {
  const out: RowData = {};
  for (const col of table.columns) {
    const v = r[col.name];
    if (v === undefined || v === null) {
      out[col.name] = null;
      continue;
    }
    if (col.kind === "datetime" || col.kind === "date") {
      if (typeof v === "string") {
        const d = new Date(v);
        out[col.name] = isNaN(d.getTime()) ? v : d;
        continue;
      }
    }
    out[col.name] = v as RowValue;
  }
  return out;
}

function stringify(v: RowValue): string {
  if (v === null) return "NULL";
  if (v instanceof Date) return v.toISOString();
  return `${typeof v}:${String(v)}`;
}
