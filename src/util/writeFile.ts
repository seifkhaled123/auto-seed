import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import { CLIError } from "./errors.js";

export interface WriteFileOptions {
  force?: boolean;
}

export async function writeFileAtomic(
  destPath: string,
  contents: string,
  opts: WriteFileOptions = {},
): Promise<void> {
  const abs = path.resolve(destPath);
  if (fs.existsSync(abs) && !opts.force) {
    const confirm = await p.confirm({
      message: `${abs} already exists. Overwrite?`,
      initialValue: false,
    });
    if (p.isCancel(confirm) || !confirm) {
      throw new CLIError("Aborted: would not overwrite existing file.", 1);
    }
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, contents, "utf8");
  await fsp.rename(tmp, abs);
}
