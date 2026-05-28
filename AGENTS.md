# AGENTS.md

Working notes for `auto-seed` — a CLI that generates realistic, relationally-accurate
database seed data from a schema (Prisma / SQL DDL / TypeORM) using an LLM to design a
"Seed Plan" and a local deterministic engine to render rows.

## Build / run / test

- Build: `bun run build` (tsup → `dist/index.js`). Run after every change.
- Dev (no build): `bun run dev -- <args>` or `bun run dev -- <args>` (tsx runs `src/index.ts`).
- Typecheck: `bun run typecheck`. Tests: `bun run test` (vitest).
- Manual run: `bun run dev generate --schema <path> --dialect <mysql|postgresql|sqlite> --out <path> [--hint "..."]`

## Pipeline (where things happen)

```
parse schema → IR → LLM builds Seed Plan → coerce/validate plan → engine renders rows → render SQL/TS
```

1. **Parsers** (`src/parsers/{sql,prisma,typeorm}.ts`) → `SchemaIR` (`src/ir/types.ts`).
   Each parser maps its native types to a `ScalarKind`. **Each parser has its OWN type map** —
   a fix in one does not propagate to the others.
2. **Prompt** (`src/plan/prompts.ts`, `src/plan/schema.ts`) — system prompt + `SEED_PLAN_SHAPE_HINT`.
   **Shared by all DDL types** (prompt is built from the IR, not the source format).
3. **LLM call** (`src/llm/*`, `src/plan/generatePlan.ts`).
4. **Plan coercion + validation** (`src/plan/generatePlan.ts`) — `coerceRawPlan`, Zod `SeedPlan`.
   **Shared by all DDL types.**
5. **Engine** (`src/engine/*`) — topo sort, strategy application, type coercion.
   **Shared by all DDL types.**
6. **Render** (`src/render/{sql,typescript}.ts`) — format-specific output.

### IMPORTANT: shared vs. parser-specific changes

Anything from step 2 onward is **downstream of parsing** and applies to every DDL type
automatically. Only the **parsers (step 1)** and **renderers (step 6)** are format-specific.
When fixing a parser type-map bug, check whether the OTHER parsers have the same gap:
- SQL parser uses substring matching (`x.includes("text")`).
- TypeORM parser uses an exact-match `TYPE_TO_KIND` record — keep it in sync with SQL.
- Prisma parser uses Prisma scalar types from DMMF (`String`, `Int`, ...) — a closed set;
  DB-native names like `@db.LongText` never reach it, so it does NOT need DB-type variants.

---

## Issues we ran into (and how they're handled)

### Faker v10 method-name drift (LLM hallucination)
The LLM emits Faker v8/v9 names (`datatype.number`, `internet.userName`, `random.alphaNumeric`,
`image.imageUrl`, `name.*`, `address.*`, `internet.rss`, `internet.imageUrl`, etc.). Faker v10
renamed/removed these, so the engine threw "method not found" and fell back to junk.
- Fix: `FAKER_V9_TO_V10` coercion table in `src/engine/strategies.ts` (`callFaker` rewrites the
  name before lookup). Also called out the common renames in the system prompt (`src/plan/schema.ts`).
- When you see a new "Faker method not found: X" warning, add `X → <v10 name>` to that table.

### Invalid strategy `type` from the LLM
LLM returned strategy objects whose `type` isn't in the Zod union (e.g. `autoincrement`, `text`,
`email`, `url`). Retry produced the same garbage; generation failed with vague "Invalid input".
- Fix: layered coercion in `coerceRawPlan` (`src/plan/generatePlan.ts`):
  `STRATEGY_COERCIONS` (known bad type → valid), malformed-but-valid-type → `FALLBACK_STRATEGY`,
  unknown type → `FALLBACK_STRATEGY`.

### Column-name semantic overrides
LLM picks lorem text / unbounded numbers for columns with well-known meaning.
- `COL_NAME_ALWAYS` (in `generatePlan.ts`): unconditionally forces `0` for counter/order columns
  (`term_group`, `menu_order`, `comment_karma`, `comment_count`, `link_rating`, `term_order`).
- `COL_NAME_LOREM`: fires only when the LLM fell back to `lorem.*`, substitutes the right enum/faker
  method (`link_target`, `link_rel`, `comment_type`, `post_mime_type`, `taxonomy`, `user_pass`,
  `user_activation_key`, `*_agent`).

**Over-fitting guard — read before editing `COL_NAME_ALWAYS`.** This table matches by exact column
name and fires *unconditionally*, so it must only contain names distinctive enough that they cannot
mean something else in an unrelated schema. We removed `user_status` and `count` from it because a
future user's schema could legitimately use those for meaningful values, and forcing `0` would
silently corrupt them. Integer overflow for such columns is already handled safely by
`coerceToColumnKind` (caps to signed 32-bit). Rule of thumb: CMS-distinctive names (`term_group`,
`comment_karma`) are safe here; generic names (`count`, `status`, `type`, `order`) are NOT — put
those in `COL_NAME_LOREM` (no-op unless the LLM already failed) or leave them to the engine.

### Generalization vs. over-fitting (whole codebase)
Everything downstream of parsing (Faker coercion, `STRATEGY_COERCIONS`, `coerceToColumnKind`,
`augmentIRFromPlan`, DATETIME formatting, dialect handling) is schema-agnostic and applies to any
future schema. The only WordPress/CMS-fitted parts are the `COL_NAME_*` tables (exact name match)
and the *examples* in the system prompt. Those are inert for unrelated schemas — except the
`COL_NAME_ALWAYS` over-fit risk noted above. When adding schema-specific knowledge, prefer
`COL_NAME_LOREM` (conditional, safe) over `COL_NAME_ALWAYS` (unconditional, risky).

### Value type mismatch vs. column kind
A string strategy on an INT column wrote lorem words into an integer field; large `number.int`
overflowed MySQL signed INT.
- Fix: `coerceToColumnKind` in `src/engine/generate.ts` runs on every produced value — parses
  strings to numbers, caps `int` to signed 32-bit (±2,147,483,647), coerces float/decimal.

### FK ordering for implicit (DDL-less) relationships
MySQL schemas often omit explicit `FOREIGN KEY` constraints (e.g. `wp_links.link_owner`). The IR
then has no `foreignKey`, so `topoSort` scheduled the child before the parent → "no parent rows".
- Fix: `augmentIRFromPlan` in `src/engine/generate.ts` — adds FK metadata from the plan's
  `reference` strategies before topo sort, so plan-discovered relationships create edges.
- Note: the engine **re-derives** topo order from FK metadata and **ignores** `plan.generationOrder`.

### MySQL DATETIME format
`Date.toISOString()` produced `'2025-12-16T13:43:32.614Z'` which MySQL DATETIME rejects.
- Fix: `formatSqlDatetime` in `src/render/sql.ts` → `'YYYY-MM-DD HH:MM:SS'` (UTC, no ms/T/Z).
- The TS renderer (`render/typescript.ts`) correctly keeps `new Date(iso)` — JS, not SQL.

### SQL text type variants → fallback
`longtext`/`mediumtext`/`tinytext` mapped to `unknown` because the check was `x === "text"`.
- Fix in `src/parsers/sql.ts`: `x.includes("text")`.
- Same gap existed in `src/parsers/typeorm.ts` `TYPE_TO_KIND` (exact-match map) — added
  `tinytext`/`mediumtext`/`longtext` plus other MySQL/Postgres aliases there too.

### Ctrl+C didn't interrupt during LLM call
`ora` defaults to `discardStdin: true` (raw mode), swallowing `^C`.
- Fix in `src/commands/generate.ts`: `discardStdin: false` on both spinners + a
  `process.once("SIGINT", ...)` that stops the spinner and exits 130, removed in `finally`.

### Gemini 429 handling
Raw JSON error dumped to user; retried after 1s even on daily-quota exhaustion.
- Fix in `src/llm/gemini.ts`: `parseGeminiError` extracts the human message, `RESOURCE_EXHAUSTED`
  status (fail fast, no retry), and `RetryInfo.retryDelay` (wait that long, capped 30s, for
  transient 429/5xx).

### OpenAI/Anthropic timeout on large schemas
60s client timeout was too short for ~4k-token plans on a 12-table schema.
- Fix: bumped to 120s in `src/llm/{openai,anthropic}.ts`. (Generation latency is ~all API time;
  `engine time` is <100ms. Reuse a saved plan via `--plan-only` then `--plan <file>` to skip the LLM.)

### Model selection in `init`
Replaced manual model typing with a fetched list.
- `src/llm/list-models.ts` fetches models per provider (Anthropic `models.list`, OpenAI filtered to
  gpt/o*, Gemini `models.list()` returns `Promise<Pager>` — **must `await` before `for await`**).
- `src/commands/init.ts` shows a `p.select` with prices from `lookupPrice` (`src/util/cost.ts`),
  falling back to free-text if the fetch fails. **No provider API exposes pricing** — prices live in
  the `PRICES` table in `cost.ts`; update it when models/prices change.

---

## Known limitations (not bugs)

- **EAV / polymorphic columns** (`meta_value` keyed by `meta_key`): a single `longtext` holds
  different shapes per row. Schema metadata can't express this; only a rich `--hint` helps.
  Don't try to "fix" `meta_value` semantics generically.
- **Domain-specific vocabularies** (WordPress `option_name`, serialized `_wp_capabilities`): require
  `--hint`. The LLM is nondeterministic about honoring hints.

## Conventions

- After any code change: `bun run build` and confirm it succeeds before reporting done.
- Test fixtures live in `test/fixtures/schemas/`; scratch outputs go in `test/fixtures/test_outputs/`
  (gitignored).
- Keep `COL_NAME_*`, `STRATEGY_COERCIONS`, and `FAKER_V9_TO_V10` tables as the first place to add
  new LLM-output workarounds — prefer data-table entries over new control flow.
