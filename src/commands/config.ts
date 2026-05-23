import { Command } from "commander";
import {
  configFilePath,
  flatten,
  getPath,
  loadConfig,
  maskKey,
  saveConfig,
  setPath,
} from "../config/config.js";
import { CLIError } from "../util/errors.js";
import { log, pc } from "../util/logger.js";

const KEY_PATHS = new Set(["apiKeys.anthropic", "apiKeys.openai"]);

export function buildConfigCommand(): Command {
  const cmd = new Command("config").description("Read and write auto-seed configuration.");

  cmd
    .command("set <key> <value>")
    .description("Set a config value (e.g. `provider`, `model.anthropic`, `defaults.format`).")
    .action(async (key: string, value: string) => {
      const cfg = await loadConfig();
      const next = setPath(cfg, key, value);
      await saveConfig(next);
      const shown = KEY_PATHS.has(key) ? maskKey(value) : value;
      log.success(`set ${pc.bold(key)} = ${shown}`);
    });

  cmd
    .command("get <key>")
    .description("Read a config value (API keys are masked).")
    .action(async (key: string) => {
      const cfg = await loadConfig();
      const raw = getPath(cfg, key);
      if (raw === undefined) {
        throw new CLIError(`No value set for ${key}`, 1);
      }
      process.stdout.write((KEY_PATHS.has(key) ? maskKey(raw) : raw) + "\n");
    });

  cmd
    .command("list")
    .description("List all stored config (API keys masked).")
    .action(async () => {
      const cfg = await loadConfig();
      const flat = flatten(cfg);
      const keys = Object.keys(flat);
      if (keys.length === 0) {
        log.info(pc.dim("(empty) — run `auto-seed init` to get started"));
        return;
      }
      const width = Math.max(...keys.map((k) => k.length));
      for (const k of keys) {
        process.stdout.write(`${k.padEnd(width)}  ${flat[k]}\n`);
      }
    });

  cmd
    .command("path")
    .description("Print the config file path.")
    .action(() => {
      process.stdout.write(configFilePath() + "\n");
    });

  return cmd;
}
