import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CONFIG_DIR, CONFIG_FILE } from "../util/paths.js";
import { CLIError } from "../util/errors.js";

export const ProviderName = z.enum(["anthropic", "openai"]);
export type ProviderName = z.infer<typeof ProviderName>;

export const OutputFormat = z.enum(["sql", "ts"]);
export type OutputFormat = z.infer<typeof OutputFormat>;

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
};

export const ConfigSchema = z.object({
  provider: ProviderName.optional(),
  models: z
    .object({
      anthropic: z.string().optional(),
      openai: z.string().optional(),
    })
    .partial()
    .optional(),
  apiKeys: z
    .object({
      anthropic: z.string().optional(),
      openai: z.string().optional(),
    })
    .partial()
    .optional(),
  defaults: z
    .object({
      format: OutputFormat.optional(),
      rows: z.string().optional(),
      locale: z.string().optional(),
    })
    .partial()
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const EMPTY_CONFIG: Config = {};

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, "utf8");
    const json = JSON.parse(raw);
    return ConfigSchema.parse(json);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ...EMPTY_CONFIG };
    if (err instanceof z.ZodError) {
      throw new CLIError(
        `Config file at ${CONFIG_FILE} is invalid: ${err.issues[0]?.message ?? "unknown"}`,
        1,
        "Re-run `auto-seed init` to recreate it.",
      );
    }
    if (err instanceof SyntaxError) {
      throw new CLIError(
        `Config file at ${CONFIG_FILE} is not valid JSON.`,
        1,
        "Re-run `auto-seed init` to recreate it.",
      );
    }
    throw err;
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  const data = JSON.stringify(cfg, null, 2);
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.rename(tmp, CONFIG_FILE);
  // Ensure final perms even if rename preserved different mode.
  try {
    await fsp.chmod(CONFIG_FILE, 0o600);
  } catch {
    // ignore (e.g. on Windows)
  }
}

export interface ResolvedConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
  defaults: NonNullable<Config["defaults"]>;
}

/**
 * Resolve effective runtime config from (in precedence order):
 *   1. CLI overrides
 *   2. env vars
 *   3. config file
 *   4. built-in defaults
 */
export function resolveRuntime(
  cfg: Config,
  overrides: { provider?: ProviderName; model?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const provider: ProviderName =
    overrides.provider ??
    (env.AUTO_SEED_PROVIDER as ProviderName | undefined) ??
    cfg.provider ??
    "anthropic";

  if (!ProviderName.options.includes(provider)) {
    throw new CLIError(
      `Unknown provider: ${provider}. Expected anthropic or openai.`,
      1,
    );
  }

  const model: string =
    overrides.model ??
    env.AUTO_SEED_MODEL ??
    cfg.models?.[provider] ??
    DEFAULT_MODELS[provider];

  const envKey = provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  const apiKey = envKey ?? cfg.apiKeys?.[provider] ?? "";

  if (!apiKey) {
    throw new CLIError(
      `No API key found for provider "${provider}".`,
      1,
      `Run \`auto-seed init\` or set ${
        provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
      }.`,
    );
  }

  return {
    provider,
    model,
    apiKey,
    defaults: cfg.defaults ?? {},
  };
}

export function maskKey(key: string | undefined): string {
  if (!key) return "(unset)";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Get/set a config value via dotted path. Used by `config get/set`.
 * Supported paths:
 *   provider
 *   models.anthropic, models.openai
 *   apiKeys.anthropic, apiKeys.openai   (set only; masked on get/list)
 *   defaults.format, defaults.rows, defaults.locale
 */
const SETTABLE_PATHS = new Set([
  "provider",
  "models.anthropic",
  "models.openai",
  "apiKeys.anthropic",
  "apiKeys.openai",
  "defaults.format",
  "defaults.rows",
  "defaults.locale",
]);

export function setPath(cfg: Config, dotted: string, value: string): Config {
  if (!SETTABLE_PATHS.has(dotted)) {
    throw new CLIError(
      `Unknown config key: ${dotted}`,
      1,
      `Valid keys: ${[...SETTABLE_PATHS].join(", ")}`,
    );
  }
  const next: Config = JSON.parse(JSON.stringify(cfg));
  const [a, b] = dotted.split(".") as [string, string | undefined];
  if (b === undefined) {
    (next as Record<string, unknown>)[a] = value;
  } else {
    const bucket = ((next as Record<string, Record<string, unknown>>)[a] ??= {});
    bucket[b] = value;
  }
  // Validate the result still parses against the schema.
  return ConfigSchema.parse(next);
}

export function getPath(cfg: Config, dotted: string): string | undefined {
  const [a, b] = dotted.split(".");
  if (!a) return undefined;
  const top = (cfg as Record<string, unknown>)[a];
  if (b === undefined) return top === undefined ? undefined : String(top);
  if (top && typeof top === "object") {
    const v = (top as Record<string, unknown>)[b];
    return v === undefined ? undefined : String(v);
  }
  return undefined;
}

/** Public, mask-aware flat view of the config for `config list`. */
export function flatten(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  if (cfg.provider) out.provider = cfg.provider;
  if (cfg.models?.anthropic) out["models.anthropic"] = cfg.models.anthropic;
  if (cfg.models?.openai) out["models.openai"] = cfg.models.openai;
  if (cfg.apiKeys?.anthropic) out["apiKeys.anthropic"] = maskKey(cfg.apiKeys.anthropic);
  if (cfg.apiKeys?.openai) out["apiKeys.openai"] = maskKey(cfg.apiKeys.openai);
  if (cfg.defaults?.format) out["defaults.format"] = cfg.defaults.format;
  if (cfg.defaults?.rows) out["defaults.rows"] = cfg.defaults.rows;
  if (cfg.defaults?.locale) out["defaults.locale"] = cfg.defaults.locale;
  return out;
}

export function configFilePath(): string {
  return CONFIG_FILE;
}

export function configFileExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

// Test-only helper
export function _internalPaths() {
  return { CONFIG_DIR, CONFIG_FILE, file: path.basename(CONFIG_FILE) };
}
