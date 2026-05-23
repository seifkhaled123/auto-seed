import seedrandom from "seedrandom";
import { faker } from "@faker-js/faker";

export interface SeededRng {
  /** Float in [0, 1). */
  random(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Pick an element uniformly. */
  pick<T>(arr: readonly T[]): T;
  /** Weighted pick. weights must be same length as arr; non-negative; not all zero. */
  pickWeighted<T>(arr: readonly T[], weights: readonly number[]): T;
}

/** Fixed reference date so that faker.date.* methods are deterministic for a given seed. */
const DETERMINISTIC_REF_DATE = new Date("2026-01-01T00:00:00.000Z");

export function makeRng(seed: number | string): SeededRng {
  const rng = seedrandom(String(seed));
  // Faker shares the same seed so faker.* calls are reproducible too.
  // faker.seed accepts a 32-bit int.
  const seedInt =
    typeof seed === "number" && Number.isFinite(seed)
      ? seed | 0
      : hash32(String(seed));
  faker.seed(seedInt);
  // Pin faker's default refDate so date.recent / date.past / date.future are stable across runs.
  faker.setDefaultRefDate(DETERMINISTIC_REF_DATE);

  return {
    random: () => rng(),
    int(min, max) {
      if (max < min) [min, max] = [max, min];
      const span = max - min + 1;
      return min + Math.floor(rng() * span);
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error("pick: empty array");
      return arr[Math.floor(rng() * arr.length)]!;
    },
    pickWeighted<T>(arr: readonly T[], weights: readonly number[]): T {
      if (arr.length === 0) throw new Error("pickWeighted: empty array");
      if (arr.length !== weights.length) {
        throw new Error("pickWeighted: arr/weights length mismatch");
      }
      const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
      if (total <= 0) return this.pick(arr);
      let r = rng() * total;
      for (let i = 0; i < arr.length; i++) {
        r -= Math.max(0, weights[i]!);
        if (r <= 0) return arr[i]!;
      }
      return arr[arr.length - 1]!;
    },
  };
}

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Returns the shared, already-seeded faker singleton. */
export function getFaker(locale?: string) {
  // Locale switching is a v10 API: we just leave the singleton alone unless given a locale.
  // Faker v10 supports `new Faker({ locale: [...] })` for custom locales; for v1 we honor
  // the default English locale and surface this as a no-op for non-`en` for now.
  void locale;
  return faker;
}
