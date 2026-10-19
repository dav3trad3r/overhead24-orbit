// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Proximity screening over a catalogue: which objects stay close to each other, and which will
 * pass close in the coming hours. Positions are SGP4 (TEME, km), so results inherit SGP4's error
 * of around a kilometre at epoch, growing with element age: callers should present misses in
 * bands, never as precise distances.
 */
import { temeAtMinutes, type Vec3 } from './propagate.js';
import type { Satellite } from './satellite.js';

export interface StayingPair {
  /** NORAD numbers, a < b. */
  a: number;
  b: number;
  nowKm: number;
  /** Smallest and largest separation over the whole window. */
  minKm: number;
  maxKm: number;
}

export interface PassingPair {
  a: number;
  b: number;
  /** Time of closest approach (Unix ms). */
  tcaMs: number;
  missKm: number;
  relSpeedKmS: number;
}

export interface StayingOptions {
  /** Pairs at most this far apart now are candidates. Default 100 km. */
  radiusKm?: number;
  /** ...and are kept only if they stay within this distance the whole window. Default 200 km. */
  holdKm?: number;
  /** Window either side of `atMs`, in minutes. Default 24 h. */
  windowMin?: number;
  stepMin?: number;
}

export interface PassingOptions {
  /** Report closest approaches under this distance. Default 5 km. */
  missKm?: number;
  /** How far ahead to look, in minutes. Default 6 h. */
  horizonMin?: number;
  /** Time step of the search, in seconds. Default 10 s. */
  stepS?: number;
  /** Pairs to leave out (e.g. those already known to stay together). */
  skip?: (a: number, b: number) => boolean;
}

/** The launch part of an international designator ("2023-031A" -> "2023-031"). */
export function launchOf(objectId: string): string {
  return objectId.slice(0, 8);
}

const sameLaunch = (x: Satellite, y: Satellite) =>
  !!x.omm.OBJECT_ID && launchOf(x.omm.OBJECT_ID) === launchOf(y.omm.OBJECT_ID);

function stateAt(sat: Satellite, ms: number) {
  return temeAtMinutes(sat, (ms - sat.epochMs) / 60_000);
}

const dist = (p: Vec3, q: Vec3) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

/** Calls `visit` for every pair (i < j) of points within `cell` km, using a uniform grid. */
function nearPairs(
  points: (Vec3 | null)[],
  cell: number,
  visit: (i: number, j: number) => void,
): void {
  const grid = new Map<string, number[]>();
  points.forEach((p, i) => {
    if (!p) return;
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)},${Math.floor(p.z / cell)}`;
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  });
  for (const [key, members] of grid) {
    const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const other = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!other) continue;
          for (const i of members) {
            for (const j of other) if (j > i) visit(i, j);
          }
        }
      }
    }
  }
}

/** Pairs within `radiusKm` now that stay within `holdKm` for the whole window either side. */
export function screenStaying(
  sats: Satellite[],
  atMs: number,
  opts: StayingOptions = {},
): StayingPair[] {
  const radius = opts.radiusKm ?? 100;
  const hold = opts.holdKm ?? 200;
  const windowMin = opts.windowMin ?? 1440;
  const stepMin = opts.stepMin ?? 10;
  const now = sats.map((s) => stateAt(s, atMs)?.positionKm ?? null);
  const out: StayingPair[] = [];
  nearPairs(now, radius, (i, j) => {
    const si = sats[i] as Satellite;
    const sj = sats[j] as Satellite;
    const pi = now[i] as Vec3;
    const pj = now[j] as Vec3;
    const d0 = dist(pi, pj);
    if (d0 > radius || sameLaunch(si, sj)) return;
    let min = d0;
    let max = d0;
    for (let m = -windowMin; m <= windowMin; m += stepMin) {
      const a = stateAt(si, atMs + m * 60_000);
      const b = stateAt(sj, atMs + m * 60_000);
      if (!a || !b) return;
      const d = dist(a.positionKm, b.positionKm);
      if (d > hold) return;
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    const [a, b] = si.noradCatId < sj.noradCatId ? [si, sj] : [sj, si];
    out.push({ a: a.noradCatId, b: b.noradCatId, nowKm: d0, minKm: min, maxKm: max });
  });
  return out.sort((x, y) => x.nowKm - y.nowKm);
}

/**
 * Finds closest approaches under `missKm` in the next `horizonMin`, one time step per `step()`
 * call, so a long run can yield between steps. At each step, pairs within reach are kept only if
 * their straight-line closest approach (from relative velocity) within half a step comes under
 * twice `missKm`; each kept pair's minimum is then refined by ternary search.
 */
export class PassScreener {
  private readonly sats: Satellite[];
  private readonly atMs: number;
  private readonly missKm: number;
  private readonly stepMs: number;
  private readonly steps: number;
  private readonly reachKm: number;
  private readonly skip: PassingOptions['skip'];
  private next = 0;
  private readonly best = new Map<string, { i: number; j: number; d: number; t: number }>();

  constructor(sats: Satellite[], atMs: number, opts: PassingOptions = {}) {
    this.sats = sats;
    this.atMs = atMs;
    this.missKm = opts.missKm ?? 5;
    const stepS = opts.stepS ?? 10;
    this.stepMs = stepS * 1000;
    this.steps = Math.floor(((opts.horizonMin ?? 360) * 60) / stepS) + 1;
    // Two objects can close at up to ~16 km/s: anything that will pass within missKm during
    // the half-step either side of a sample is within this distance at the sample.
    this.reachKm = 2 * this.missKm + 16 * (stepS / 2);
    this.skip = opts.skip;
  }

  get done(): boolean {
    return this.next >= this.steps;
  }

  get progress(): number {
    return this.next / this.steps;
  }

  /** Screens one time step. Returns true once every step is done. */
  step(): boolean {
    if (this.done) return true;
    const t = this.atMs + this.next * this.stepMs;
    this.next++;
    const states = this.sats.map((s) => stateAt(s, t));
    const half = this.stepMs / 2000 + 1;
    nearPairs(
      states.map((s) => s?.positionKm ?? null),
      this.reachKm,
      (i, j) => {
        const a = states[i];
        const b = states[j];
        if (!a || !b) return;
        const rx = b.positionKm.x - a.positionKm.x;
        const ry = b.positionKm.y - a.positionKm.y;
        const rz = b.positionKm.z - a.positionKm.z;
        if (Math.hypot(rx, ry, rz) > this.reachKm) return;
        const vx = b.velocityKmS.x - a.velocityKmS.x;
        const vy = b.velocityKmS.y - a.velocityKmS.y;
        const vz = b.velocityKmS.z - a.velocityKmS.z;
        const vv = vx * vx + vy * vy + vz * vz;
        const tc =
          vv > 0 ? Math.max(-half, Math.min(half, -(rx * vx + ry * vy + rz * vz) / vv)) : 0;
        const dm = Math.hypot(rx + vx * tc, ry + vy * tc, rz + vz * tc);
        if (dm > 2 * this.missKm) return;
        const si = this.sats[i] as Satellite;
        const sj = this.sats[j] as Satellite;
        if (sameLaunch(si, sj) || this.skip?.(si.noradCatId, sj.noradCatId)) return;
        const key = `${i}:${j}`;
        const prev = this.best.get(key);
        if (!prev || dm < prev.d) this.best.set(key, { i, j, d: dm, t: t + tc * 1000 });
      },
    );
    return this.done;
  }

  /** Refined closest approaches under `missKm`, soonest first. */
  results(): PassingPair[] {
    const out: PassingPair[] = [];
    for (const c of this.best.values()) {
      const si = this.sats[c.i] as Satellite;
      const sj = this.sats[c.j] as Satellite;
      const sep = (ms: number) => {
        const a = stateAt(si, ms);
        const b = stateAt(sj, ms);
        return a && b ? dist(a.positionKm, b.positionKm) : Number.POSITIVE_INFINITY;
      };
      let lo = c.t - this.stepMs;
      let hi = c.t + this.stepMs;
      for (let k = 0; k < 40; k++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        if (sep(m1) < sep(m2)) hi = m2;
        else lo = m1;
      }
      const tca = (lo + hi) / 2;
      const miss = sep(tca);
      if (!(miss <= this.missKm) || tca < this.atMs) continue;
      const a = stateAt(si, tca);
      const b = stateAt(sj, tca);
      if (!a || !b) continue;
      const rel = Math.hypot(
        a.velocityKmS.x - b.velocityKmS.x,
        a.velocityKmS.y - b.velocityKmS.y,
        a.velocityKmS.z - b.velocityKmS.z,
      );
      const [x, y] = si.noradCatId < sj.noradCatId ? [si, sj] : [sj, si];
      out.push({
        a: x.noradCatId,
        b: y.noradCatId,
        tcaMs: Math.round(tca),
        missKm: miss,
        relSpeedKmS: rel,
      });
    }
    return out.sort((p, q) => p.tcaMs - q.tcaMs);
  }
}

/** Runs a PassScreener to completion in one go (tests, small catalogues). */
export function screenPassing(
  sats: Satellite[],
  atMs: number,
  opts: PassingOptions = {},
): PassingPair[] {
  const s = new PassScreener(sats, atMs, opts);
  while (!s.step()) {
    // every step
  }
  return s.results();
}
