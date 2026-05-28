import { Command } from "commander";
import * as p from "@clack/prompts";
import {
  Config,
  DEFAULT_MODELS,
  loadConfig,
  ProviderName,
  saveConfig,
} from "../config/config.js";
import { configFilePath } from "../config/config.js";
import { CLIError } from "../util/errors.js";
import { log, pc } from "../util/logger.js";
import { listModels } from "../llm/list-models.js";

export function buildInitCommand(): Command {
  return new Command("init")
    .description("Interactive first-run setup: pick provider, paste API key, pick model.")
    .action(async () => {
      p.intro(pc.bold("auto-seed init"));

      const existing = await loadConfig();

      const provider = (await p.select({
        message: "Which LLM provider would you like to use?",
        options: [
          { value: "anthropic", label: "Anthropic (Claude)" },
          { value: "openai", label: "OpenAI" },
          { value: "gemini", label: "Google Gemini" },
        ],
        initialValue: existing.provider ?? "anthropic",
      })) as ProviderName | symbol;
      if (p.isCancel(provider)) throw new CLIError("Cancelled.", 1);

      const envVarName =
        provider === "anthropic" ? "ANTHROPIC_API_KEY" :
        provider === "openai"    ? "OPENAI_API_KEY" :
                                   "GEMINI_API_KEY";
      const envKey =
        provider === "anthropic" ? process.env.ANTHROPIC_API_KEY :
        provider === "openai"    ? process.env.OPENAI_API_KEY :
                                   process.env.GEMINI_API_KEY;

      let apiKey: string | undefined;
      if (envKey) {
        const reuse = await p.confirm({
          message: `${envVarName} is set in your environment. Use it instead of storing a key?`,
          initialValue: true,
        });
        if (p.isCancel(reuse)) throw new CLIError("Cancelled.", 1);
        if (!reuse) {
          const k = await p.password({
            message: `Paste your ${provider} API key`,
            validate: (v) => ((v ?? "").trim().length < 8 ? "Key looks too short." : undefined),
          });
          if (p.isCancel(k)) throw new CLIError("Cancelled.", 1);
          apiKey = k.trim();
        }
      } else {
        const k = await p.password({
          message: `Paste your ${provider} API key`,
          validate: (v) => ((v ?? "").trim().length < 8 ? "Key looks too short." : undefined),
        });
        if (p.isCancel(k)) throw new CLIError("Cancelled.", 1);
        apiKey = k.trim();
      }

      const defaultModel = DEFAULT_MODELS[provider];
      const effectiveKey = apiKey ?? envKey ?? "";

      let modelChoices: string[] | null = null;
      if (effectiveKey) {
        const s = p.spinner();
        s.start("Fetching available models…");
        try {
          modelChoices = await listModels(provider, effectiveKey);
          s.stop(`Fetched ${modelChoices.length} models.`);
        } catch {
          s.stop("Could not fetch models — you can type the model name manually.");
        }
      }

      let model: string | symbol;
      if (modelChoices && modelChoices.length > 0) {
        const savedModel = existing.models?.[provider] ?? defaultModel;
        const initialValue = modelChoices.includes(savedModel) ? savedModel : modelChoices[0];
        model = (await p.select({
          message: `Default model for ${provider}?`,
          options: modelChoices.map((id) => ({
            value: id,
            label: id,
            hint: id === defaultModel ? "recommended" : undefined,
          })),
          initialValue,
        })) as string | symbol;
      } else {
        model = await p.text({
          message: `Default model for ${provider}?`,
          initialValue: existing.models?.[provider] ?? defaultModel,
          placeholder: defaultModel,
        });
      }
      if (p.isCancel(model)) throw new CLIError("Cancelled.", 1);

      const format = (await p.select({
        message: "Default output format?",
        options: [
          { value: "sql", label: ".sql (INSERT statements)" },
          { value: "ts", label: ".ts (Prisma/TypeORM/plain script)" },
        ],
        initialValue: existing.defaults?.format ?? "sql",
      })) as "sql" | "ts" | symbol;
      if (p.isCancel(format)) throw new CLIError("Cancelled.", 1);

      const next: Config = {
        ...existing,
        provider,
        models: { ...(existing.models ?? {}), [provider]: model },
        apiKeys: { ...(existing.apiKeys ?? {}), ...(apiKey ? { [provider]: apiKey } : {}) },
        defaults: { ...(existing.defaults ?? {}), format },
      };

      await saveConfig(next);
      p.outro(`Saved to ${pc.cyan(configFilePath())}`);
      log.info("");
      log.info(pc.dim("Run `auto-seed generate` in a project to get started."));
    });
}
