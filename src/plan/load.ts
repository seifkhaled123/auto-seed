import fsp from "node:fs/promises";
import { CLIError } from "../util/errors.js";
import { SeedPlan } from "./schema.js";

export async function loadPlanFromDisk(path: string): Promise<SeedPlan> {
  let raw: string;
  try {
    raw = await fsp.readFile(path, "utf8");
  } catch (err) {
    throw new CLIError(
      `Could not read plan file: ${path}`,
      1,
      (err as Error).message,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new CLIError(
      `Plan file is not valid JSON: ${path}`,
      1,
      (err as Error).message,
    );
  }
  const parsed = SeedPlan.safeParse(json);
  if (!parsed.success) {
    throw new CLIError(
      `Plan file failed validation.`,
      1,
      parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    );
  }
  return parsed.data;
}
