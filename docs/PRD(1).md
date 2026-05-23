# PRD — `auto-seed` CLI

**Product:** `auto-seed` — an npm-distributed developer CLI that generates realistic, relationally-accurate database seed data directly from an existing schema.

**Status:** Draft v1 (build-ready)
**Owner:** _you_
**Intended builder:** Claude Code
**Last updated:** 2026-05-23

---

## 1. Summary

`auto-seed` eliminates the tedious chore of hand-writing dummy data for local development. A developer points the tool at their existing schema file (Prisma, SQL DDL, or TypeORM), specifies an output format and row counts, and receives a ready-to-execute `.ts` or `.sql` seed file filled with context-aware, relationally-correct mock data — in seconds.

The tool is invoked with no install step via `npx auto-seed` / `bunx auto-seed`, or installed globally. It reads a locally-configured LLM API key and uses an LLM **once per run** to design a generation strategy, then generates the actual data deterministically on the local machine.

---

## 2. Goals & Non-Goals

### 2.1 Goals
- Turn schema → runnable seed file in a single command, in seconds.
- Produce data that respects foreign keys, unique constraints, nullability, and column types.
- Support realistic, context-aware values (a `products.name` column gets product names, not `Lorem ipsum`).
- Be cheap and fast at any row count (one LLM call regardless of rows).
- Be reproducible: the same `--seed` produces identical output.
- Zero-friction: works through `npx`/`bunx`, one-time key setup.

### 2.2 Non-Goals (v1)
- Running migrations or connecting to a live database to insert data. v1 **emits a file**; it does not execute it.
- A GUI or web interface.
- Schema inference from a live DB connection (introspection). v1 reads schema **files** only.
- Drizzle, Mongoose, Sequelize, raw schema-less JSON. (Candidates for v2.)
- Multi-language output beyond `.ts` and `.sql`.

---

## 3. Confirmed Product Decisions

These were decided with the product owner and are fixed for v1:

| Decision | Choice |
|---|---|
| LLM providers | **Anthropic + OpenAI** (both supported, user-selectable) |
| Schema formats (v1) | **Prisma**, **Standard SQL DDL**, **TypeORM entities** |
| Generation strategy | **Seed Plan architecture** — see §5. Default = `plan` mode; `direct` mode optional. |
| Distribution | npm package, runnable via `npx`/`bunx`, installable globally |
| Output formats | `.ts` and `.sql` |
| Config location | `~/.auto-seed/config.json` (file perms `600`); env vars also supported |

> **Assumptions made (override if wrong):** Implementation in **Node.js (≥18) + TypeScript**, ESM, published to npm. The npm name `auto-seed` must be verified for availability before publishing — if taken, fall back to a scoped name (e.g. `@<scope>/auto-seed`) and keep the binary name `auto-seed`.

---

## 4. Target Users & Use Cases

**Primary user:** A backend or full-stack developer setting up a local environment.

**Use cases:**
1. *New clone setup* — just cloned a repo, needs the local DB populated to click around the app.
2. *Demo data* — needs believable data for a screenshot, demo, or design review.
3. *Test fixtures* — wants a deterministic dataset for integration tests (`--seed`).
4. *Load/volume sanity* — wants 50k rows to check pagination and query performance.

---

## 5. Architecture: The "Seed Plan" Model

The core insight: **LLMs are excellent at deciding _what kind_ of data a column should hold, but unreliable at producing thousands of relationally-consistent rows.** So we split responsibilities:

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 1. PARSE     │   │ 2. PLAN      │   │ 3. GENERATE  │   │ 4. RENDER    │
│ schema file  │──▶│ LLM (1 call) │──▶│ local engine │──▶│ .ts / .sql   │
│ → Schema IR  │   │ → Seed Plan  │   │ → row data   │   │ file written │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
```

### 5.1 Modes

- **`plan` mode (default).** LLM is called **once** to produce a structured JSON **Seed Plan** describing, per column, how to generate values (a Faker method, a weighted enum, a pattern, a relational reference, etc.). The local **Generation Engine** then produces all rows deterministically — handling FK ordering, uniqueness, and integrity itself. Scales to millions of rows for one cheap API call. Supports `--seed`.
- **`direct` mode (`--mode direct`).** LLM directly emits the literal rows. Used only for small datasets where per-row narrative realism matters (e.g. a handful of blog posts with coherent titles + bodies). **Hard-capped** (default cap: 200 rows total; configurable). Above the cap, the tool refuses and suggests `plan` mode.

### 5.2 Why the engine — not the LLM — owns relational integrity
Foreign keys, topological insert order, composite uniqueness, and self-referential relations are deterministic graph problems. The engine solves them exactly. The LLM never has to "remember" that `order.user_id` must match an existing `user.id` — the engine wires it.

---

## 6. CLI Specification

### 6.1 Commands

| Command | Purpose |
|---|---|
| `auto-seed init` | Interactive first-run setup: pick provider, paste API key, pick default model. |
| `auto-seed generate` | **Default command.** Generate a seed file. Runs if no subcommand given. |
| `auto-seed config set <key> <value>` | Set a config value (e.g. `provider`, `model`). |
| `auto-seed config get <key>` | Read a config value (API keys are masked). |
| `auto-seed config list` | Show all config (API keys masked). |
| `auto-seed config path` | Print the config file path. |
| `auto-seed --help` / `--version` | Standard. |

### 6.2 `generate` flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--schema <path>` | string | auto-detect | Path to schema file. If omitted, auto-detect (see §7.1). |
| `--format <ts\|sql>` | enum | `sql` | Output format. |
| `--rows <spec>` | string | `10` | Global count (`50`) or per-table (`users:20,orders:100`). |
| `--mode <plan\|direct>` | enum | `plan` | Generation mode (see §5.1). |
| `--out <path>` | string | `./seed.<ext>` | Output file path. |
| `--seed <number>` | number | random | Deterministic RNG seed. Same seed ⇒ identical output (plan mode). |
| `--tables <a,b,c>` | string | all | Restrict generation to a subset of tables. |
| `--locale <code>` | string | `en` | Faker locale (e.g. `en`, `de`, `fr`). |
| `--provider <anthropic\|openai>` | enum | from config | Override LLM provider for this run. |
| `--model <id>` | string | from config | Override model for this run. |
| `--dry-run` | bool | false | Print the Seed Plan + summary; do **not** write a file or generate rows. |
| `--plan-only` | bool | false | Write the Seed Plan JSON (to `--out` or `./seed-plan.json`); skip generation. |
| `--plan <path>` | string | — | Reuse a saved Seed Plan JSON; **skips the LLM call entirely** (free, offline). |
| `--hint <text>` | string | — | Free-text guidance passed to the LLM (e.g. "SaaS company, B2B users"). |
| `--yes` / `-y` | bool | false | Skip confirmation prompts (CI-friendly). |
| `--verbose` | bool | false | Verbose logging. |

### 6.3 Example invocations

```bash
# First-time setup
npx auto-seed init

# Simplest run — auto-detect schema, 10 rows/table, SQL output
npx auto-seed generate

# Prisma schema, TypeScript output, custom counts, deterministic
npx auto-seed generate --schema prisma/schema.prisma --format ts \
  --rows "users:25,posts:200,comments:600" --seed 42 --out prisma/seed.ts

# Preview the plan without spending tokens on generation
npx auto-seed generate --schema schema.sql --dry-run

# Save a plan once, then regenerate offline forever (no API calls)
npx auto-seed generate --plan-only --out plan.json
npx auto-seed generate --plan plan.json --rows 5000 --format sql

# Domain context for better realism
npx auto-seed generate --hint "fintech app: accounts, ledgers, transactions"
```

### 6.4 UX expectations
- Friendly spinner during the LLM call (`Designing seed plan…`), then a fast progress line for generation.
- On success: a summary table — tables, rows generated, output path, token usage / estimated cost, elapsed time.
- Clear, actionable errors (see §11). Never a raw stack trace unless `--verbose`.
- Colored output; respects `NO_COLOR`.
- Exit codes: `0` success, `1` user/config error, `2` schema parse error, `3` LLM/API error, `4` generation/integrity error.

---

## 7. Functional Requirements

### 7.1 Schema detection & parsing

**Auto-detection** (when `--schema` omitted) searches CWD and common locations in order:
`prisma/schema.prisma` → `schema.prisma` → `*.sql` / `schema.sql` / `db/schema.sql` → TypeORM entities (`src/**/*.entity.ts`, or `ormconfig`/`data-source.ts` entity globs). If multiple candidates exist, prompt the user to pick (unless `--yes`).

Each parser produces a common **Schema IR** (§9.1). Parsers required:

1. **Prisma** — parse `.prisma` into IR. Use `@prisma/internals` (`getDMMF`) for accurate model/field/relation extraction. Map scalar types, `@id`, `@unique`, `@default`, `@relation`, optionality (`?`), lists, enums.
2. **SQL DDL** — parse `CREATE TABLE` statements. Use `node-sql-parser` (configurable dialect; default `postgresql`, also support `mysql`, `sqlite`). Extract columns, types, `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `DEFAULT`, `REFERENCES` (inline and table-level `FOREIGN KEY`).
3. **TypeORM** — parse entity `.ts` files using `ts-morph`. Read decorators: `@Entity`, `@Column`, `@PrimaryGeneratedColumn`, `@PrimaryColumn`, `@ManyToOne`, `@OneToMany`, `@OneToOne`, `@JoinColumn`, `@Unique`, `nullable`, `@CreateDateColumn`/`@UpdateDateColumn`, enums.

Parser requirements:
- Resolve relations into explicit FK column → target table/column edges.
- Detect self-referential relations and many-to-many join tables.
- Surface unsupported constructs as **warnings**, not crashes (skip the column/table, tell the user).

### 7.2 Plan generation (LLM step)
- Build a compact, token-efficient representation of the Schema IR.
- Call the configured provider once with a strict system prompt (§8.2) asking for a Seed Plan as JSON only.
- Validate the response against the Seed Plan **Zod schema** (§9.2). On invalid JSON: one automatic retry with the validation error appended; if it still fails, exit code `3` with a clear message.
- The plan must cover every table/column the engine will generate. Any column missing a strategy gets a safe type-based fallback (and a warning).

### 7.3 Generation engine (deterministic, local)
- **Topological sort** tables by FK dependency. Detect cycles; for cyclic FKs, generate the nullable side first as `NULL`, then a second pass to backfill (or warn if not nullable).
- Seed a deterministic PRNG from `--seed` (default: random, but printed so a run is reproducible). Faker is seeded from the same value.
- For each table, generate `rowCount` rows:
  - **PK columns:** `sequence` (integers) or `uuid` per the plan.
  - **FK columns:** pick from the set of already-generated parent PKs, per the plan's distribution (`uniform` or `weighted`). Respect nullability.
  - **Scalar columns:** apply the plan's strategy (Faker call / enum / pattern / static / null-ratio).
  - **Unique columns:** track generated values; on collision, regenerate (bounded retries) or suffix-disambiguate; if exhaustion is detected, warn and reduce row count.
  - **Composite uniqueness:** enforce across the tuple of columns.
- Respect column data types and reasonable bounds (string length caps, numeric ranges, date ranges).
- Validate the final dataset: no dangling FKs, no unique violations, no NOT NULL nulls. Fail with exit `4` if integrity cannot be guaranteed.

### 7.4 Rendering / output
- **`.sql`**: `INSERT INTO` statements, grouped by table, in topological order, with proper value escaping/quoting for the target dialect. Wrap in a transaction (`BEGIN; … COMMIT;`). Optional `TRUNCATE`/`DELETE` preamble behind a comment the user can uncomment.
- **`.ts`**: an idiomatic, runnable seed script. For Prisma input, emit Prisma Client calls (`prisma.user.createMany(...)`) in dependency order. For TypeORM input, emit repository/`DataSource` inserts. For SQL input with `--format ts`, emit a typed array of records plus a small note (no ORM assumed). Include a header comment with generation metadata (timestamp, seed, row counts, tool version).
- Always write atomically (temp file → rename). Never overwrite without confirmation unless `--yes`.

### 7.5 `direct` mode specifics
- Send the Schema IR + counts and ask the LLM for literal rows as JSON.
- Validate against the IR (types, FK references must point to IDs the LLM also generated).
- Enforce the row cap; refuse politely above it and recommend `plan` mode.

---

## 8. LLM Integration

### 8.1 Provider abstraction
Define a single interface so providers are interchangeable:

```ts
interface LLMProvider {
  readonly name: 'anthropic' | 'openai';
  generateJSON(input: {
    system: string;
    user: string;
    maxTokens: number;
  }): Promise<{ json: unknown; usage: TokenUsage }>;
}
```

- **Anthropic** implementation uses `@anthropic-ai/sdk` (Messages API). Default model: a fast, low-cost current model (e.g. a Haiku-class model); allow overriding to a Sonnet-class model for higher quality. Exact model IDs are configurable — verify current IDs at https://docs.claude.com/en/api/overview.
- **OpenAI** implementation uses the `openai` SDK with JSON-mode / structured output. Default to a fast, low-cost model; allow overriding.
- Both implementations: timeouts, one retry with backoff on transient errors (429/5xx), and clear surfacing of auth errors.
- Resolution order for provider/model: CLI flag → config file → built-in default.

### 8.2 Prompting (plan mode)
- **System prompt** instructs the model: you are a database seed-data planner; output **only** valid JSON matching the given Seed Plan schema; choose the most realistic Faker method for each column based on its name + type; respect enums; assign sensible weights to status-like enums; never invent strategies for relational columns (the engine handles FKs) — only annotate FK distribution.
- **User message** contains the serialized Schema IR, the target row counts, the requested locale, and the optional `--hint`.
- Include the Seed Plan JSON schema (or a concise description of it) in the prompt so the model conforms.
- Keep payloads compact to control cost; large schemas may be chunked by table groups if needed (v1 may simply send all tables and rely on model context limits, with a graceful error if exceeded).

### 8.3 Cost & transparency
- After each run, print token usage and an estimated cost (best-effort; configurable price table, may be approximate).
- `--dry-run` and `--plan` (reuse) let users avoid spend entirely.

---

## 9. Data Models

### 9.1 Schema IR (parser output — common shape)

```ts
type ScalarKind =
  | 'string' | 'int' | 'bigint' | 'float' | 'decimal'
  | 'boolean' | 'datetime' | 'date' | 'uuid' | 'json' | 'enum' | 'unknown';

interface ColumnIR {
  name: string;
  kind: ScalarKind;
  rawType: string;            // original DB/ORM type
  nullable: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  isAutoIncrement: boolean;
  hasDefault: boolean;
  enumValues?: string[];      // when kind === 'enum'
  foreignKey?: { table: string; column: string };
  maxLength?: number;
}

interface TableIR {
  name: string;
  columns: ColumnIR[];
  primaryKey: string[];       // supports composite PKs
  uniqueGroups: string[][];   // composite unique constraints
}

interface SchemaIR {
  source: 'prisma' | 'sql' | 'typeorm';
  dialect?: 'postgresql' | 'mysql' | 'sqlite';
  tables: TableIR[];
  warnings: string[];
}
```

### 9.2 Seed Plan (LLM output — validated with Zod)

```ts
type ColumnStrategy =
  | { type: 'sequence'; start?: number }
  | { type: 'uuid' }
  | { type: 'faker'; method: string; args?: unknown[] }      // e.g. method: "internet.email"
  | { type: 'enum'; values: string[]; weights?: number[] }
  | { type: 'pattern'; template: string }                     // tokens: {{index}}, {{faker:...}}
  | { type: 'reference'; table: string; column: string;
      distribution?: 'uniform' | 'weighted' }
  | { type: 'static'; value: unknown }
  | { type: 'null' };

interface ColumnPlan {
  column: string;
  strategy: ColumnStrategy;
  nullRatio?: number;        // 0..1, only if column is nullable
}

interface TablePlan {
  table: string;
  rowCount: number;          // engine may override from --rows
  columns: ColumnPlan[];
}

interface SeedPlan {
  version: 1;
  generationOrder: string[]; // topological table order (engine re-verifies)
  tables: TablePlan[];
}
```

The engine treats the LLM's `generationOrder` as a hint and **re-derives** the true topological order itself.

---

## 10. Configuration & Secrets

- Config file: `~/.auto-seed/config.json`, created with file mode `600`.
- Stored keys: `provider`, `model` (per provider), `apiKeys.anthropic`, `apiKeys.openai`, `defaults` (format, rows, locale).
- **Env vars take precedence** over stored keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AUTO_SEED_PROVIDER`, `AUTO_SEED_MODEL`. Encourage env vars in CI; the file is a convenience for local dev.
- `auto-seed init` writes the file interactively. `config get`/`list` mask keys (`sk-…abcd`).
- Never log or print full API keys. Never write keys into generated seed files.
- If no key is found at run time, fail with exit `1` and tell the user to run `auto-seed init` or set the env var.

---

## 11. Error Handling & Edge Cases

| Situation | Behavior |
|---|---|
| No schema found | Exit `2`; list searched paths; suggest `--schema`. |
| Schema parse partially fails | Parse what's valid, collect `warnings`, continue; print warnings. |
| Unsupported column construct | Warn, apply type-based fallback strategy, continue. |
| Cyclic foreign keys | If a side is nullable: two-pass fill. If not: warn and null is impossible → exit `4` with explanation. |
| Self-referential FK | Generate parents first within the table; some rows reference earlier rows or `NULL`. |
| Many-to-many join table | Treated as a normal table with two FKs; generate after both parents. |
| Unique constraint exhaustion | Bounded regeneration; if impossible, reduce row count + warn. |
| LLM returns invalid JSON | One auto-retry with the error appended; then exit `3`. |
| LLM auth error / 401 | Exit `3`; tell user to re-run `init` or fix the env var. |
| Rate limit / 5xx | Retry once with backoff; then exit `3`. |
| Schema too large for context | Clear error; suggest `--tables` to scope down. |
| `direct` mode over row cap | Refuse; recommend `plan` mode. |
| Output file exists | Confirm overwrite unless `--yes`. |

---

## 12. Tech Stack & Dependencies

- **Runtime:** Node.js ≥ 18, TypeScript, ESM.
- **CLI framework:** `commander`.
- **Interactive prompts:** `@clack/prompts` (or `prompts`).
- **Validation:** `zod`.
- **Fake data:** `@faker-js/faker`.
- **Prisma parsing:** `@prisma/internals`.
- **SQL parsing:** `node-sql-parser`.
- **TypeORM parsing:** `ts-morph`.
- **LLM SDKs:** `@anthropic-ai/sdk`, `openai`.
- **Deterministic RNG:** `seedrandom` (or Faker's built-in seeding).
- **CLI polish:** `ora` (spinner), `picocolors` (color).
- **Build:** `tsup` (bundle to ESM, generate the `bin`).
- **Tests:** `vitest`.
- **Package:** `bin` field maps `auto-seed` to the built entrypoint; `engines.node >= 18`; `files` whitelist for a lean publish.

---

## 13. Suggested Project Structure

```
auto-seed/
├─ src/
│  ├─ index.ts                 # CLI entry: command/flag wiring (commander)
│  ├─ commands/
│  │  ├─ init.ts
│  │  ├─ generate.ts
│  │  └─ config.ts
│  ├─ parsers/
│  │  ├─ index.ts               # detection + dispatch → SchemaIR
│  │  ├─ prisma.ts
│  │  ├─ sql.ts
│  │  └─ typeorm.ts
│  ├─ plan/
│  │  ├─ schema.ts              # Zod schema for SeedPlan
│  │  ├─ generatePlan.ts        # builds prompt, calls LLM, validates
│  │  └─ prompts.ts             # system/user prompt templates
│  ├─ llm/
│  │  ├─ provider.ts            # LLMProvider interface
│  │  ├─ anthropic.ts
│  │  └─ openai.ts
│  ├─ engine/
│  │  ├─ topoSort.ts
│  │  ├─ generate.ts            # SeedPlan + SchemaIR → row data
│  │  └─ strategies.ts          # per-strategy value generators
│  ├─ render/
│  │  ├─ sql.ts
│  │  └─ typescript.ts
│  ├─ config/
│  │  └─ config.ts              # load/save ~/.auto-seed/config.json + env
│  └─ util/                     # logging, errors, rng, cost estimate
├─ test/                        # vitest; fixtures for each schema format
├─ package.json
├─ tsconfig.json
├─ tsup.config.ts
└─ README.md
```

---

## 14. Build Milestones

**Milestone 1 — Skeleton & config**
CLI scaffold with `commander`; `init` + `config` commands; config load/save with env override; `--help`/`--version`. Deliverable: `auto-seed init` works and stores a key.

**Milestone 2 — Parsers → Schema IR**
Implement Prisma, SQL, TypeORM parsers + auto-detection. Unit tests with fixtures. Deliverable: any supported schema parses to a correct `SchemaIR` (verified via `--dry-run` later).

**Milestone 3 — LLM layer & plan generation**
`LLMProvider` interface + Anthropic & OpenAI implementations; prompt templates; `generatePlan` with Zod validation + retry. Deliverable: `generate --dry-run` prints a valid Seed Plan.

**Milestone 4 — Generation engine**
Topological sort, deterministic RNG, all strategies, FK wiring, uniqueness/integrity validation. Deliverable: in-memory dataset that passes integrity checks.

**Milestone 5 — Renderers**
`.sql` and `.ts` renderers (Prisma / TypeORM / plain variants). Atomic file writes. Deliverable: end-to-end `generate` produces a runnable seed file.

**Milestone 6 — Polish**
`direct` mode, `--plan` reuse, `--plan-only`, cost reporting, error UX, exit codes, README. Deliverable: v1.0.0 publishable to npm.

---

## 15. Testing Strategy

- **Unit:** each parser against fixture schemas; topological sort (incl. cycles, self-refs); each generation strategy; renderer escaping/quoting.
- **Integration:** schema fixture → mocked LLM plan → engine → rendered file; assert FK validity, uniqueness, row counts, determinism (same `--seed` ⇒ byte-identical output).
- **Snapshot:** rendered `.sql`/`.ts` output for representative schemas.
- **Mocked LLM:** a fake `LLMProvider` returning canned plans, so the full pipeline is testable without API calls or spend.
- **Smoke:** generated `.sql` executes against a throwaway SQLite/Postgres in CI; generated Prisma `.ts` runs against a test schema.

---

## 16. Acceptance Criteria (v1 "done")

1. `npx auto-seed init` configures a provider + key; the key is stored at `~/.auto-seed/config.json` with `600` perms and is never printed in full.
2. `auto-seed generate` auto-detects a Prisma, SQL, or TypeORM schema in the project and produces a seed file with no other flags.
3. Generated `.sql` executes cleanly against the matching DB dialect with **zero** FK, unique, or NOT NULL violations.
4. Generated `.ts` (Prisma) runs via `tsx`/`ts-node` and inserts all rows without integrity errors.
5. `--rows users:25,posts:200` produces exactly those counts; a bare `--rows 50` applies to all tables.
6. The same `--seed` produces byte-identical output across runs.
7. Exactly **one** LLM call is made per `generate` run in `plan` mode (zero with `--plan` or `--dry-run`).
8. `--dry-run` prints the Seed Plan and a summary and writes nothing.
9. Realism check: name-like columns get name data, email columns get emails, enum columns only ever contain declared enum values.
10. All failure paths exit with the documented codes and a human-readable, non-stack-trace message.

---

## 17. Out of Scope / Future (v2+)

- Live DB introspection (read schema from a connection) and direct insertion (`--apply`).
- Drizzle, Mongoose, Sequelize support.
- Local/offline LLMs (Ollama) and additional providers (Gemini).
- A `--watch` mode that regenerates on schema change.
- Custom per-column strategy overrides via an `auto-seed.config.{ts,json}` file.
- Relationship cardinality controls (e.g. "each user has 3–8 orders").
- JSON/CSV output formats.

---

## Appendix A — Example end-to-end

**Input** (`prisma/schema.prisma`):
```prisma
model User {
  id     Int     @id @default(autoincrement())
  email  String  @unique
  name   String
  role   Role    @default(USER)
  posts  Post[]
}
model Post {
  id        Int      @id @default(autoincrement())
  title     String
  published Boolean  @default(false)
  authorId  Int
  author    User     @relation(fields: [authorId], references: [id])
}
enum Role { USER ADMIN }
```

**Command:**
```bash
npx auto-seed generate --format ts --rows "User:10,Post:40" --seed 7
```

**Expected behavior:** one LLM call returns a Seed Plan (`User.email` → `faker internet.email`, `User.name` → `faker person.fullName`, `User.role` → weighted enum `[USER, ADMIN]`, `Post.title` → `faker lorem.sentence`, `Post.published` → boolean, `Post.authorId` → `reference User.id`); engine generates 10 users then 40 posts (each `authorId` a valid user id); renderer emits a runnable Prisma seed script at `./seed.ts` with `createMany` calls in dependency order; summary prints rows, token usage, and elapsed time.
