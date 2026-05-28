import { Faker } from "@faker-js/faker";
import { CLIError } from "../util/errors.js";
import { log } from "../util/logger.js";
import type { ColumnIR, SchemaIR, TableIR } from "../ir/types.js";
import type { ColumnPlan, ColumnStrategy, SeedPlan, TablePlan } from "../plan/schema.js";
import { getFaker, makeRng, type SeededRng } from "./rng.js";
import { topoSort } from "./topoSort.js";
import {
  applyStrategy,
  defaultStrategyForColumn,
  type StrategyContext,
} from "./strategies.js";
import type { Dataset, RowData, RowValue } from "./types.js";

export interface EngineInput {
  ir: SchemaIR;
  plan: SeedPlan;
  /** Per-table row count override; merged with plan's rowCount (override wins). */
  rowCounts?: Record<string, number>;
  /** Default row count for tables that have no override and no plan rowCount. */
  defaultRowCount?: number;
  /** Locale code for Faker (best-effort). */
  locale?: string;
  /** Seed for the RNG. */
  seed?: number;
}

export interface EngineOutput {
  dataset: Dataset;
  orderedTables: TableIR[];
  seed: number;
  warnings: string[];
}

const UNIQUE_RETRY_LIMIT = 50;

export function runEngine(input: EngineInput): EngineOutput {
  const { plan } = input;
  const warnings: string[] = [];
  const seed =
    input.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const rng = makeRng(seed);
  const faker: Faker = getFaker(input.locale);

  // Augment IR FK metadata using the plan's reference strategies so that
  // columns with no explicit DDL FK constraint (e.g. WordPress's link_owner)
  // still create a dependency edge in the topological sort.
  const ir = augmentIRFromPlan(input.ir, plan);

  // Engine re-derives topological order rather than trusting plan.generationOrder.
  const topo = topoSort(ir);
  if (topo.hardCycles.length > 0) {
    const desc = topo.hardCycles.map((c) => c.join(" → ")).join("; ");
    throw new CLIError(
      `Hard (non-nullable) foreign-key cycle detected: ${desc}`,
      4,
      "Make one of the FK columns nullable so the engine can break the cycle.",
    );
  }
  for (const tn of topo.cyclicNullableSides) {
    warnings.push(
      `Table "${tn}": cyclic FK detected; nullable side is filled NULL in pass 1 then backfilled.`,
    );
  }

  const planByTable = new Map<string, TablePlan>(plan.tables.map((t) => [t.table, t]));
  const dataset: Dataset = new Map();
  for (const t of topo.order) dataset.set(t.name, []);

  // Pass 1
  for (const table of topo.order) {
    const rows = generateRowsForTable({
      table,
      tablePlan: planByTable.get(table.name),
      ir,
      dataset,
      rng,
      faker,
      desiredCount: countFor(input, table.name, planByTable.get(table.name)),
      nullCyclicSide: topo.cyclicNullableSides.has(table.name),
      warnings,
    });
    dataset.set(table.name, rows);
  }

  // Pass 2: backfill any column we left NULL because of a cycle, in tables flagged as cyclic-nullable.
  if (topo.cyclicNullableSides.size > 0) {
    for (const tn of topo.cyclicNullableSides) {
      const table = ir.tables.find((t) => t.name === tn)!;
      const rows = dataset.get(tn)!;
      backfillCyclicNulls({ table, ir, dataset, rng, faker, rows, tablePlan: planByTable.get(tn), warnings });
    }
  }

  // Integrity sweep
  validateIntegrity(ir, dataset);

  return { dataset, orderedTables: topo.order, seed, warnings };
}

function countFor(input: EngineInput, name: string, tablePlan?: TablePlan): number {
  if (input.rowCounts && input.rowCounts[name] !== undefined) return input.rowCounts[name]!;
  if (tablePlan) return tablePlan.rowCount;
  return input.defaultRowCount ?? 10;
}

interface GenInput {
  table: TableIR;
  tablePlan?: TablePlan;
  ir: SchemaIR;
  dataset: Dataset;
  rng: SeededRng;
  faker: Faker;
  desiredCount: number;
  nullCyclicSide: boolean;
  warnings: string[];
}

function generateRowsForTable(g: GenInput): RowData[] {
  const { table, tablePlan, ir, dataset, rng, faker, nullCyclicSide, warnings } = g;
  const planByCol = new Map<string, ColumnPlan>(
    (tablePlan?.columns ?? []).map((c) => [c.column, c]),
  );

  // Build column processing order: PK first → FK next → scalars last.
  const ordered = orderColumns(table);

  // Track uniqueness sets (single + composite).
  const uniqueSingles = new Map<string, Set<string>>();
  for (const c of table.columns) if (c.isUnique && !c.isPrimaryKey) uniqueSingles.set(c.name, new Set());
  const compositeKeys = new Set<string>();

  const rows: RowData[] = [];

  for (let i = 0; i < g.desiredCount; i++) {
    const row: RowData = {};

    for (const col of ordered) {
      const plan = planByCol.get(col.name);
      const strategy: ColumnStrategy = plan?.strategy ?? defaultStrategyForColumn(col);
      const nullRatio = plan?.nullRatio ?? 0;

      // Compute value with bounded retries when the column has a unique constraint.
      const value = produceValue({
        col,
        strategy,
        nullRatio,
        rowIndex: i,
        rng,
        faker,
        ir,
        dataset,
        table,
        thisRowSoFar: row,
        uniqueSingles,
        nullCyclicSide,
        warnings,
      });

      row[col.name] = value;
    }

    // Composite uniques (including a composite PK with >1 columns).
    const compositeConstraints: string[][] = [
      ...(table.primaryKey.length > 1 ? [table.primaryKey] : []),
      ...table.uniqueGroups,
    ];
    if (compositeConstraints.length > 0) {
      const key = compositeKey(row, compositeConstraints);
      if (key !== null) {
        if (compositeKeys.has(key)) {
          let retries = 0;
          let curKey = key;
          while (compositeKeys.has(curKey) && retries < UNIQUE_RETRY_LIMIT) {
            for (const col of ordered) {
              const plan = planByCol.get(col.name);
              const strategy = plan?.strategy ?? defaultStrategyForColumn(col);
              row[col.name] = produceValue({
                col,
                strategy,
                nullRatio: plan?.nullRatio ?? 0,
                rowIndex: i,
                rng,
                faker,
                ir,
                dataset,
                table,
                thisRowSoFar: row,
                uniqueSingles,
                nullCyclicSide,
                warnings,
              });
            }
            const next = compositeKey(row, compositeConstraints);
            if (next === null) break;
            curKey = next;
            retries++;
          }
          if (compositeKeys.has(curKey)) {
            warnings.push(
              `${table.name}: composite uniqueness could not be satisfied for row ${i}; dropping row.`,
            );
            continue;
          }
          compositeKeys.add(curKey);
        } else {
          compositeKeys.add(key);
        }
      }
    }

    rows.push(row);
  }

  return rows;
}

function orderColumns(t: TableIR): ColumnIR[] {
  return t.columns.slice().sort((a, b) => kindRank(a) - kindRank(b) || a.name.localeCompare(b.name));
}

function kindRank(c: ColumnIR): number {
  if (c.isPrimaryKey) return 0;
  if (c.foreignKey) return 1;
  return 2;
}

interface ProduceArgs {
  col: ColumnIR;
  strategy: ColumnStrategy;
  nullRatio: number;
  rowIndex: number;
  rng: SeededRng;
  faker: Faker;
  ir: SchemaIR;
  dataset: Dataset;
  table: TableIR;
  thisRowSoFar: RowData;
  uniqueSingles: Map<string, Set<string>>;
  nullCyclicSide: boolean;
  warnings: string[];
}

function produceValue(args: ProduceArgs): RowValue {
  const { col, nullRatio, rng, dataset, ir, nullCyclicSide, warnings, table } = args;

  // If this column is the nullable side of a cyclic FK, force NULL in pass 1.
  if (
    nullCyclicSide &&
    col.foreignKey &&
    col.foreignKey.table !== table.name &&
    isCyclicEdge(ir, table.name, col.foreignKey.table) &&
    col.nullable
  ) {
    return null;
  }

  // nullRatio: roll for null first (only if column allows it).
  if (col.nullable && nullRatio > 0 && rng.random() < nullRatio) {
    return null;
  }

  // FK strategy: build a context where resolveReference uses already-emitted rows.
  const resolveReference: StrategyContext["resolveReference"] = (target, distribution) => {
    return pickFkValue(args, target, distribution);
  };

  const ctx: StrategyContext = {
    rng: args.rng,
    faker: args.faker,
    rowIndex: args.rowIndex,
    column: col,
    resolveReference,
  };

  // For FK columns where the plan didn't specify a reference strategy, force one.
  let strat = args.strategy;
  if (col.foreignKey && strat.type !== "reference" && strat.type !== "null") {
    strat = {
      type: "reference",
      table: col.foreignKey.table,
      column: col.foreignKey.column,
    };
  }

  // Unique columns: bounded retries to find a fresh value.
  const isUniqueSingle =
    col.isUnique && !col.isPrimaryKey && args.uniqueSingles.has(col.name);
  let attempts = 0;
  while (true) {
    let v: RowValue;
    try {
      v = applyStrategy(strat, ctx);
    } catch (err) {
      warnings.push(`${table.name}.${col.name}: strategy failed (${(err as Error).message}); falling back.`);
      v = applyStrategy(defaultStrategyForColumn(col), ctx);
    }

    // Coerce to the column's declared numeric kind when the strategy produced a
    // mismatched type (e.g. lorem.words fallback on a bigint column).
    v = coerceToColumnKind(v, col);

    // For string-max enforcement (best effort)
    if (typeof v === "string" && col.maxLength && v.length > col.maxLength) {
      v = v.slice(0, col.maxLength);
    }

    if (isUniqueSingle) {
      const key = serializeForUnique(v);
      const set = args.uniqueSingles.get(col.name)!;
      if (!set.has(key)) {
        set.add(key);
        return v;
      }
      attempts++;
      if (attempts >= UNIQUE_RETRY_LIMIT) {
        // Suffix-disambiguate strings; otherwise warn and accept the duplicate.
        if (typeof v === "string") {
          let disamb = `${v}_${set.size}`;
          if (col.maxLength) disamb = disamb.slice(0, col.maxLength);
          set.add(disamb);
          return disamb;
        }
        warnings.push(
          `${table.name}.${col.name}: could not find unique value after ${UNIQUE_RETRY_LIMIT} retries.`,
        );
        return v;
      }
      continue;
    }
    return v;
  }
}

function pickFkValue(
  args: ProduceArgs,
  target: { table: string; column: string },
  distribution?: "uniform" | "weighted",
): RowValue {
  // Self-reference: pick from rows already emitted within this table, or NULL if nullable.
  if (target.table === args.table.name) {
    const emitted = args.dataset.get(args.table.name) ?? [];
    if (emitted.length === 0) {
      return args.col.nullable ? null : (1 as RowValue);
    }
    const row = args.rng.pick(emitted);
    return (row[target.column] ?? null) as RowValue;
  }
  const parentRows = args.dataset.get(target.table) ?? [];
  if (parentRows.length === 0) {
    if (args.col.nullable) return null;
    throw new CLIError(
      `Cannot satisfy FK ${args.table.name}.${args.col.name} → ${target.table}.${target.column}: no parent rows generated.`,
      4,
      "Ensure the parent table has at least 1 row in --rows.",
    );
  }
  // "weighted" without explicit weights just degrades to uniform in our engine.
  void distribution;
  const row = args.rng.pick(parentRows);
  return (row[target.column] ?? null) as RowValue;
}

function isCyclicEdge(ir: SchemaIR, from: string, to: string): boolean {
  // True if there's any path back from `to` to `from` through FKs.
  const byName = new Map(ir.tables.map((t) => [t.name, t]));
  const visited = new Set<string>();
  const stack: string[] = [to];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === from) return true;
    if (visited.has(n)) continue;
    visited.add(n);
    const t = byName.get(n);
    if (!t) continue;
    for (const c of t.columns) {
      if (c.foreignKey && c.foreignKey.table !== n) stack.push(c.foreignKey.table);
    }
  }
  return false;
}

function compositeKey(row: RowData, groups: string[][]): string | null {
  if (groups.length === 0) return null;
  const out: string[] = [];
  for (const g of groups) {
    out.push(g.map((c) => serializeForUnique(row[c] ?? null)).join(""));
  }
  return out.join("");
}

function serializeForUnique(v: RowValue): string {
  if (v === null) return " NULL";
  if (v instanceof Date) return `D:${v.toISOString()}`;
  if (typeof v === "object") return `O:${JSON.stringify(v)}`;
  return `${typeof v}:${String(v)}`;
}

interface BackfillInput {
  table: TableIR;
  ir: SchemaIR;
  dataset: Dataset;
  rng: SeededRng;
  faker: Faker;
  rows: RowData[];
  tablePlan?: TablePlan;
  warnings: string[];
}

function backfillCyclicNulls(b: BackfillInput) {
  const { table, ir, dataset, rng, faker, rows, warnings } = b;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    for (const col of table.columns) {
      if (!col.foreignKey) continue;
      if (col.foreignKey.table === table.name) continue;
      if (!isCyclicEdge(ir, table.name, col.foreignKey.table)) continue;
      if (row[col.name] !== null) continue;
      const parent = dataset.get(col.foreignKey.table) ?? [];
      if (parent.length === 0) {
        if (col.nullable) continue;
        throw new CLIError(
          `Backfill failed for ${table.name}.${col.name}: parent table empty.`,
          4,
        );
      }
      void faker;
      void b.tablePlan;
      const pRow = rng.pick(parent);
      row[col.name] = (pRow[col.foreignKey.column] ?? null) as RowValue;
    }
  }
  void warnings;
}

function validateIntegrity(ir: SchemaIR, dataset: Dataset) {
  const byName = new Map(ir.tables.map((t) => [t.name, t]));
  for (const table of ir.tables) {
    const rows = dataset.get(table.name) ?? [];
    for (const col of table.columns) {
      // NOT NULL check
      if (!col.nullable) {
        for (let i = 0; i < rows.length; i++) {
          if (rows[i]![col.name] === null || rows[i]![col.name] === undefined) {
            throw new CLIError(
              `Integrity: ${table.name}.${col.name} row ${i} is NULL but column is NOT NULL.`,
              4,
            );
          }
        }
      }
      // FK existence check
      if (col.foreignKey) {
        const parentTbl = byName.get(col.foreignKey.table);
        if (!parentTbl) continue;
        const parentVals = new Set(
          (dataset.get(col.foreignKey.table) ?? []).map((r) => serializeForUnique(r[col.foreignKey!.column] ?? null)),
        );
        for (let i = 0; i < rows.length; i++) {
          const v = rows[i]![col.name] ?? null;
          if (v === null) continue;
          if (!parentVals.has(serializeForUnique(v))) {
            throw new CLIError(
              `Integrity: ${table.name}.${col.name} row ${i} references missing ${col.foreignKey.table}.${col.foreignKey.column} = ${String(v)}.`,
              4,
            );
          }
        }
      }
    }
    // Single-unique
    for (const col of table.columns) {
      if (!col.isUnique || col.isPrimaryKey) continue;
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i]![col.name] ?? null;
        if (v === null) continue;
        const k = serializeForUnique(v);
        if (seen.has(k)) {
          throw new CLIError(
            `Integrity: ${table.name}.${col.name} has duplicate value at row ${i}.`,
            4,
          );
        }
        seen.add(k);
      }
    }
    // Composite unique
    for (const g of table.uniqueGroups) {
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const k = g.map((c) => serializeForUnique(rows[i]![c] ?? null)).join("");
        if (seen.has(k)) {
          throw new CLIError(
            `Integrity: ${table.name} composite unique (${g.join(", ")}) duplicated at row ${i}.`,
            4,
          );
        }
        seen.add(k);
      }
    }
    // PK uniqueness (single + composite)
    if (table.primaryKey.length > 0) {
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const k = table.primaryKey.map((c) => serializeForUnique(rows[i]![c] ?? null)).join("");
        if (seen.has(k)) {
          throw new CLIError(
            `Integrity: ${table.name} PK duplicated at row ${i}.`,
            4,
          );
        }
        seen.add(k);
      }
    }
  }
  log.debug("[engine] integrity check passed");
}

/**
 * Coerces a strategy-produced value to the column's declared kind when they
 * mismatch. Prevents lorem-word strings ending up in INT columns, and caps
 * MySQL INT values to the signed 32-bit range so they don't overflow on insert.
 */
function coerceToColumnKind(v: RowValue, col: ColumnIR): RowValue {
  if (v === null) return null;

  if (col.kind === "int" || col.kind === "bigint") {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return 0;
      const int = Math.trunc(v);
      if (col.kind === "int") return Math.max(-2_147_483_648, Math.min(2_147_483_647, int));
      return int;
    }
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? 0 : n;
    }
    return 0;
  }

  if (col.kind === "float" || col.kind === "decimal") {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "string") {
      const n = parseFloat(v);
      return Number.isNaN(n) ? 0 : n;
    }
    if (typeof v === "boolean") return v ? 1 : 0;
    return 0;
  }

  return v;
}

/**
 * Returns a shallow copy of the IR with FK metadata added to any column whose
 * plan uses a `reference` strategy but whose DDL carried no explicit FK constraint.
 * This lets topoSort see the dependency and order tables correctly.
 */
function augmentIRFromPlan(ir: SchemaIR, plan: SeedPlan): SchemaIR {
  const knownTables = new Set(ir.tables.map((t) => t.name));
  const planByTable = new Map(plan.tables.map((t) => [t.table, t]));

  const tables = ir.tables.map((table) => {
    const tablePlan = planByTable.get(table.name);
    if (!tablePlan) return table;

    let changed = false;
    const columns = table.columns.map((col) => {
      if (col.foreignKey) return col; // DDL FK already present
      const colPlan = tablePlan.columns.find((cp) => cp.column === col.name);
      if (!colPlan || colPlan.strategy.type !== "reference") return col;
      const ref = colPlan.strategy;
      if (!knownTables.has(ref.table)) return col; // referenced table not in schema
      changed = true;
      return { ...col, foreignKey: { table: ref.table, column: ref.column } };
    });

    return changed ? { ...table, columns } : table;
  });

  return { ...ir, tables };
}
