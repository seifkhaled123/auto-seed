import { Command } from "commander";
import { buildInitCommand } from "./commands/init.js";
import { buildConfigCommand } from "./commands/config.js";
import { buildGenerateCommand } from "./commands/generate.js";
import { isCLIError } from "./util/errors.js";
import { log, setVerbose, isVerbose } from "./util/logger.js";

// Read version from package.json at runtime (bundled by tsup as embedded data).
const VERSION = "0.1.0";

function buildProgram(): Command {
  const program = new Command();
  program
    .name("auto-seed")
    .description(
      "Generate realistic, relationally-accurate seed data from your existing schema.",
    )
    .version(VERSION, "-V, --version", "show version")
    .option("--verbose", "verbose logging", false);

  program.hook("preAction", (thisCmd) => {
    const opts = thisCmd.optsWithGlobals();
    if (opts.verbose) setVerbose(true);
  });

  program.addCommand(buildInitCommand());
  program.addCommand(buildConfigCommand());

  const generate = buildGenerateCommand();
  program.addCommand(generate, { isDefault: true });

  return program;
}

async function main() {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (isCLIError(err)) {
      log.error(err.message);
      if (err.hint) log.hint(err.hint);
      if (isVerbose() && err.stack) process.stderr.write(err.stack + "\n");
      process.exit(err.exitCode);
    }
    log.error((err as Error).message ?? String(err));
    if (isVerbose() && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  }
}

await main();
