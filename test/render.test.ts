import { describe, it, expect } from "vitest";
import { renderSql } from "../src/render/sql.js";
import { renderTypeScript } from "../src/render/typescript.js";
import type { SchemaIR, TableIR } from "../src/ir/types.js";
import type { Dataset } from "../src/engine/types.js";

const IR: SchemaIR = {
  source: "prisma",
  tables: [
    {
      name: "User",
      primaryKey: ["id"],
      uniqueGroups: [],
      columns: [
        { name: "id", kind: "int", rawType: "Int", nullable: false, isPrimaryKey: true, isUnique: false, isAutoIncrement: true, hasDefault: true },
        { name: "email", kind: "string", rawType: "String", nullable: false, isPrimaryKey: false, isUnique: true, isAutoIncrement: false, hasDefault: false },
        { name: "isActive", kind: "boolean", rawType: "Boolean", nullable: false, isPrimaryKey: false, isUnique: false, isAutoIncrement: false, hasDefault: false },
      ],
    },
  ],
  warnings: [],
};

const ORDERED: TableIR[] = IR.tables;

function ds(rows: Array<{ id: number; email: string; isActive: boolean }>): Dataset {
  return new Map([["User", rows]]);
}

describe("SQL renderer", () => {
  it("produces a transactional INSERT block with proper quoting", () => {
    const out = renderSql(
      IR,
      ORDERED,
      ds([
        { id: 1, email: "a@b.com", isActive: true },
        { id: 2, email: "with'apostrophe@x.com", isActive: false },
      ]),
      { dialect: "postgresql" },
    );
    expect(out).toContain("BEGIN;");
    expect(out).toContain("COMMIT;");
    expect(out).toContain(`INSERT INTO "User" ("id", "email", "isActive") VALUES`);
    expect(out).toContain("(1, 'a@b.com', TRUE)");
    expect(out).toContain("(2, 'with''apostrophe@x.com', FALSE)");
  });

  it("uses backticks for MySQL identifiers and 0/1 for booleans", () => {
    const out = renderSql(IR, ORDERED, ds([{ id: 1, email: "x", isActive: true }]), {
      dialect: "mysql",
    });
    expect(out).toContain("INSERT INTO `User` (`id`, `email`, `isActive`) VALUES");
    expect(out).toContain("(1, 'x', 1)");
  });

  it("includes a commented DELETE block", () => {
    const out = renderSql(IR, ORDERED, ds([]), { dialect: "postgresql" });
    expect(out).toContain('-- DELETE FROM "User";');
  });
});

describe("TS renderer", () => {
  it("emits Prisma createMany for prisma source", () => {
    const out = renderTypeScript(
      IR,
      ORDERED,
      ds([{ id: 1, email: "a@b.com", isActive: true }]),
    );
    expect(out).toContain("import { PrismaClient } from '@prisma/client';");
    expect(out).toContain("prisma.user.createMany({");
    expect(out).toContain('"a@b.com"');
    expect(out).toContain("isActive: true");
  });

  it("emits plain seedData export for sql source", () => {
    const out = renderTypeScript(
      { ...IR, source: "sql" as const, dialect: "postgresql" },
      ORDERED,
      ds([{ id: 1, email: "a@b.com", isActive: true }]),
    );
    expect(out).toContain("export const seedData");
    expect(out).toContain('"a@b.com"');
  });

  it("emits TypeORM insert query builder for typeorm source", () => {
    const out = renderTypeScript(
      { ...IR, source: "typeorm" as const },
      ORDERED,
      ds([{ id: 1, email: "a@b.com", isActive: true }]),
    );
    expect(out).toContain(".insert()");
    expect(out).toContain(".into(\"User\")");
  });
});
