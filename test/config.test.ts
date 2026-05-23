import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Redirect the config path to a tmp dir for tests.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "auto-seed-test-"));
vi.mock("../src/util/paths.js", () => {
  const dir = path.join(tmpHome, ".auto-seed");
  return {
    CONFIG_DIR: dir,
    CONFIG_FILE: path.join(dir, "config.json"),
  };
});

const cfgMod = await import("../src/config/config.js");
const {
  loadConfig,
  saveConfig,
  setPath,
  getPath,
  flatten,
  maskKey,
  resolveRuntime,
  EMPTY_CONFIG,
} = cfgMod;

describe("config round-trip", () => {
  beforeEach(async () => {
    await fsp.rm(path.join(tmpHome, ".auto-seed"), { recursive: true, force: true });
  });

  it("loads empty config when file does not exist", async () => {
    const cfg = await loadConfig();
    expect(cfg).toEqual(EMPTY_CONFIG);
  });

  it("saves with 0600 perms and reads it back", async () => {
    const cfg = setPath(EMPTY_CONFIG, "apiKeys.anthropic", "sk-ant-test-abcd1234");
    await saveConfig(cfg);

    const stat = await fsp.stat(path.join(tmpHome, ".auto-seed/config.json"));
    if (process.platform !== "win32") {
      expect((stat.mode & 0o777).toString(8)).toBe("600");
    }
    const back = await loadConfig();
    expect(back.apiKeys?.anthropic).toBe("sk-ant-test-abcd1234");
  });

  it("rejects unknown set paths", () => {
    expect(() => setPath(EMPTY_CONFIG, "garbage", "x")).toThrow(/Unknown config key/);
  });

  it("validates nested set values via Zod", () => {
    expect(() => setPath(EMPTY_CONFIG, "defaults.format", "yaml" as never)).toThrow();
  });

  it("getPath reads nested values", () => {
    const cfg = setPath(EMPTY_CONFIG, "models.anthropic", "claude-opus-4-7");
    expect(getPath(cfg, "models.anthropic")).toBe("claude-opus-4-7");
    expect(getPath(cfg, "models.openai")).toBeUndefined();
  });
});

describe("masking", () => {
  it("masks long keys with prefix/suffix", () => {
    expect(maskKey("sk-ant-abcd1234efgh")).toBe("sk-a…efgh");
  });
  it("returns (unset) for undefined", () => {
    expect(maskKey(undefined)).toBe("(unset)");
  });
  it("masks short keys to ***", () => {
    expect(maskKey("short")).toBe("***");
  });
  it("flatten() masks apiKeys", () => {
    const cfg = setPath(EMPTY_CONFIG, "apiKeys.openai", "sk-openai-XYZW1234");
    const flat = flatten(cfg);
    expect(flat["apiKeys.openai"]).toMatch(/sk-o…/);
    expect(flat["apiKeys.openai"]).not.toContain("XYZW1234");
  });
});

describe("resolveRuntime precedence", () => {
  it("uses built-in default when nothing else is provided", () => {
    const cfg = setPath(EMPTY_CONFIG, "apiKeys.anthropic", "key-aaaa");
    const r = resolveRuntime(cfg, {}, {});
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-haiku-4-5-20251001");
    expect(r.apiKey).toBe("key-aaaa");
  });

  it("env var beats file for provider, model, and key", () => {
    let cfg = setPath(EMPTY_CONFIG, "provider", "anthropic");
    cfg = setPath(cfg, "apiKeys.anthropic", "file-key");
    cfg = setPath(cfg, "models.anthropic", "claude-haiku-4-5-20251001");
    const r = resolveRuntime(
      cfg,
      {},
      {
        AUTO_SEED_PROVIDER: "openai",
        AUTO_SEED_MODEL: "gpt-4o",
        OPENAI_API_KEY: "env-openai-key",
      },
    );
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-4o");
    expect(r.apiKey).toBe("env-openai-key");
  });

  it("CLI overrides beat env and file", () => {
    const cfg = setPath(
      setPath(EMPTY_CONFIG, "provider", "openai"),
      "apiKeys.anthropic",
      "k",
    );
    const r = resolveRuntime(
      cfg,
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { ANTHROPIC_API_KEY: "env-key", AUTO_SEED_PROVIDER: "openai" },
    );
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(r.apiKey).toBe("env-key");
  });

  it("fails with exit 1 when no API key found", () => {
    expect(() => resolveRuntime(EMPTY_CONFIG, {}, {})).toThrow(/No API key/);
  });
});
