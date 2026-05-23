import path from "node:path";
import { CLIError } from "../util/errors.js";
import { log, pc } from "../util/logger.js";
import type { GenerateOptions } from "./generate.js";
import type { SchemaIR } from "../ir/types.js";
import type { SeedPlan } from "../plan/schema.js";
import type { TokenUsage } from "../llm/provider.js";
import { runEngine } from "../engine/generate.js";
import { renderSql } from "../render/sql.js";
import { renderTypeScript } from "../render/typescript.js";
import { writeFileAtomic } from "../util/writeFile.js";
import { estimateCost, formatUsd } from "../util/cost.js";

export interface EngineRenderInput {
  ir: SchemaIR;
  plan: SeedPlan;
  opts: GenerateOptions;
  usage: TokenUsage;
  modelLabel: string;
}

export async function runEngineAndRender(input: EngineRenderInput): Promise<void> {
  const { ir, plan, opts, usage, modelLabel } = input;
  const format = opts.format ?? "sql";

  const seed = opts.seed !== undefined ? Number(opts.seed) : undefined;
  if (opts.seed !== undefined && !Number.isFinite(seed!)) {
    throw new CLIError(`--seed must be a number; got "${opts.seed}".`, 1);
  }

  const rowCounts: Record<string, number> = {};
  for (const t of plan.tables) rowCounts[t.table] = t.rowCount;

  const t0 = Date.now();
  const engineOut = runEngine({
    ir,
    plan,
    seed,
    rowCounts,
    locale: opts.locale,
  });
  const engineMs = Date.now() - t0;

  for (const w of engineOut.warnings) log.warn(w);

  const tablesGenerated = engineOut.orderedTables.length;
  const rowsGenerated = engineOut.orderedTables.reduce(
    (acc, t) => acc + (engineOut.dataset.get(t.name)?.length ?? 0),
    0,
  );

  const metadata: Record<string, string | number | undefined> = {
    tool: "auto-seed",
    model: modelLabel,
    seed: engineOut.seed,
    rows: rowsGenerated,
    tables: tablesGenerated,
  };

  const outPath = opts.out ?? defaultOutPath(format);
  const contents =
    format === "sql"
      ? renderSql(ir, engineOut.orderedTables, engineOut.dataset, {
          dialect: opts.dialect ?? ir.dialect,
          metadata,
        })
      : renderTypeScript(ir, engineOut.orderedTables, engineOut.dataset, { metadata });

  await writeFileAtomic(outPath, contents, { force: !!opts.yes });

  // Summary
  log.info("");
  log.info(pc.bold("✓ Seed file generated"));
  log.info(`  output:       ${pc.cyan(path.resolve(outPath))}`);
  log.info(`  format:       ${format}`);
  log.info(`  tables:       ${tablesGenerated}`);
  log.info(`  total rows:   ${rowsGenerated}`);
  log.info(`  seed:         ${engineOut.seed}`);
  log.info(`  engine time:  ${engineMs} ms`);
  if (usage.inputTokens + usage.outputTokens > 0) {
    const modelName = modelLabel.includes("/") ? modelLabel.split("/")[1]! : modelLabel;
    const est = estimateCost(modelName, usage);
    log.info(
      `  tokens:       ${usage.inputTokens} in / ${usage.outputTokens} out` +
        (est.knownModel ? ` (~${formatUsd(est.totalUsd)})` : " (cost: unknown model)"),
    );
  }
}

function defaultOutPath(format: string): string {
  return format === "ts" ? "./seed.ts" : "./seed.sql";
}
