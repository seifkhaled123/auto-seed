import { Command } from "commander";
import path from "node:path";
import ora from "ora";
import { CLIError } from "../util/errors.js";
import { log, pc } from "../util/logger.js";
import { loadConfig, resolveRuntime, type ProviderName, type OutputFormat } from "../config/config.js";
import { parseSchema } from "../parsers/index.js";
import { parseRowsSpec, resolveRowCount } from "../util/rows.js";
import { generatePlan } from "../plan/generatePlan.js";
import { makeProvider } from "../llm/factory.js";
import { estimateCost, formatUsd } from "../util/cost.js";
import { renderSql } from "../render/sql.js";
import { renderTypeScript } from "../render/typescript.js";
import { writeFileAtomic } from "../util/writeFile.js";
import type { SqlDialect } from "../ir/types.js";
import { DEFAULT_DIRECT_CAP, runDirectMode } from "../plan/direct.js";

export interface GenerateOptions {
  schema?: string;
  format?: OutputFormat;
  rows?: string;
  mode?: "plan" | "direct";
  out?: string;
  seed?: string;
  tables?: string;
  locale?: string;
  provider?: ProviderName;
  model?: string;
  dryRun?: boolean;
  planOnly?: boolean;
  plan?: string;
  hint?: string;
  yes?: boolean;
  dialect?: SqlDialect;
  maxDirectRows?: string;
}

export function buildGenerateCommand(): Command {
  return new Command("generate")
    .description("Generate a seed file from a schema (Prisma / SQL DDL / TypeORM).")
    .option("--schema <path>", "path to schema file (auto-detected if omitted)")
    .option("--format <ts|sql>", "output format", "sql")
    .option("--rows <spec>", "global count or per-table (e.g. users:20,orders:100)", "10")
    .option("--mode <plan|direct>", "generation mode", "plan")
    .option("--out <path>", "output file path")
    .option("--seed <number>", "deterministic RNG seed")
    .option("--tables <list>", "comma-separated subset of tables")
    .option("--locale <code>", "faker locale", "en")
    .option("--provider <anthropic|openai>", "override LLM provider")
    .option("--model <id>", "override LLM model")
    .option("--dialect <postgresql|mysql|sqlite>", "SQL dialect (for .sql input)", "postgresql")
    .option("--dry-run", "print Seed Plan + summary, write nothing")
    .option("--plan-only", "write the Seed Plan JSON only")
    .option("--plan <path>", "reuse a saved Seed Plan JSON (no LLM call)")
    .option("--hint <text>", "free-text domain hint passed to the LLM")
    .option("--max-direct-rows <n>", `cap for --mode direct (default ${DEFAULT_DIRECT_CAP})`)
    .option("-y, --yes", "skip confirmation prompts")
    .action(async (opts: GenerateOptions) => {
      await runGenerate(opts);
    });
}

export async function runGenerate(opts: GenerateOptions): Promise<void> {
  const rowsSpec = parseRowsSpec(opts.rows ?? "10");
  const mode = opts.mode ?? "plan";
  const format = opts.format ?? "sql";

  // 1) Parse the schema.
  const ir = await parseSchema({ schemaPath: opts.schema, dialect: opts.dialect });
  if (ir.warnings.length) {
    for (const w of ir.warnings) log.warn(w);
  }

  // Apply --tables filter early.
  if (opts.tables) {
    const allow = new Set(opts.tables.split(",").map((s) => s.trim()).filter(Boolean));
    ir.tables = ir.tables.filter((t) => allow.has(t.name));
    if (ir.tables.length === 0) {
      throw new CLIError("No matching tables after applying --tables filter.", 1);
    }
  }

  // Build per-table row counts (used by both modes).
  const rowCounts: Record<string, number> = {};
  for (const t of ir.tables) rowCounts[t.name] = resolveRowCount(t.name, rowsSpec);

  // 2) Direct mode is a separate path: model emits literal rows; the engine is bypassed.
  if (mode === "direct") {
    return await runDirect({ opts, ir, rowCounts, format });
  }

  // 3) Plan mode (default). Acquire a Seed Plan, either from disk or from the LLM.
  let plan;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let modelLabel = "(reused plan)";

  if (opts.plan) {
    const { loadPlanFromDisk } = await import("../plan/load.js");
    plan = await loadPlanFromDisk(opts.plan);
    log.info(pc.dim(`Loaded plan from ${opts.plan} (no LLM call)`));
  } else {
    const cfg = await loadConfig();
    const rt = resolveRuntime(cfg, { provider: opts.provider, model: opts.model });
    modelLabel = `${rt.provider}/${rt.model}`;
    const provider = makeProvider(rt);

    const spinner = ora({ text: `Designing seed plan with ${modelLabel}…`, stream: process.stderr }).start();
    try {
      const result = await generatePlan(provider, {
        ir,
        rowCounts,
        defaultRowCount: rowsSpec.default ?? 10,
        locale: opts.locale,
        hint: opts.hint,
      });
      plan = result.plan;
      usage = result.usage;
      spinner.succeed(`Seed plan ready (${modelLabel})`);
    } catch (err) {
      spinner.fail("Plan generation failed");
      throw err;
    }
  }

  // 4) Override the LLM's per-table rowCount with whatever --rows says.
  for (const t of plan.tables) {
    t.rowCount = rowCounts[t.table] ?? t.rowCount;
  }

  // 5) Terminal flags: --dry-run / --plan-only.
  if (opts.dryRun) {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    printSummary(plan, modelLabel, usage, opts);
    return;
  }
  if (opts.planOnly) {
    const outPath = opts.out ?? "./seed-plan.json";
    await writeFileAtomic(outPath, JSON.stringify(plan, null, 2) + "\n", { force: !!opts.yes });
    log.success(`Plan written to ${pc.cyan(outPath)}`);
    printSummary(plan, modelLabel, usage, opts);
    return;
  }

  // 6) Engine + renderer + write.
  const { runEngineAndRender } = await import("./generate_engine.js");
  await runEngineAndRender({ ir, plan, opts, usage, modelLabel });
}

interface DirectArgs {
  opts: GenerateOptions;
  ir: import("../ir/types.js").SchemaIR;
  rowCounts: Record<string, number>;
  format: OutputFormat;
}

async function runDirect(args: DirectArgs): Promise<void> {
  const { opts, ir, rowCounts, format } = args;
  if (opts.plan) {
    throw new CLIError("`--plan` is only valid in plan mode (the default).", 1);
  }
  if (opts.dryRun) {
    throw new CLIError("`--dry-run` is only valid in plan mode.", 1);
  }
  if (opts.planOnly) {
    throw new CLIError("`--plan-only` is only valid in plan mode.", 1);
  }
  const cap =
    opts.maxDirectRows !== undefined ? Number(opts.maxDirectRows) : DEFAULT_DIRECT_CAP;
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new CLIError(`--max-direct-rows must be a positive integer.`, 1);
  }

  const cfg = await loadConfig();
  const rt = resolveRuntime(cfg, { provider: opts.provider, model: opts.model });
  const modelLabel = `${rt.provider}/${rt.model}`;
  const provider = makeProvider(rt);

  const spinner = ora({ text: `Generating ${sumValues(rowCounts)} rows with ${modelLabel}…`, stream: process.stderr }).start();
  let result;
  try {
    result = await runDirectMode(provider, {
      ir,
      rowCounts,
      hint: opts.hint,
      locale: opts.locale,
      maxRows: cap,
    });
    spinner.succeed(`direct mode complete (${modelLabel})`);
  } catch (err) {
    spinner.fail("direct mode failed");
    throw err;
  }

  const metadata = {
    tool: "auto-seed",
    mode: "direct",
    model: modelLabel,
    rows: result.dataset
      ? [...result.dataset.values()].reduce((a, r) => a + r.length, 0)
      : 0,
    tables: result.orderedTables.length,
  };

  const outPath = opts.out ?? (format === "ts" ? "./seed.ts" : "./seed.sql");
  const contents =
    format === "sql"
      ? renderSql(ir, result.orderedTables, result.dataset, {
          dialect: opts.dialect ?? ir.dialect,
          metadata,
        })
      : renderTypeScript(ir, result.orderedTables, result.dataset, { metadata });
  await writeFileAtomic(outPath, contents, { force: !!opts.yes });

  log.info("");
  log.info(pc.bold("✓ Seed file generated"));
  log.info(`  output:       ${pc.cyan(path.resolve(outPath))}`);
  log.info(`  mode:         direct`);
  log.info(`  format:       ${format}`);
  log.info(`  tables:       ${result.orderedTables.length}`);
  log.info(`  total rows:   ${metadata.rows}`);
  if (result.usage.inputTokens + result.usage.outputTokens > 0) {
    const est = estimateCost(rt.model, result.usage);
    log.info(
      `  tokens:       ${result.usage.inputTokens} in / ${result.usage.outputTokens} out` +
        (est.knownModel ? ` (~${formatUsd(est.totalUsd)})` : " (cost: unknown model)"),
    );
  }
}

function sumValues(o: Record<string, number>): number {
  return Object.values(o).reduce((a, b) => a + b, 0);
}

function printSummary(
  plan: { tables: Array<{ table: string; rowCount: number }> },
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  opts: GenerateOptions,
) {
  const total = plan.tables.reduce((acc, t) => acc + t.rowCount, 0);
  log.info("");
  log.info(pc.bold("Summary"));
  log.info(`  model:        ${model}`);
  log.info(`  tables:       ${plan.tables.length}`);
  log.info(`  total rows:   ${total}`);
  if (usage.inputTokens + usage.outputTokens > 0) {
    const est = estimateCost(model.split("/")[1] ?? model, usage);
    log.info(
      `  tokens:       ${usage.inputTokens} in / ${usage.outputTokens} out` +
        (est.knownModel ? ` (~${formatUsd(est.totalUsd)})` : " (cost: unknown model)"),
    );
  }
  if (opts.seed !== undefined) log.info(`  seed:         ${opts.seed}`);
}
