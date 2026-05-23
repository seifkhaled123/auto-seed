import { describe, it, expect, vi } from "vitest";
import { generatePlan } from "../src/plan/generatePlan.js";
import type { LLMProvider, LLMResponse } from "../src/llm/provider.js";
import { SeedPlan } from "../src/plan/schema.js";
import type { SchemaIR } from "../src/ir/types.js";
import { parseRowsSpec, resolveRowCount } from "../src/util/rows.js";
import { CLIError } from "../src/util/errors.js";

const VALID_PLAN = {
  version: 1,
  generationOrder: ["users", "posts"],
  tables: [
    {
      table: "users",
      rowCount: 5,
      columns: [
        { column: "id", strategy: { type: "sequence", start: 1 } },
        { column: "email", strategy: { type: "faker", method: "internet.email" } },
        { column: "name", strategy: { type: "faker", method: "person.fullName" } },
      ],
    },
    {
      table: "posts",
      rowCount: 10,
      columns: [
        { column: "id", strategy: { type: "sequence", start: 1 } },
        { column: "title", strategy: { type: "faker", method: "lorem.sentence" } },
        {
          column: "user_id",
          strategy: { type: "reference", table: "users", column: "id", distribution: "uniform" },
        },
      ],
    },
  ],
};

const FAKE_IR: SchemaIR = {
  source: "sql",
  dialect: "postgresql",
  tables: [
    {
      name: "users",
      primaryKey: ["id"],
      uniqueGroups: [],
      columns: [
        { name: "id", kind: "int", rawType: "serial", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
        { name: "email", kind: "string", rawType: "varchar", nullable: false, isPrimaryKey: false, isUnique: true, isAutoIncrement: false, hasDefault: false },
        { name: "name", kind: "string", rawType: "varchar", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false },
      ],
    },
  ],
  warnings: [],
};

function makeProvider(responses: unknown[]): LLMProvider {
  const queue = [...responses];
  return {
    name: "anthropic",
    model: "claude-haiku-4-5-20251001",
    async generateJSON(): Promise<LLMResponse> {
      const next = queue.shift();
      if (next === undefined) throw new Error("Mock LLM ran out of canned responses");
      return {
        json: next,
        raw: JSON.stringify(next),
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  };
}

describe("Seed Plan zod schema", () => {
  it("accepts a well-formed plan", () => {
    const r = SeedPlan.safeParse(VALID_PLAN);
    expect(r.success).toBe(true);
  });

  it("rejects an invalid strategy", () => {
    const bad = {
      ...VALID_PLAN,
      tables: [{ table: "x", rowCount: 1, columns: [{ column: "y", strategy: { type: "nope" } }] }],
    };
    const r = SeedPlan.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("requires version === 1", () => {
    const r = SeedPlan.safeParse({ ...VALID_PLAN, version: 2 });
    expect(r.success).toBe(false);
  });
});

describe("generatePlan", () => {
  it("returns a valid plan on first try", async () => {
    const provider = makeProvider([VALID_PLAN]);
    const spy = vi.spyOn(provider, "generateJSON");
    const out = await generatePlan(provider, { ir: FAKE_IR, rowCounts: { users: 5 }, defaultRowCount: 5 });
    expect(out.plan.tables.length).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries once when the first response fails validation", async () => {
    const provider = makeProvider([{ garbage: true }, VALID_PLAN]);
    const spy = vi.spyOn(provider, "generateJSON");
    const out = await generatePlan(provider, { ir: FAKE_IR, rowCounts: {}, defaultRowCount: 5 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out.plan.version).toBe(1);
  });

  it("surfaces a clean CLIError after two bad attempts", async () => {
    const provider = makeProvider([{ garbage: true }, { still: "bad" }]);
    await expect(
      generatePlan(provider, { ir: FAKE_IR, rowCounts: {}, defaultRowCount: 5 }),
    ).rejects.toBeInstanceOf(CLIError);
  });
});

describe("parseRowsSpec", () => {
  it("parses a bare integer as the default", () => {
    expect(parseRowsSpec("50")).toEqual({ default: 50, perTable: {} });
  });
  it("parses per-table entries", () => {
    expect(parseRowsSpec("users:25,orders:100")).toEqual({
      perTable: { users: 25, orders: 100 },
    });
  });
  it("parses a mix", () => {
    expect(parseRowsSpec("20,users:5")).toEqual({ default: 20, perTable: { users: 5 } });
  });
  it("resolveRowCount falls back to default then fallback", () => {
    const spec = parseRowsSpec("3,users:7");
    expect(resolveRowCount("users", spec)).toBe(7);
    expect(resolveRowCount("orders", spec)).toBe(3);
    expect(resolveRowCount("anything", { perTable: {} }, 99)).toBe(99);
  });
});
