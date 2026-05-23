import { describe, it, expect } from "vitest";
import path from "node:path";
import { parsePrismaSchema } from "../src/parsers/prisma.js";
import { parseSqlSchema } from "../src/parsers/sql.js";
import { parseTypeOrmEntities } from "../src/parsers/typeorm.js";

const FIXTURES = path.resolve(__dirname, "fixtures/schemas");

describe("Prisma parser", () => {
  it("parses blog schema into a SchemaIR", async () => {
    const ir = await parsePrismaSchema(path.join(FIXTURES, "blog.prisma"));
    expect(ir.source).toBe("prisma");
    expect(ir.tables.map((t) => t.name).sort()).toEqual(["Post", "User"]);

    const user = ir.tables.find((t) => t.name === "User")!;
    const id = user.columns.find((c) => c.name === "id")!;
    expect(id.isPrimaryKey).toBe(true);
    expect(id.isAutoIncrement).toBe(true);
    expect(id.kind).toBe("int");

    const email = user.columns.find((c) => c.name === "email")!;
    expect(email.isUnique).toBe(true);
    expect(email.nullable).toBe(false);

    const role = user.columns.find((c) => c.name === "role")!;
    expect(role.kind).toBe("enum");
    expect(role.enumValues).toEqual(["USER", "ADMIN"]);

    const post = ir.tables.find((t) => t.name === "Post")!;
    const authorId = post.columns.find((c) => c.name === "authorId")!;
    expect(authorId.foreignKey).toEqual({ table: "User", column: "id" });
  });
});

describe("SQL parser", () => {
  it("parses shop.sql with PK, FKs, composite PK", async () => {
    const ir = await parseSqlSchema(path.join(FIXTURES, "shop.sql"), "postgresql");
    expect(ir.source).toBe("sql");
    expect(ir.tables.map((t) => t.name).sort()).toEqual([
      "customers",
      "order_items",
      "orders",
      "products",
    ]);

    const customers = ir.tables.find((t) => t.name === "customers")!;
    const email = customers.columns.find((c) => c.name === "email")!;
    expect(email.isUnique).toBe(true);
    expect(email.nullable).toBe(false);

    const orders = ir.tables.find((t) => t.name === "orders")!;
    const fkCol = orders.columns.find((c) => c.name === "customer_id")!;
    expect(fkCol.foreignKey).toEqual({ table: "customers", column: "id" });

    const oi = ir.tables.find((t) => t.name === "order_items")!;
    expect(oi.primaryKey.sort()).toEqual(["order_id", "product_id"]);
    const fkOrder = oi.columns.find((c) => c.name === "order_id")!;
    const fkProduct = oi.columns.find((c) => c.name === "product_id")!;
    expect(fkOrder.foreignKey).toEqual({ table: "orders", column: "id" });
    expect(fkProduct.foreignKey).toEqual({ table: "products", column: "id" });
  });

  it("recognizes SERIAL as auto-increment int", async () => {
    const ir = await parseSqlSchema(path.join(FIXTURES, "shop.sql"), "postgresql");
    const customers = ir.tables.find((t) => t.name === "customers")!;
    const id = customers.columns.find((c) => c.name === "id")!;
    expect(id.kind).toBe("int");
    expect(id.isAutoIncrement).toBe(true);
    expect(id.isPrimaryKey).toBe(true);
  });
});

describe("TypeORM parser", () => {
  it("parses entity files into IR with FK relations", async () => {
    const files = [
      path.join(FIXTURES, "typeorm/User.entity.ts"),
      path.join(FIXTURES, "typeorm/Post.entity.ts"),
    ];
    const ir = await parseTypeOrmEntities(files);
    expect(ir.source).toBe("typeorm");
    expect(ir.tables.map((t) => t.name).sort()).toEqual(["posts", "users"]);

    const users = ir.tables.find((t) => t.name === "users")!;
    const id = users.columns.find((c) => c.name === "id")!;
    expect(id.isPrimaryKey).toBe(true);
    expect(id.isAutoIncrement).toBe(true);

    // @Unique(["email"]) → uniqueGroups should contain ["email"]
    expect(users.uniqueGroups).toContainEqual(["email"]);

    const posts = ir.tables.find((t) => t.name === "posts")!;
    const authorId = posts.columns.find((c) => c.name === "author_id");
    expect(authorId).toBeDefined();
    expect(authorId!.foreignKey).toEqual({ table: "users", column: "id" });
  });
});
