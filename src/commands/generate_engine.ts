/**
 * Bridge between the `generate` command and the engine + renderers.
 * Engine logic lands in milestone 4, renderers in milestone 5.
 * For milestone 3, this stub explains how to use --dry-run / --plan-only / --plan.
 */
import { CLIError } from "../util/errors.js";
import type { GenerateOptions } from "./generate.js";
import type { SchemaIR } from "../ir/types.js";
import type { SeedPlan } from "../plan/schema.js";
import type { TokenUsage } from "../llm/provider.js";

export interface EngineRenderInput {
  ir: SchemaIR;
  plan: SeedPlan;
  opts: GenerateOptions;
  usage: TokenUsage;
  modelLabel: string;
}

export async function runEngineAndRender(_input: EngineRenderInput): Promise<void> {
  throw new CLIError(
    "Data generation + rendering ship in the next milestone.",
    1,
    "For now, use --dry-run or --plan-only to inspect / save the Seed Plan.",
  );
}
