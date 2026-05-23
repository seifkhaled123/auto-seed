import { Command } from "commander";
import { CLIError } from "../util/errors.js";

/**
 * Stub for milestone 1. The full implementation lands in M3 (LLM/plan)
 * and M5 (renderers + e2e). Flags are wired here so `--help` shows them.
 */
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
    .option("--dry-run", "print Seed Plan + summary, write nothing")
    .option("--plan-only", "write the Seed Plan JSON only")
    .option("--plan <path>", "reuse a saved Seed Plan JSON (no LLM call)")
    .option("--hint <text>", "free-text domain hint passed to the LLM")
    .option("-y, --yes", "skip confirmation prompts")
    .action(() => {
      throw new CLIError(
        "`generate` is not yet implemented in this build.",
        1,
        "This is a milestone-1 skeleton. Run `auto-seed init` to set up your provider/key.",
      );
    });
}
