import { describe, it, expect } from "vitest";
import { runEngine } from "../src/engine/generate.js";
import { topoSort } from "../src/engine/topoSort.js";
import type { SchemaIR } from "../src/ir/types.js";
import type { SeedPlan } from "../src/plan/schema.js";
import { CLIError } from "../src/util/errors.js";

const BLOG_IR: SchemaIR = {
  source: "prisma",
  tables: [
    {
      name: "User",
      primaryKey: ["id"],
      uniqueGroups: [],
      columns: [
        { name: "id", kind: "int", rawType: "Int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
        { name: "email", kind: "string", rawType: "String", nullable: false, isPrimaryKey: false, isUnique: true, isAutoIncrement: false, hasDefault: false },
        { name: "name", kind: "string", rawType: "String", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false },
      ],
    },
    {
      name: "Post",
      primaryKey: ["id"],
      uniqueGroups: [],
      columns: [
        { name: "id", kind: "int", rawType: "Int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
        { name: "title", kind: "string", rawType: "String", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false },
        { name: "authorId", kind: "int", rawType: "Int", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false, foreignKey: { table: "User", column: "id" } },
      ],
    },
  ],
  warnings: [],
};

const BLOG_PLAN: SeedPlan = {
  version: 1,
  generationOrder: ["User", "Post"],
  tables: [
    {
      table: "User",
      rowCount: 5,
      columns: [
        { column: "id", strategy: { type: "sequence", start: 1 } },
        { column: "email", strategy: { type: "faker", method: "internet.email" } },
        { column: "name", strategy: { type: "faker", method: "person.fullName" } },
      ],
    },
    {
      table: "Post",
      rowCount: 12,
      columns: [
        { column: "id", strategy: { type: "sequence", start: 1 } },
        { column: "title", strategy: { type: "faker", method: "lorem.sentence" } },
        { column: "authorId", strategy: { type: "reference", table: "User", column: "id" } },
      ],
    },
  ],
};

describe("topoSort", () => {
  it("orders dependencies parent → child", () => {
    const t = topoSort(BLOG_IR);
    expect(t.order.map((x) => x.name)).toEqual(["User", "Post"]);
    expect(t.hardCycles).toEqual([]);
  });

  it("detects hard cycles (non-nullable)", () => {
    const ir: SchemaIR = {
      source: "sql",
      tables: [
        { name: "A", primaryKey: ["id"], uniqueGroups: [], columns: [
          { name: "id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
          { name: "b_id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false, foreignKey: { table: "B", column: "id" } },
        ] },
        { name: "B", primaryKey: ["id"], uniqueGroups: [], columns: [
          { name: "id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
          { name: "a_id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false, foreignKey: { table: "A", column: "id" } },
        ] },
      ],
      warnings: [],
    };
    const t = topoSort(ir);
    expect(t.hardCycles.length).toBeGreaterThan(0);
  });

  it("breaks soft cycles on a nullable edge", () => {
    const ir: SchemaIR = {
      source: "sql",
      tables: [
        { name: "A", primaryKey: ["id"], uniqueGroups: [], columns: [
          { name: "id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
          { name: "b_id", kind: "int", rawType: "int", nullable: true, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false, foreignKey: { table: "B", column: "id" } },
        ] },
        { name: "B", primaryKey: ["id"], uniqueGroups: [], columns: [
          { name: "id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
          { name: "a_id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false, foreignKey: { table: "A", column: "id" } },
        ] },
      ],
      warnings: [],
    };
    const t = topoSort(ir);
    expect(t.hardCycles).toEqual([]);
    expect(t.cyclicNullableSides.has("A")).toBe(true);
  });
});

describe("runEngine", () => {
  it("emits relationally-correct rows for the blog schema", () => {
    const out = runEngine({ ir: BLOG_IR, plan: BLOG_PLAN, seed: 42 });
    const users = out.dataset.get("User")!;
    const posts = out.dataset.get("Post")!;
    expect(users).toHaveLength(5);
    expect(posts).toHaveLength(12);

    const userIds = new Set(users.map((r) => r.id));
    for (const p of posts) {
      expect(userIds.has(p.authorId as number)).toBe(true);
    }

    // Unique constraint on User.email
    const emails = users.map((r) => r.email);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("is deterministic for the same seed", () => {
    const a = runEngine({ ir: BLOG_IR, plan: BLOG_PLAN, seed: 7 });
    const b = runEngine({ ir: BLOG_IR, plan: BLOG_PLAN, seed: 7 });
    const stringify = (m: Map<string, unknown[]>) =>
      JSON.stringify([...m.entries()].map(([k, v]) => [k, v]), (_k, val) => (typeof val === "bigint" ? String(val) : val));
    expect(stringify(a.dataset)).toBe(stringify(b.dataset));
  });

  it("respects rowCounts override", () => {
    const out = runEngine({
      ir: BLOG_IR,
      plan: BLOG_PLAN,
      seed: 1,
      rowCounts: { User: 3, Post: 6 },
    });
    expect(out.dataset.get("User")!).toHaveLength(3);
    expect(out.dataset.get("Post")!).toHaveLength(6);
  });

  it("throws integrity error for hard cycles", () => {
    const ir: SchemaIR = {
      source: "sql",
      tables: [
        { name: "A", primaryKey: ["id"], uniqueGroups: [], columns: [
          { name: "id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
          { name: "b_id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false, foreignKey: { table: "B", column: "id" } },
        ] },
        { name: "B", primaryKey: ["id"], uniqueGroups: [], columns: [
          { name: "id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
          { name: "a_id", kind: "int", rawType: "int", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false, foreignKey: { table: "A", column: "id" } },
        ] },
      ],
      warnings: [],
    };
    const plan: SeedPlan = {
      version: 1,
      generationOrder: ["A", "B"],
      tables: [
        { table: "A", rowCount: 1, columns: [] },
        { table: "B", rowCount: 1, columns: [] },
      ],
    };
    expect(() => runEngine({ ir, plan, seed: 1 })).toThrowError(CLIError);
  });
});
