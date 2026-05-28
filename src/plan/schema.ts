import { z } from "zod";

/** Per PRD §9.2. */
export const ColumnStrategy = z.union([
  z.object({ type: z.literal("sequence"), start: z.number().int().optional() }),
  z.object({ type: z.literal("uuid") }),
  z.object({
    type: z.literal("faker"),
    method: z.string().min(1),
    args: z.array(z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("enum"),
    values: z.array(z.string()).min(1),
    weights: z.array(z.number().nonnegative()).optional(),
  }),
  z.object({ type: z.literal("pattern"), template: z.string().min(1) }),
  z.object({
    type: z.literal("reference"),
    table: z.string().min(1),
    column: z.string().min(1),
    distribution: z.enum(["uniform", "weighted"]).optional(),
  }),
  z.object({ type: z.literal("static"), value: z.unknown() }),
  z.object({ type: z.literal("null") }),
]);
export type ColumnStrategy = z.infer<typeof ColumnStrategy>;

export const ColumnPlan = z.object({
  column: z.string().min(1),
  strategy: ColumnStrategy,
  nullRatio: z.number().min(0).max(1).optional(),
});
export type ColumnPlan = z.infer<typeof ColumnPlan>;

export const TablePlan = z.object({
  table: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
  columns: z.array(ColumnPlan),
});
export type TablePlan = z.infer<typeof TablePlan>;

export const SeedPlan = z.object({
  version: z.literal(1),
  generationOrder: z.array(z.string()),
  tables: z.array(TablePlan),
});
export type SeedPlan = z.infer<typeof SeedPlan>;

/** Compact human-readable description embedded in the LLM prompt. */
export const SEED_PLAN_SHAPE_HINT = `Return JSON shaped as:
{
  "version": 1,
  "generationOrder": ["TableA", "TableB", ...],
  "tables": [
    {
      "table": "<table name>",
      "rowCount": <int>,
      "columns": [
        {
          "column": "<column name>",
          "nullRatio": <0..1, only if column is nullable>,
          "strategy": <one of:
            { "type": "sequence", "start": 1 }
            | { "type": "uuid" }
            | { "type": "faker", "method": "<faker.module.method>", "args": [...] }
            | { "type": "enum", "values": [...], "weights": [...] }
            | { "type": "pattern", "template": "<string with {{index}} or {{faker:m.m}}>" }
            | { "type": "reference", "table": "...", "column": "...", "distribution": "uniform"|"weighted" }
            | { "type": "static", "value": ... }
            | { "type": "null" }
          >
        }
      ]
    }
  ]
}
Rules:
- Use "reference" ONLY for FK columns. The engine will pick valid parent IDs.
- Use "sequence" or "uuid" for PK columns based on the column kind.
- For enum columns, pick "enum" with the declared values; status-like enums should be weighted with the most common value heaviest.
- Pick the most realistic @faker-js/faker v10 method based on the column name + type (e.g. internet.email, person.fullName, company.name, location.city, commerce.product).
- Faker v10 renamed these: use number.int (NOT datatype.number), number.float (NOT datatype.float), internet.username (NOT internet.userName), person.* (NOT name.*), location.* (NOT address.*), string.alphanumeric (NOT random.alphaNumeric), image.url (NOT image.imageUrl), phone.number (NOT phone.phoneNumber), helpers.arrayElement (NOT random.arrayElement), lorem.word (NOT string.word), lorem.slug (NOT commerce.slug or slugify).
- For boolean columns use { "type": "faker", "method": "datatype.boolean" }. Never use { "type": "boolean" }.
- Respect nullability: only include nullRatio for nullable columns (0 means never null; 1 means always null).
- Never include strategies the engine handles: do not hardcode FK ids.
- For columns whose name implies a fixed vocabulary (status, type, role, state, visibility, format, taxonomy, mime_type, approved, target, rel), use { "type": "enum" } with realistic values — never lorem/faker text. Examples: post_status → ["publish","draft","pending","private"], post_type → ["post","page","attachment"], comment_approved → ["1","0","spam"], comment_type → ["comment","pingback","trackback",""], link_target → ["","_blank","_self","_top"], post_mime_type → ["","image/jpeg","image/png","image/gif","image/webp","video/mp4","application/pdf"], link_rel → ["","nofollow","friend","colleague","met"].
- For columns named *_agent or user_agent use { "type": "faker", "method": "internet.userAgent" }.
- For columns named term_group, menu_order, comment_karma, link_rating, term_order that have no meaningful domain value, use { "type": "static", "value": 0 }.
- For date/datetime columns use faker methods that return Date objects: date.recent, date.past, date.future, date.between.`;
