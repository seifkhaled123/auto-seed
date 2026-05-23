import { Faker } from "@faker-js/faker";
import type { ColumnStrategy } from "../plan/schema.js";
import type { ColumnIR } from "../ir/types.js";
import type { RowValue } from "./types.js";
import type { SeededRng } from "./rng.js";

export interface StrategyContext {
  rng: SeededRng;
  faker: Faker;
  /** For sequence strategy: the 0-based row index within this table. */
  rowIndex: number;
  /** Column metadata, used for type-aware fallback. */
  column: ColumnIR;
  /** Resolver that picks a valid FK value from already-emitted parent rows. */
  resolveReference: (target: { table: string; column: string }, distribution?: "uniform" | "weighted") => RowValue;
}

/**
 * Resolves and applies a strategy. Caller handles nullRatio + uniqueness retries.
 */
export function applyStrategy(strategy: ColumnStrategy, ctx: StrategyContext): RowValue {
  switch (strategy.type) {
    case "sequence":
      return (strategy.start ?? 1) + ctx.rowIndex;
    case "uuid":
      return ctx.faker.string.uuid();
    case "faker":
      return callFaker(ctx.faker, strategy.method, strategy.args);
    case "enum":
      if (strategy.weights && strategy.weights.length === strategy.values.length) {
        return ctx.rng.pickWeighted(strategy.values, strategy.weights);
      }
      return ctx.rng.pick(strategy.values);
    case "pattern":
      return renderPattern(strategy.template, ctx);
    case "reference":
      return ctx.resolveReference(
        { table: strategy.table, column: strategy.column },
        strategy.distribution,
      );
    case "static":
      return strategy.value as RowValue;
    case "null":
      return null;
  }
}

/**
 * Type-aware fallback when the plan omits a strategy for some column.
 * Mirrors the PRD §7.2 requirement that *every* column gets *some* strategy.
 */
export function defaultStrategyForColumn(col: ColumnIR): ColumnStrategy {
  if (col.isAutoIncrement || col.kind === "int" || col.kind === "bigint") {
    return { type: "sequence", start: 1 };
  }
  if (col.kind === "uuid") return { type: "uuid" };
  if (col.kind === "enum" && col.enumValues && col.enumValues.length > 0) {
    return { type: "enum", values: col.enumValues };
  }
  if (col.kind === "boolean") return { type: "faker", method: "datatype.boolean" };
  if (col.kind === "datetime") return { type: "faker", method: "date.recent" };
  if (col.kind === "date") return { type: "faker", method: "date.recent" };
  if (col.kind === "float" || col.kind === "decimal") {
    return { type: "faker", method: "number.float", args: [{ min: 0, max: 1000, fractionDigits: 2 }] };
  }
  if (col.kind === "json") return { type: "static", value: {} };
  // string + unknown
  return { type: "faker", method: "lorem.words", args: [3] };
}

function callFaker(faker: Faker, dotted: string, args?: unknown[]): RowValue {
  const path = dotted.split(".");
  let cur: unknown = faker;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    cur = (cur as Record<string, unknown>)?.[k];
    if (cur === undefined) {
      throw new Error(`Faker namespace not found: ${dotted}`);
    }
  }
  const fnName = path[path.length - 1]!;
  const fn = (cur as Record<string, unknown>)[fnName];
  if (typeof fn !== "function") {
    throw new Error(`Faker method not found: ${dotted}`);
  }
  const a = args && args.length > 0 ? args : [];
  const v = (fn as (...x: unknown[]) => unknown).apply(cur, a);
  return v as RowValue;
}

function renderPattern(template: string, ctx: StrategyContext): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, token) => {
    const t = String(token).trim();
    if (t === "index") return String(ctx.rowIndex);
    const fak = t.match(/^faker:(.+)$/);
    if (fak) {
      const v = callFaker(ctx.faker, fak[1]!.trim());
      return String(v);
    }
    return _m; // leave unknown tokens as-is
  });
}
