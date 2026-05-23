import { describe, it, expect, vi } from "vitest";
import { runDirectMode, DEFAULT_DIRECT_CAP } from "../src/plan/direct.js";
import type { LLMProvider, LLMResponse } from "../src/llm/provider.js";
import type { SchemaIR } from "../src/ir/types.js";
import { CLIError } from "../src/util/errors.js";

const IR: SchemaIR = {
  source: "sql",
  dialect: "postgresql",
  tables: [
    {
      name: "users",
      primaryKey: ["id"],
      uniqueGroups: [],
      columns: [
        { name: "id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
        { name: "name", kind: "string", rawType: "varchar", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false },
      ],
    },
    {
      name: "posts",
      primaryKey: ["id"],
      uniqueGroups: [],
      columns: [
        { name: "id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
        { name: "user_id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false, foreignKey: { table: "users", column: "id" } },
      ],
    },
  ],
  warnings: [],
};

function mockProvider(json: unknown): LLMProvider {
  return {
    name: "anthropic",
    model: "claude-haiku-4-5-20251001",
    async generateJSON(): Promise<LLMResponse> {
      return { json, raw: JSON.stringify(json), usage: { inputTokens: 50, outputTokens: 50 } };
    },
  };
}

describe("direct mode", () => {
  it("refuses above the row cap", async () => {
    const provider = mockProvider({});
    const spy = vi.spyOn(provider, "generateJSON");
    await expect(
      runDirectMode(provider, {
        ir: IR,
        rowCounts: { users: DEFAULT_DIRECT_CAP, posts: 1 },
      }),
    ).rejects.toThrowError(/capped at \d+ total rows/);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("accepts a valid dataset and validates FKs", async () => {
    const provider = mockProvider({
      tables: {
        users: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
        ],
        posts: [
          { id: 1, user_id: 1 },
          { id: 2, user_id: 2 },
        ],
      },
    });
    const out = await runDirectMode(provider, {
      ir: IR,
      rowCounts: { users: 2, posts: 2 },
    });
    expect(out.dataset.get("users")).toHaveLength(2);
    expect(out.dataset.get("posts")).toHaveLength(2);
  });

  it("rejects a dataset with a dangling FK", async () => {
    const provider = mockProvider({
      tables: {
        users: [{ id: 1, name: "Alice" }],
        posts: [{ id: 1, user_id: 999 }],
      },
    });
    await expect(
      runDirectMode(provider, { ir: IR, rowCounts: { users: 1, posts: 1 } }),
    ).rejects.toBeInstanceOf(CLIError);
  });

  it("respects custom maxRows", async () => {
    const provider = mockProvider({ tables: { users: [], posts: [] } });
    await expect(
      runDirectMode(provider, {
        ir: IR,
        rowCounts: { users: 10, posts: 1 },
        maxRows: 5,
      }),
    ).rejects.toThrowError(/capped at 5/);
  });
});
