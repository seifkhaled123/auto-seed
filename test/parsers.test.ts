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

// ---------------------------------------------------------------------------
// Real-world fixtures — stress-test corpus
// Some tests below will fail until the parsers are updated to handle the
// DDL patterns they cover (CREATE TYPE, PRAGMA, WITH ROWID STRICT, etc.)
// That is intentional: the tests define the target behaviour.
// ---------------------------------------------------------------------------

describe("SQL parser – real-world fixtures", () => {
  // --- PostgreSQL: fail today (CREATE TYPE / CREATE EXTENSION / CREATE DOMAIN) ---

  it("ecommerce.pg.sql — 25-table shop (CREATE TYPE enums, UUIDs, JSONB, closure table)", async () => {
    const ir = await parseSqlSchema(
      path.join(FIXTURES, "sql/ecommerce.pg.sql"),
      "postgresql",
    );
    expect(ir.source).toBe("sql");
    expect(ir.tables.length).toBeGreaterThanOrEqual(20);
    const names = ir.tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["products", "orders", "customers", "category_closures"]));
    const products = ir.tables.find((t) => t.name === "products")!;
    expect(products.columns.find((c) => c.name === "metadata")?.kind).toBe("json");
  });

  it("saas-platform.pg.sql — multi-tenant SaaS (partitioned events table, audit log)", async () => {
    const ir = await parseSqlSchema(
      path.join(FIXTURES, "sql/saas-platform.pg.sql"),
      "postgresql",
    );
    expect(ir.source).toBe("sql");
    expect(ir.tables.length).toBeGreaterThanOrEqual(15);
    expect(ir.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["organizations", "subscriptions", "api_keys", "audit_logs"]),
    );
  });

  it("social-media.pg.sql — social platform (PostGIS, CITEXT, tsvector, TEXT[], polymorphic)", async () => {
    const ir = await parseSqlSchema(
      path.join(FIXTURES, "sql/social-media.pg.sql"),
      "postgresql",
    );
    expect(ir.source).toBe("sql");
    expect(ir.tables.length).toBeGreaterThanOrEqual(15);
    expect(ir.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["users", "posts", "follows", "reactions"]),
    );
    const posts = ir.tables.find((t) => t.name === "posts")!;
    expect(posts.columns.find((c) => c.name === "tags")).toBeDefined();
  });

  it("healthcare-ehr.pg.sql — EHR system (CREATE DOMAIN, daterange, INHERITS, audit trigger)", async () => {
    const ir = await parseSqlSchema(
      path.join(FIXTURES, "sql/healthcare-ehr.pg.sql"),
      "postgresql",
    );
    expect(ir.source).toBe("sql");
    expect(ir.tables.length).toBeGreaterThanOrEqual(15);
    expect(ir.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["patients", "appointments", "prescriptions", "billing_claims"]),
    );
  });

  // --- MySQL: expected to succeed ---

  it("cms-wordpress.mysql.sql — WordPress 6.x (11 tables, FULLTEXT, LONGTEXT, BIGINT AUTO_INCREMENT)", async () => {
    const ir = await parseSqlSchema(
      path.join(FIXTURES, "sql/cms-wordpress.mysql.sql"),
      "mysql",
    );
    expect(ir.source).toBe("sql");
    expect(ir.tables.length).toBe(12);
    expect(ir.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["wp_users", "wp_posts", "wp_options"]),
    );

    const wpUsers = ir.tables.find((t) => t.name === "wp_users")!;
    const pk = wpUsers.columns.find((c) => c.isPrimaryKey)!;
    expect(pk.isAutoIncrement).toBe(true);
    expect(pk.kind).toBe("bigint");

    const wpUsermeta = ir.tables.find((t) => t.name === "wp_usermeta")!;
    expect(wpUsermeta.columns.find((c) => c.name === "user_id")?.foreignKey?.table).toBe("wp_users");

    const wpOptions = ir.tables.find((t) => t.name === "wp_options")!;
    expect(wpOptions.uniqueGroups).toContainEqual(["option_name"]);
  });

  it("hr-payroll.mysql.sql — HR system (15 tables, ENUM, GENERATED cols, SPATIAL, self-ref FKs)", async () => {
    const ir = await parseSqlSchema(
      path.join(FIXTURES, "sql/hr-payroll.mysql.sql"),
      "mysql",
    );
    expect(ir.source).toBe("sql");
    expect(ir.tables.length).toBe(16);

    const employees = ir.tables.find((t) => t.name === "employees")!;
    expect(employees.columns.find((c) => c.name === "manager_id")?.foreignKey?.table).toBe("employees");
    expect(employees.columns.find((c) => c.name === "department_id")?.foreignKey?.table).toBe("departments");
    expect(employees.columns.find((c) => c.name === "status")?.kind).toBe("enum");

    const departments = ir.tables.find((t) => t.name === "departments")!;
    expect(departments.columns.find((c) => c.name === "parent_id")?.foreignKey?.table).toBe("departments");
  });

  // --- SQLite: fail today (PRAGMA / VIRTUAL TABLE / WITHOUT ROWID STRICT) ---

  it("notes-app.sqlite.sql — mobile notes app (FTS5 virtual table, rtree, WITHOUT ROWID)", async () => {
    const ir = await parseSqlSchema(
      path.join(FIXTURES, "sql/notes-app.sqlite.sql"),
      "sqlite",
    );
    expect(ir.source).toBe("sql");
    expect(ir.tables.length).toBeGreaterThanOrEqual(6);
    expect(ir.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["notes", "notebooks", "attachments", "tags"]),
    );
  });

  it("iot-timeseries.sqlite.sql — IoT edge schema (WITHOUT ROWID STRICT, rtree, triggers)", async () => {
    const ir = await parseSqlSchema(
      path.join(FIXTURES, "sql/iot-timeseries.sqlite.sql"),
      "sqlite",
    );
    expect(ir.source).toBe("sql");
    expect(ir.tables.length).toBeGreaterThanOrEqual(5);
    expect(ir.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["devices", "sensors", "readings"]),
    );
  });
});

describe("Prisma parser – real-world fixtures", () => {
  it("gaming.prisma — gaming platform (18 models, composite PKs, Json defaults, clan self-ref)", async () => {
    const ir = await parsePrismaSchema(path.join(FIXTURES, "prisma/gaming.prisma"));
    expect(ir.source).toBe("prisma");
    expect(ir.tables.length).toBe(18);
    expect(ir.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["match_players", "clans", "leaderboard_entries", "players"]),
    );

    const matchPlayers = ir.tables.find((t) => t.name === "match_players")!;
    expect(matchPlayers.primaryKey.sort()).toEqual(["matchId", "playerId"]);
    expect(matchPlayers.columns.find((c) => c.name === "matchId")?.foreignKey?.table).toBe("matches");

    const players = ir.tables.find((t) => t.name === "players")!;
    expect(players.columns.find((c) => c.name === "stats")?.kind).toBe("json");

    // Self-referential FK (Clan hierarchy)
    const clans = ir.tables.find((t) => t.name === "clans")!;
    expect(clans.columns.find((c) => c.name === "parentId")?.foreignKey?.table).toBe("clans");
  });

  it("marketplace.prisma — two-sided marketplace (16 models, Decimal, Unsupported types, composite PK)", async () => {
    const ir = await parsePrismaSchema(path.join(FIXTURES, "prisma/marketplace.prisma"));
    expect(ir.source).toBe("prisma");
    expect(ir.tables.length).toBe(16);

    // 1-1 relation: SellerProfile.userId is unique FK to users
    const sellers = ir.tables.find((t) => t.name === "seller_profiles")!;
    expect(sellers.columns.find((c) => c.name === "userId")?.foreignKey?.table).toBe("users");
    expect(sellers.columns.find((c) => c.name === "userId")?.isUnique).toBe(true);

    // Decimal money column
    const transactions = ir.tables.find((t) => t.name === "transactions")!;
    expect(transactions.columns.find((c) => c.name === "amount")?.kind).toBe("decimal");

    // Composite PK on join model
    const participants = ir.tables.find((t) => t.name === "conversation_participants")!;
    expect(participants.primaryKey.sort()).toEqual(["conversationId", "userId"]);
  });

  it("nextjs-auth.prisma — Auth.js schema (@@schema multi-schema, Bytes, Unsupported, @@ignore)", async () => {
    const ir = await parsePrismaSchema(path.join(FIXTURES, "prisma/nextjs-auth.prisma"));
    expect(ir.source).toBe("prisma");
    // 13 models defined; LegacyPost has @@ignore so getDMMF excludes it → 12 tables
    expect(ir.tables.length).toBe(12);

    // Account has composite unique [provider, providerAccountId]
    const accounts = ir.tables.find((t) => t.name === "accounts")!;
    expect(accounts.uniqueGroups).toContainEqual(["provider", "providerAccountId"]);
    expect(accounts.columns.find((c) => c.name === "userId")?.foreignKey?.table).toBe("users");

    // Post has @@unique([authorId, slug])
    const posts = ir.tables.find((t) => t.name === "posts")!;
    expect(posts.uniqueGroups).toContainEqual(["authorId", "slug"]);

    // Bytes column exists (thumbnail on media)
    const media = ir.tables.find((t) => t.name === "media")!;
    expect(media.columns.find((c) => c.name === "thumbnail")).toBeDefined();
  });
});

describe("TypeORM parser – real-world fixtures", () => {
  it("nestjs-cms entities — 6 tables (@Tree, @ViewEntity skipped, ManyToMany, UUID PK)", async () => {
    const files = [
      "User.entity.ts",
      "Role.entity.ts",
      "Permission.entity.ts",
      "Category.entity.ts",
      "Post.entity.ts",
      "Tag.entity.ts",
      "PostStatsView.entity.ts", // @ViewEntity → no @Entity → skipped
    ].map((f) => path.join(FIXTURES, "typeorm/nestjs-cms", f));

    const ir = await parseTypeOrmEntities(files);
    expect(ir.source).toBe("typeorm");
    expect(ir.tables.length).toBe(6);
    expect(ir.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["users", "categories", "posts", "tags", "roles", "permissions"]),
    );

    const users = ir.tables.find((t) => t.name === "users")!;
    const id = users.columns.find((c) => c.name === "id")!;
    expect(id.kind).toBe("uuid");
    expect(id.isPrimaryKey).toBe(true);
    expect(users.uniqueGroups).toContainEqual(["email"]);

    const posts = ir.tables.find((t) => t.name === "posts")!;
    expect(posts.columns.find((c) => c.name === "author_id")?.foreignKey).toEqual({ table: "users", column: "id" });
    expect(posts.columns.find((c) => c.name === "category_id")?.foreignKey?.table).toBe("categories");
  });

  it("fintech entities — 9 tables (dual FKs to same table, OneToOne, VersionColumn, simple-json)", async () => {
    const files = [
      "Customer.entity.ts",
      "KycRecord.entity.ts",
      "Account.entity.ts",
      "Card.entity.ts",
      "Transaction.entity.ts",
      "Transfer.entity.ts",
      "Beneficiary.entity.ts",
      "RecurringPayment.entity.ts",
      "Notification.entity.ts",
    ].map((f) => path.join(FIXTURES, "typeorm/fintech", f));

    const ir = await parseTypeOrmEntities(files);
    expect(ir.source).toBe("typeorm");
    expect(ir.tables.length).toBe(9);

    // Account → customers FK
    const accounts = ir.tables.find((t) => t.name === "accounts")!;
    expect(accounts.columns.find((c) => c.name === "customer_id")?.foreignKey).toEqual({ table: "customers", column: "id" });

    // Transaction has TWO FKs to accounts (debit + credit sides of the ledger)
    const transactions = ir.tables.find((t) => t.name === "transactions")!;
    expect(transactions.columns.find((c) => c.name === "debit_account_id")?.foreignKey?.table).toBe("accounts");
    expect(transactions.columns.find((c) => c.name === "credit_account_id")?.foreignKey?.table).toBe("accounts");

    // KycRecord @OneToOne → customers
    const kycRecords = ir.tables.find((t) => t.name === "kyc_records")!;
    expect(kycRecords.columns.find((c) => c.name === "customer_id")?.foreignKey).toEqual({ table: "customers", column: "id" });

    // Beneficiary @Unique(["customerId", "accountNumber"])
    const beneficiaries = ir.tables.find((t) => t.name === "beneficiaries")!;
    expect(beneficiaries.uniqueGroups).toContainEqual(["customerId", "accountNumber"]);
  });
});
