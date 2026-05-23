# Contributing to auto-seed

Thanks for taking the time to contribute! This document explains how to set up the project, the conventions the codebase follows, and what kinds of changes are most welcome.

## Code of conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold its terms.

## Ways to contribute

| Type | What's most useful |
|---|---|
| Bug reports | A minimal schema fixture that reproduces the issue + the exact command + the error/exit code. |
| Feature requests | An issue describing the use case before the PR. Some features are explicit non-goals (see PRD §17). |
| Parser improvements | New SQL dialects, edge cases in Prisma/TypeORM decorators. Always include a fixture. |
| Renderer improvements | Better ORM idioms, escape-edge cases, new dialect quoting. Always include a snapshot test. |
| Strategy improvements | Smarter type-based fallbacks, faker method choices for common column-name patterns. |
| Docs | Examples, troubleshooting recipes, fixture-of-the-week. |

## Project setup

Requirements:

- **Node.js ≥ 18**
- **Bun ≥ 1.0** (used for dev scripts and tests; the published artifact is plain Node-runnable ESM)
- A current Anthropic or OpenAI API key only if you want to exercise the real LLM path; the test suite uses a mocked provider.

```bash
git clone https://github.com/seif-kh/auto-seed.git
cd auto-seed
bun install
bun run typecheck     # tsc --noEmit
bun run test          # vitest
bun run build         # tsup → dist/index.js
```

Sanity-check the built CLI:

```bash
node dist/index.js --help
node dist/index.js generate --schema test/fixtures/schemas/blog.prisma --dry-run
```

## Architecture cheat-sheet

```
src/
├─ index.ts              CLI entry (commander wiring + top-level error handler)
├─ commands/             init, generate, config
├─ config/               ~/.auto-seed/config.json + env-var precedence
├─ parsers/              Prisma / SQL / TypeORM → SchemaIR
├─ ir/types.ts           common SchemaIR shape
├─ plan/                 Seed Plan zod schema, prompts, LLM call, --plan-only / --plan
├─ llm/                  LLMProvider interface + Anthropic / OpenAI implementations
├─ engine/               topo sort, seeded RNG, strategies, generation, integrity sweep
├─ render/               sql.ts (dialect-aware) and typescript.ts (Prisma/TypeORM/plain)
└─ util/                 logger, errors, paths, cost, rows-spec, atomic writeFile
```

Read [docs/PRD(1).md](docs/PRD%281%29.md) for the full design — the architecture is the "Seed Plan" model (LLM picks strategies; engine handles relational integrity locally).

## Conventions

- **TypeScript strict, ESM only.** No CommonJS. No `require`.
- **`noUncheckedIndexedAccess` is on.** `arr[i]` is `T | undefined`; handle it.
- **Errors → `CLIError`.** Top-level handler prints a single line + an optional hint and sets the exit code. Stack traces print only with `--verbose`. Exit codes: `1` user/config, `2` schema parse, `3` LLM/API, `4` generation/integrity.
- **Determinism.** Anything user-visible (file content, summary numbers given the same seed) must be reproducible. Don't introduce `new Date()` or `Math.random()` into the engine or renderers. The seeded RNG and `faker.setDefaultRefDate` already keep dates stable.
- **No timestamps in generated files.** Same `--seed` must produce byte-identical output (PRD §16.6).
- **Tests first, ideally.** New parser cases need a fixture under `test/fixtures/schemas/`. New strategies need a unit test that asserts the value shape and respects the seed.
- **Don't broaden the dependency tree casually.** Each runtime dep ships to every `npx auto-seed` user.

## Adding a parser feature

1. Add a fixture under `test/fixtures/schemas/<name>.<ext>` covering the construct.
2. Add an assertion to `test/parsers.test.ts` over the resulting `SchemaIR`.
3. Make the parser emit the new field — and append a `warnings` entry (not a throw) for partial-support cases.
4. Run `bun run test` and confirm both the new and existing tests pass.

## Adding a strategy

1. Add a Zod variant to `src/plan/schema.ts` under `ColumnStrategy`.
2. Add a case to `applyStrategy` in `src/engine/strategies.ts`.
3. Update the prompt in `src/plan/schema.ts` (`SEED_PLAN_SHAPE_HINT`) so the LLM knows when to pick it.
4. Add a unit test that asserts deterministic behavior for a fixed seed.

## Commit messages

This repo uses short, scoped messages. The convention is loose Conventional Commits:

```
feat(parsers): support Prisma @@map for table renaming
fix(engine): backfill cyclic-nullable FKs after pass 1
docs(readme): clarify --plan reuse path
test(render): MySQL backtick identifier quoting
```

Keep the subject line under ~72 chars. Use the body for the *why* if it isn't obvious.

## Pull requests

- Open a PR against `main`. Small, focused PRs review faster than big ones.
- The PR description should call out:
  - The user-visible behavior change
  - Anything that changes the on-disk file format (`config.json`, the Seed Plan JSON shape, the rendered seed files)
  - Whether it adds a runtime dependency
- All of `bun run typecheck`, `bun run test`, and `bun run build` must pass.
- CI runs the same three commands; please run them locally first.

## Releasing

(Maintainer notes.)

1. Bump `package.json#version` and the `VERSION` constant in `src/index.ts`. Keep them in sync.
2. `bun run typecheck && bun run test && bun run build`
3. Tag: `git tag v<version> && git push --tags`
4. `npm publish` — `prepublishOnly` re-runs the three checks above.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
