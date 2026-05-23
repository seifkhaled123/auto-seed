# auto-seed

> Generate realistic, relationally-accurate database seed data directly from your existing schema — in one command.

`auto-seed` reads your schema (Prisma, SQL DDL, or TypeORM entities), asks an LLM **once** to design a generation strategy, then locally produces a ready-to-run `.ts` or `.sql` seed file filled with realistic, type-aware, relationally-correct mock data.

- **One LLM call per run.** Faker handles the rows. Scales to millions of rows for the cost of one short API call.
- **Reproducible.** `--seed N` produces byte-identical output every time.
- **Zero-install.** `npx auto-seed` or `bunx auto-seed`.
- **Schemas in:** Prisma `.prisma` · SQL `CREATE TABLE` DDL · TypeORM `.entity.ts`
- **Files out:** `.sql` (transactional `INSERT`s) · `.ts` (Prisma `createMany` / TypeORM insert / typed dataset)

---

## Quick start

```bash
# 1) Configure your LLM key (one-time)
npx auto-seed init

# 2) From inside your project (Prisma / SQL / TypeORM autodetected)
npx auto-seed generate
```

The first command opens an interactive prompt to pick a provider (Anthropic, OpenAI, or Google Gemini), paste a key, and choose a default model. The key is stored at `~/.auto-seed/config.json` with `0600` permissions and is masked on display.

The second command:

1. Finds your schema (`prisma/schema.prisma`, `schema.sql`, `src/**/*.entity.ts`, …).
2. Calls the LLM once to design a per-column generation strategy.
3. Generates rows locally with `@faker-js/faker`, respecting FKs / uniques / NOT NULL.
4. Writes `./seed.sql` (or `./seed.ts`) and prints a summary.

---

## Common flags

| Flag | Default | Description |
|---|---|---|
| `--schema <path>` | auto-detect | Path to your schema file. |
| `--format ts\|sql` | `sql` | Output format. |
| `--rows <spec>` | `10` | Global count (`50`) **or** per-table (`users:25,posts:200,comments:600`). |
| `--seed <n>` | random | Deterministic RNG seed. Same seed ⇒ identical output. |
| `--mode plan\|direct` | `plan` | `plan`: cheap, scales to millions. `direct`: LLM writes literal rows (≤200 by default, controlled by `--max-direct-rows`). |
| `--out <path>` | `./seed.<ext>` | Where to write the file. |
| `--tables <a,b>` | all | Generate only a subset of tables. |
| `--locale <code>` | `en` | Faker locale hint. |
| `--provider <a\|o\|g>` | from config | Override LLM provider for this run (`anthropic`, `openai`, `gemini`). |
| `--model <id>` | from config | Override LLM model for this run. |
| `--dialect <pg\|mysql\|sqlite>` | `postgresql` | SQL dialect (when input is `.sql`). |
| `--hint "<text>"` | — | Free-text domain hint (e.g. "fintech app: accounts, ledgers, transactions"). |
| `--dry-run` | off | Print the Seed Plan and a summary; write nothing. |
| `--plan-only` | off | Write only the Seed Plan JSON. |
| `--plan <path>` | — | Reuse a saved Seed Plan; **skips the LLM call entirely** (free, offline). |
| `--yes` / `-y` | off | Skip confirmation prompts (CI-friendly). |
| `--verbose` | off | Debug logging. |

Run `auto-seed generate --help` for the complete list.

---

## Examples

```bash
# Prisma project, TypeScript output, custom row counts, deterministic
npx auto-seed generate \
  --schema prisma/schema.prisma \
  --format ts \
  --rows "User:25,Post:200" \
  --seed 42 \
  --out prisma/seed.ts

# Preview the plan without spending tokens on row generation
npx auto-seed generate --schema schema.sql --dry-run

# Save a plan once, then regenerate offline forever (zero API calls thereafter)
npx auto-seed generate --plan-only --out plan.json
npx auto-seed generate --plan plan.json --rows 5000 --format sql

# Domain context for better realism
npx auto-seed generate --hint "fintech app: accounts, ledgers, transactions"
```

---

## Config & secrets

`~/.auto-seed/config.json` (file mode `0600`):

```json
{
  "provider": "anthropic",
  "models": { "anthropic": "claude-haiku-4-5-20251001", "openai": "gpt-4o-mini", "gemini": "gemini-2.0-flash" },
  "apiKeys": { "anthropic": "sk-ant-…", "openai": "sk-…", "gemini": "AIza…" },
  "defaults": { "format": "sql" }
}
```

Environment variables **take precedence** over the file (recommended in CI):

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`
- `AUTO_SEED_PROVIDER` / `AUTO_SEED_MODEL`

Useful one-liners:

```bash
auto-seed config list       # All stored values, API keys masked
auto-seed config get provider
auto-seed config set defaults.format ts
auto-seed config path       # Print the config file path
```

`auto-seed` will never log a full API key and never writes a key into a generated seed file.

---

## How it works — the "Seed Plan" model

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 1. PARSE     │   │ 2. PLAN      │   │ 3. GENERATE  │   │ 4. RENDER    │
│ schema file  │──▶│ LLM (1 call) │──▶│ local engine │──▶│ .ts / .sql   │
│ → Schema IR  │   │ → Seed Plan  │   │ → row data   │   │ file written │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
```

The **Seed Plan** is a small JSON document the LLM produces once per run: per column, a strategy (Faker method, weighted enum, pattern, FK reference, …). The local generation engine then handles topological FK order, uniqueness, composite PKs, NOT NULL, and self-references — *deterministically*. The LLM never sees row volume; the engine does. Cost is bounded.

Want to peek at one?

```bash
auto-seed generate --dry-run    # prints the plan, generates nothing
auto-seed generate --plan-only  # saves the plan, generates nothing
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | User / config error (missing key, invalid flag, would overwrite without `--yes`, …) |
| `2` | Schema parse error (no schema found, parser failure) |
| `3` | LLM / API error (auth, rate limit, invalid JSON after retry) |
| `4` | Generation / integrity error (cycle without nullable FK, FK exhaustion, …) |

Errors print a single human-readable line plus an actionable hint. Use `--verbose` for stack traces.

---

## Supported schemas (v1)

- **Prisma** — `.prisma` via `@prisma/internals` `getDMMF`. Handles `@id`, `@unique`, `@@id`, `@@unique`, `@relation`, `@default`, optionality, enums.
- **SQL DDL** — `CREATE TABLE` statements via `node-sql-parser`. Dialects: `postgresql` (default), `mysql`, `sqlite`. Handles inline + table-level PK/UNIQUE/FK, `SERIAL`/`AUTO_INCREMENT`, `NOT NULL`.
- **TypeORM** — `.entity.ts` via `ts-morph`. Reads `@Entity`, `@Column`, `@PrimaryGeneratedColumn`, `@ManyToOne`/`@OneToOne`, `@JoinColumn`, `@Unique`, `@CreateDateColumn`.

Unsupported constructs degrade to a type-based fallback strategy with a warning rather than crashing.

---

## Direct mode

`--mode direct` asks the LLM to produce literal rows (great for ≤50 blog posts where narrative coherence matters). Capped at **200 total rows by default** (raise via `--max-direct-rows`). Above the cap, `auto-seed` refuses and suggests plan mode.

```bash
auto-seed generate --mode direct --rows "posts:20" --hint "fintech blog about retirement planning"
```

---

## Notes

- The npm name `auto-seed` should be verified before first publish. If taken, the package may publish as `@<scope>/auto-seed` while the binary remains `auto-seed`.
- Built-in default models: Anthropic `claude-haiku-4-5-20251001`, OpenAI `gpt-4o-mini`, Gemini `gemini-2.0-flash`. All overridable.
- Built artifact is plain ESM Node-runnable; `bun` is used for dev/test ergonomics.

## License

MIT.
