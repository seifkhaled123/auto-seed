import { SchemaIR } from "../ir/types.js";
import { SEED_PLAN_SHAPE_HINT } from "./schema.js";

/**
 * Compact, token-efficient textual representation of a SchemaIR.
 *   Table foo (postgresql):
 *     id    int   PK auto
 *     email string UNIQUE !null max=255
 *     authorId int  FK→User.id
 */
export function serializeSchemaForLLM(ir: SchemaIR): string {
  const lines: string[] = [];
  lines.push(`SOURCE: ${ir.source}${ir.dialect ? ` (${ir.dialect})` : ""}`);
  for (const t of ir.tables) {
    lines.push(`TABLE ${t.name}`);
    for (const c of t.columns) {
      const flags: string[] = [];
      if (c.isPrimaryKey) flags.push("PK");
      if (c.isAutoIncrement) flags.push("auto");
      if (c.isUnique) flags.push("UNIQUE");
      if (!c.nullable) flags.push("!null");
      if (c.maxLength !== undefined) flags.push(`max=${c.maxLength}`);
      if (c.foreignKey) flags.push(`FK→${c.foreignKey.table}.${c.foreignKey.column}`);
      if (c.enumValues) flags.push(`enum=[${c.enumValues.join("|")}]`);
      lines.push(`  ${c.name.padEnd(28)} ${c.kind.padEnd(10)} ${flags.join(" ")}`.trimEnd());
    }
    if (t.primaryKey.length > 1) lines.push(`  PRIMARY KEY (${t.primaryKey.join(", ")})`);
    for (const ug of t.uniqueGroups) {
      lines.push(`  UNIQUE (${ug.join(", ")})`);
    }
  }
  if (ir.warnings.length) {
    lines.push("");
    lines.push("WARNINGS (informational):");
    for (const w of ir.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

export const SYSTEM_PROMPT = `You are a database seed-data planner. Given a database schema, you produce a JSON "Seed Plan" describing — per column — exactly how to synthesize realistic mock data.

You output JSON ONLY. No prose, no markdown fences, no commentary.

The seed plan is consumed by a local generation engine that handles relational integrity (foreign keys, uniqueness, topological order). Your job is to pick a realistic strategy per column based on its name, type, and constraints.

${SEED_PLAN_SHAPE_HINT}`;

export interface BuildUserPromptInput {
  ir: SchemaIR;
  rowCounts: Record<string, number>;
  defaultRowCount: number;
  locale?: string;
  hint?: string;
  extraValidationError?: string;
  /** When set, ask the model to output plans ONLY for these tables (the rest are context). */
  onlyTables?: string[];
}

export function buildUserPrompt(input: BuildUserPromptInput): string {
  const { ir, rowCounts, defaultRowCount, locale, hint, extraValidationError, onlyTables } = input;
  const parts: string[] = [];
  parts.push(serializeSchemaForLLM(ir));
  parts.push("");
  parts.push("ROW COUNTS:");
  for (const t of ir.tables) {
    const n = rowCounts[t.name] ?? defaultRowCount;
    parts.push(`  ${t.name}: ${n}`);
  }
  if (onlyTables && onlyTables.length > 0) {
    parts.push("");
    parts.push(
      `Output Seed Plan entries ONLY for these tables (use the full schema above for foreign-key context, but do not emit plans for other tables): ${onlyTables.join(", ")}`,
    );
  }
  if (locale) {
    parts.push("");
    parts.push(`LOCALE: ${locale}`);
  }
  if (hint) {
    parts.push("");
    parts.push(`DOMAIN HINT: ${hint}`);
  }
  if (extraValidationError) {
    parts.push("");
    parts.push("Your previous response failed validation:");
    parts.push(extraValidationError);
    parts.push("Return ONLY corrected JSON.");
  }
  parts.push("");
  parts.push("Output the Seed Plan JSON now.");
  return parts.join("\n");
}
