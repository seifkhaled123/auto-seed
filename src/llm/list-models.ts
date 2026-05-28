import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { ProviderName } from "../config/config.js";

export async function listModels(provider: ProviderName, apiKey: string): Promise<string[]> {
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey, timeout: 15_000 });
    const page = await client.models.list({ limit: 100 });
    return page.data.map((m) => m.id);
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey, timeout: 15_000 });
    const page = await client.models.list();
    return page.data
      .filter((m) => /^(gpt-|o1|o3|o4)/.test(m.id))
      .sort((a, b) => b.created - a.created)
      .map((m) => m.id);
  }

  if (provider === "gemini") {
    const client = new GoogleGenAI({ apiKey });
    const models: string[] = [];
    const pager = await client.models.list();
    for await (const m of pager) {
      const id = (m.name ?? "").replace(/^models\//, "");
      if (id && (m.supportedActions ?? []).includes("generateContent")) {
        models.push(id);
      }
    }
    return models;
  }

  return [];
}
