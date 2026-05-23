import type { TokenUsage } from "../llm/provider.js";

/**
 * Best-effort price table (USD per million tokens). Values are approximate and may drift.
 * Falls back to "approximate" labeling when the model is unknown.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-7": { input: 15.0, output: 75.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
};

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  knownModel: boolean;
  totalUsd: number;
}

export function estimateCost(model: string, usage: TokenUsage): CostEstimate {
  const price = PRICES[model];
  if (!price) {
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      knownModel: false,
      totalUsd: 0,
    };
  }
  const totalUsd =
    (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    knownModel: true,
    totalUsd,
  };
}

export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.0000";
  if (amount < 0.0001) return "<$0.0001";
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  return `$${amount.toFixed(4)}`;
}
