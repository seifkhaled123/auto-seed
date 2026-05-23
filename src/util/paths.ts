import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".auto-seed");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
