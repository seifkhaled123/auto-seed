import { CLIError } from "./errors.js";

/**
 * Parse a --rows spec:
 *   "10"                              → { default: 10, perTable: {} }
 *   "users:25,orders:100"             → { default: undefined, perTable: { users: 25, orders: 100 } }
 *   "20,users:5"                      → { default: 20, perTable: { users: 5 } }
 */
export interface RowsSpec {
  default?: number;
  perTable: Record<string, number>;
}

export function parseRowsSpec(spec: string): RowsSpec {
  const out: RowsSpec = { perTable: {} };
  if (!spec.trim()) return out;
  const parts = spec.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const colon = p.indexOf(":");
    if (colon === -1) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0) {
        throw new CLIError(`Invalid --rows value: "${p}". Expected a non-negative integer.`, 1);
      }
      out.default = n;
    } else {
      const name = p.slice(0, colon).trim();
      const n = Number(p.slice(colon + 1).trim());
      if (!name) throw new CLIError(`Invalid --rows entry: "${p}".`, 1);
      if (!Number.isInteger(n) || n < 0) {
        throw new CLIError(`Invalid --rows value for ${name}: "${p}".`, 1);
      }
      out.perTable[name] = n;
    }
  }
  return out;
}

export function resolveRowCount(
  table: string,
  spec: RowsSpec,
  fallback = 10,
): number {
  if (spec.perTable[table] !== undefined) return spec.perTable[table]!;
  return spec.default ?? fallback;
}
