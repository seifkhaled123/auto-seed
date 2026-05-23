import { Command } from "commander";
import ora from "ora";
import { CLIError } from "../util/errors.js";
import { log, pc } from "../util/logger.js";
import { loadConfig, resolveRuntime, type ProviderName, type OutputFormat } from "../config/config.js";
import { parseSchema } from "../parsers/index.js";
import { parseRowsSpec, resolveRowCount } from "../util/rows.js";
import { generatePlan } from "../plan/generatePlan.js";
import { makeProvider } from "../llm/factory.js";
import { estimateCost, formatUsd } from "../util/cost.js";
import type { SqlDialect } from "../ir/types.js";

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
    .option("-y, --yes", "skip confirmation prompts")
    .action(async (opts: GenerateOptions) => {
      await runGenerate(opts);
    });
}

export async function runGenerate(opts: GenerateOptions): Promise<void> {
  // Milestone 3 covers: parse → plan (or reuse) → dry-run print.
  // Milestones 4/5 layer the engine + renderer on top of this same flow.
  const rowsSpec = parseRowsSpec(opts.rows ?? "10");

  // 1) Parse the schema.
  const ir = await parseSchema({ schemaPath: opts.schema, dialect: opts.dialect });
  if (ir.warnings.length) {
    for (const w of ir.warnings) log.warn(w);
  }

  // Optionally filter to a subset of tables (the engine in M4 also respects this).
  if (opts.tables) {
    const allow = new Set(opts.tables.split(",").map((s) => s.trim()).filter(Boolean));
    ir.tables = ir.tables.filter((t) => allow.has(t.name));
    if (ir.tables.length === 0) {
      throw new CLIError("No matching tables after applying --tables filter.", 1);
    }
  }

  // 2) Acquire a Seed Plan, either from disk or from the LLM.
  let plan;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let modelLabel = "(reused plan)";

  const rowCounts: Record<string, number> = {};
  for (const t of ir.tables) rowCounts[t.name] = resolveRowCount(t.name, rowsSpec);

  if (opts.plan) {
    const { loadPlanFromDisk } = await import("../plan/load.js");
    plan = await loadPlanFromDisk(opts.plan);
    log.info(pc.dim(`Loaded plan from ${opts.plan}`));
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
      spinner.fail(`Plan generation failed`);
      throw err;
    }
  }

  // 3) Override the LLM's per-table rowCount with whatever --rows/global default says.
  for (const t of plan.tables) {
    t.rowCount = rowCounts[t.table] ?? t.rowCount;
  }

  // 4) Print summary / handle terminal flags.
  if (opts.dryRun) {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    printSummary(plan, modelLabel, usage, opts);
    return;
  }

  if (opts.planOnly) {
    const { writeFileAtomic } = await import("../util/writeFile.js");
    const outPath = opts.out ?? "./seed-plan.json";
    await writeFileAtomic(outPath, JSON.stringify(plan, null, 2) + "\n", { force: !!opts.yes });
    log.success(`Plan written to ${pc.cyan(outPath)}`);
    printSummary(plan, modelLabel, usage, opts);
    return;
  }

  // The actual data generation + rendering ships in milestones 4/5.
  const { runEngineAndRender } = await import("./generate_engine.js");
  await runEngineAndRender({ ir, plan, opts, usage, modelLabel });
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
