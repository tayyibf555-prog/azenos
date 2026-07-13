/**
 * Deterministic RNG for the demo seed — same inputs, same database, every
 * run. Keeps briefs/metrics testable and the simulate CLI reproducible.
 */

export function hashSeed(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;

  constructor(seedKey: string) {
    this.next = mulberry32(hashSeed(seedKey));
  }

  float(): number {
    return this.next();
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Rough poisson-ish count around a mean, always >= 0 */
  around(mean: number): number {
    return Math.max(0, Math.round(mean * (0.55 + 0.9 * this.next())));
  }

  hex(len: number): string {
    let out = "";
    while (out.length < len) {
      out += Math.floor(this.next() * 16).toString(16);
    }
    return out.slice(0, len);
  }
}
