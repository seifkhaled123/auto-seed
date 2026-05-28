import { z } from "zod";
import { CLIError } from "../util/errors.js";
import { log } from "../util/logger.js";
import { SchemaIR } from "../ir/types.js";
import type { LLMProvider, TokenUsage } from "../llm/provider.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts.js";
import { SeedPlan } from "./schema.js";

export interface GeneratePlanInput {
  ir: SchemaIR;
  rowCounts: Record<string, number>;
  defaultRowCount: number;
  locale?: string;
  hint?: string;
  maxTokens?: number;
}

export interface GeneratePlanResult {
  plan: SeedPlan;
  usage: TokenUsage;
}

export async function generatePlan(
  provider: LLMProvider,
  input: GeneratePlanInput,
): Promise<GeneratePlanResult> {
  const maxTokens = input.maxTokens ?? 8000;

  const ask = async (extraError?: string) => {
    const user = buildUserPrompt({ ...input, extraValidationError: extraError });
    log.debug(`[plan] sending prompt to ${provider.name}/${provider.model} (~${user.length} chars)`);
    const res = await provider.generateJSON({
      system: SYSTEM_PROMPT,
      user,
      maxTokens,
    });
    log.debug(`[plan] usage: in=${res.usage.inputTokens} out=${res.usage.outputTokens}`);
    return res;
  };

  let res;
  try {
    res = await ask();
  } catch (err) {
    if (err instanceof CLIError) throw err;
    throw new CLIError(`LLM call failed: ${(err as Error).message}`, 3);
  }

  let parsed = SeedPlan.safeParse(coerceRawPlan(res.json));
  if (!parsed.success) {
    const msg = formatZodError(parsed.error);
    log.debug(`[plan] first response failed validation, retrying once: ${msg}`);
    try {
      res = await ask(msg);
    } catch (err) {
      if (err instanceof CLIError) throw err;
      throw new CLIError(`LLM retry failed: ${(err as Error).message}`, 3);
    }
    parsed = SeedPlan.safeParse(coerceRawPlan(res.json));
    if (!parsed.success) {
      throw new CLIError(
        `LLM returned invalid Seed Plan JSON after 2 attempts.`,
        3,
        formatZodError(parsed.error),
      );
    }
  }

  return { plan: parsed.data, usage: res.usage };
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

// Maps LLM-hallucinated/deprecated strategy type names to valid equivalents.
const STRATEGY_COERCIONS: Record<string, Record<string, unknown>> = {
  boolean:        { type: "faker", method: "datatype.boolean" },
  bool:           { type: "faker", method: "datatype.boolean" },
  integer:        { type: "sequence", start: 1 },
  int:            { type: "sequence", start: 1 },
  bigint:         { type: "sequence", start: 1 },
  autoincrement:  { type: "sequence", start: 1 },
  auto_increment: { type: "sequence", start: 1 },
  serial:         { type: "sequence", start: 1 },
  increment:      { type: "sequence", start: 1 },
  id:             { type: "sequence", start: 1 },
  string:         { type: "faker", method: "lorem.words", args: [3] },
  text:           { type: "faker", method: "lorem.words", args: [3] },
  varchar:        { type: "faker", method: "lorem.words", args: [3] },
  char:           { type: "faker", method: "lorem.word" },
  random:         { type: "faker", method: "lorem.words", args: [3] },
  name:           { type: "faker", method: "person.fullName" },
  email:          { type: "faker", method: "internet.email" },
  url:            { type: "faker", method: "internet.url" },
  phone:          { type: "faker", method: "phone.number" },
  float:          { type: "faker", method: "number.float", args: [{ min: 0, max: 1000, fractionDigits: 2 }] },
  decimal:        { type: "faker", method: "number.float", args: [{ min: 0, max: 1000, fractionDigits: 2 }] },
  numeric:        { type: "faker", method: "number.float", args: [{ min: 0, max: 1000, fractionDigits: 2 }] },
  number:         { type: "faker", method: "number.int", args: [{ min: 0, max: 1000 }] },
  date:           { type: "faker", method: "date.recent" },
  datetime:       { type: "faker", method: "date.recent" },
  timestamp:      { type: "faker", method: "date.recent" },
  json:           { type: "static", value: {} },
  constant:       { type: "static", value: null },
  fixed:          { type: "static", value: null },
  literal:        { type: "static", value: null },
};

const VALID_STRATEGY_TYPES = new Set([
  "sequence", "uuid", "faker", "enum", "pattern", "reference", "static", "null",
]);

const FALLBACK_STRATEGY = { type: "faker", method: "lorem.words", args: [3] } as const;

// Always-override columns: any strategy the LLM picks is replaced unconditionally.
// Used for columns whose correct value is always a fixed constant.
// IMPORTANT: only list names distinctive enough that they cannot plausibly mean
// something else in an unrelated schema. Generic names (count, status, user_status)
// must NOT go here — they would silently zero a meaningful column. Integer overflow
// for those is handled safely by coerceToColumnKind in the engine instead.
const COL_NAME_ALWAYS: Record<string, Record<string, unknown>> = {
  term_group:    { type: "static", value: 0 },
  menu_order:    { type: "static", value: 0 },
  comment_karma: { type: "static", value: 0 },
  comment_count: { type: "static", value: 0 },
  link_rating:   { type: "static", value: 0 },
  term_order:    { type: "static", value: 0 },
};

// Lorem-only overrides: fires only when the LLM fell back to a lorem.* strategy.
// Used for columns with a fixed vocabulary or a known faker method.
const COL_NAME_LOREM: Record<string, Record<string, unknown>> = {
  link_target:         { type: "enum", values: ["", "_blank", "_self", "_top"] },
  link_rel:            { type: "enum", values: ["", "nofollow", "friend", "colleague", "met"] },
  comment_agent:       { type: "faker", method: "internet.userAgent" },
  user_agent:          { type: "faker", method: "internet.userAgent" },
  post_mime_type:      { type: "enum", values: ["", "image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "application/pdf"] },
  mime_type:           { type: "enum", values: ["", "image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "application/pdf"] },
  comment_type:        { type: "enum", values: ["comment", "pingback", "trackback", ""] },
  taxonomy:            { type: "enum", values: ["category", "post_tag", "nav_menu", "link_category", "post_format"] },
  user_pass:           { type: "faker", method: "internet.password" },
  user_activation_key: { type: "faker", method: "string.alphanumeric", args: [{ length: 32 }] },
};

function coerceRawPlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const plan = raw as Record<string, unknown>;
  if (!Array.isArray(plan.tables)) return raw;
  return {
    ...plan,
    tables: plan.tables.map((t) => {
      if (!t || typeof t !== "object" || Array.isArray(t)) return t;
      const table = t as Record<string, unknown>;
      if (!Array.isArray(table.columns)) return t;
      return {
        ...table,
        columns: table.columns.map((c) => {
          if (!c || typeof c !== "object" || Array.isArray(c)) return c;
          const col = c as Record<string, unknown>;
          const s = col.strategy;
          if (!s || typeof s !== "object" || Array.isArray(s)) return c;
          const strat = s as Record<string, unknown>;
          const colName = String(col.column ?? "").toLowerCase();

          // 0a. Always-override: replace any LLM strategy for well-known zero-value columns.
          if (COL_NAME_ALWAYS[colName]) {
            return { ...col, strategy: COL_NAME_ALWAYS[colName] };
          }

          // 0b. Lorem-only override: substitute when LLM fell back to lorem.* for a
          //     column whose name implies a known vocabulary or faker method.
          if (
            strat.type === "faker" &&
            typeof strat.method === "string" &&
            strat.method.startsWith("lorem.") &&
            COL_NAME_LOREM[colName]
          ) {
            return { ...col, strategy: COL_NAME_LOREM[colName] };
          }

          // 1. Known invalid type → map to valid strategy
          const mapped = STRATEGY_COERCIONS[String(strat.type)];
          if (mapped) return { ...col, strategy: mapped };

          // 2. Valid type but malformed required fields → fallback
          if (strat.type === "faker" && (typeof strat.method !== "string" || !strat.method.trim())) {
            return { ...col, strategy: FALLBACK_STRATEGY };
          }
          if (strat.type === "reference" && (typeof strat.table !== "string" || typeof strat.column !== "string")) {
            return { ...col, strategy: FALLBACK_STRATEGY };
          }
          if (strat.type === "enum" && (!Array.isArray(strat.values) || strat.values.length === 0)) {
            return { ...col, strategy: FALLBACK_STRATEGY };
          }
          if (strat.type === "pattern" && typeof strat.template !== "string") {
            return { ...col, strategy: FALLBACK_STRATEGY };
          }

          // 3. Completely unknown type → fallback
          if (!VALID_STRATEGY_TYPES.has(String(strat.type))) {
            return { ...col, strategy: FALLBACK_STRATEGY };
          }

          return c;
        }),
      };
    }),
  };
}
