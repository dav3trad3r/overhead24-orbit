// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One encounter between two satellites on their current element sets: the closest approach in a
 * time window, with the miss split into radial / in-track / cross-track, and how fast one is
 * gaining on the other along the orbit.
 *
 * Co-orbital pairs pass through two near-equal minima per orbit, where their planes cross, so the
 * second-closest is returned too: as new element sets arrive, which of the two is closest can flip.
 */
import { temeAtMinutes, type Vec3 } from './propagate.js';
import type { Satellite } from './satellite.js';

const MU = 398600.4418;
const RE_KM = 6378.137;

export interface Miss {
  /** Time of closest approach (ms since the epoch). */
  tcaMs: number;
  missKm: number;
}

export interface ClosestApproach extends Miss {
  /** First satellite relative to the second, in the second's frame at closest approach (km). */
  radialKm: number;
  inTrackKm: number;
  crossTrackKm: number;
  /** Relative speed at closest approach (km/s). */
  relSpeedKmS: number;
  /** The distance is still falling at the end of the window: the real closest is later. */
  atWindowEnd: boolean;
  /** The next-closest local minimum in the window, if any. */
  runnerUp: Miss | null;
}

const sub = (u: Vec3, v: Vec3): Vec3 => ({ x: u.x - v.x, y: u.y - v.y, z: u.z - v.z });
const dot = (u: Vec3, v: Vec3) => u.x * v.x + u.y * v.y + u.z * v.z;
const norm = (u: Vec3) => Math.hypot(u.x, u.y, u.z);
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const unit = (u: Vec3): Vec3 => {
  const n = norm(u);
  return { x: u.x / n, y: u.y / n, z: u.z / n };
};

const stateAt = (s: Satellite, ms: number) => temeAtMinutes(s, (ms - s.epochMs) / 60_000);

function distanceAt(a: Satellite, b: Satellite, ms: number): number | null {
  const p = stateAt(a, ms);
  const q = stateAt(b, ms);
  return p && q ? norm(sub(p.positionKm, q.positionKm)) : null;
}

/** Golden-section search for the minimum distance in [lo, hi], to about a millisecond. */
function refine(a: Satellite, b: Satellite, lo: number, hi: number): Miss {
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = distanceAt(a, b, x1) ?? Number.POSITIVE_INFINITY;
  let f2 = distanceAt(a, b, x2) ?? Number.POSITIVE_INFINITY;
  while (hi - lo > 1) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - g * (hi - lo);
      f1 = distanceAt(a, b, x1) ?? Number.POSITIVE_INFINITY;
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + g * (hi - lo);
      f2 = distanceAt(a, b, x2) ?? Number.POSITIVE_INFINITY;
    }
  }
  return f1 < f2 ? { tcaMs: x1, missKm: f1 } : { tcaMs: x2, missKm: f2 };
}

/**
 * The closest approach of `a` and `b` between `fromMs` and `toMs`, scanning every `stepS` seconds
 * (default 20 s, fine for co-orbital pairs, whose relative speeds are metres to hundreds of metres
 * a second) and refining each local minimum. Null if either can't be propagated.
 */
export function closestApproach(
  a: Satellite,
  b: Satellite,
  fromMs: number,
  toMs: number,
  opts: { stepS?: number } = {},
): ClosestApproach | null {
  const step = (opts.stepS ?? 20) * 1000;
  const minima: Miss[] = [];
  let prev2: number | null = null;
  let prev: number | null = null;
  let first: number | null = null;
  let last: number | null = null;
  for (let t = fromMs; t <= toMs; t += step) {
    const d = distanceAt(a, b, t);
    if (d === null) return null;
    if (first === null) first = d;
    if (prev2 !== null && prev !== null && prev <= prev2 && prev < d) {
      minima.push(refine(a, b, t - 2 * step, t));
    }
    prev2 = prev;
    prev = d;
    last = d;
  }
  if (first === null || prev === null || last === null) return null;
  // Falling at either edge: the window's end (or start) is its own minimum.
  const atWindowEnd = prev2 !== null && last < prev2;
  if (atWindowEnd) minima.push({ tcaMs: toMs, missKm: last });
  if (minima.length === 0) minima.push({ tcaMs: fromMs, missKm: first });
  minima.sort((x, y) => x.missKm - y.missKm);
  const best = minima[0] as Miss;

  const p = stateAt(a, best.tcaMs);
  const q = stateAt(b, best.tcaMs);
  if (!p || !q) return null;
  const r = unit(q.positionKm);
  const h = unit(cross(q.positionKm, q.velocityKmS));
  const i = cross(h, r);
  const rel = sub(p.positionKm, q.positionKm);
  return {
    ...best,
    radialKm: dot(rel, r),
    inTrackKm: dot(rel, i),
    crossTrackKm: dot(rel, h),
    relSpeedKmS: norm(sub(p.velocityKmS, q.velocityKmS)),
    atWindowEnd: atWindowEnd && best.tcaMs === toMs,
    runnerUp: minima[1] ?? null,
  };
}

/**
 * How far `a` is ahead of `b` along `b`'s orbit at `ms` (km of arc at `b`'s radius; negative when
 * behind). Meaningful while the two are less than half an orbit apart.
 */
export function alongTrackKm(a: Satellite, b: Satellite, ms: number): number | null {
  const p = stateAt(a, ms);
  const q = stateAt(b, ms);
  if (!p || !q) return null;
  const h = unit(cross(q.positionKm, q.velocityKmS));
  const angle = Math.atan2(
    dot(cross(q.positionKm, p.positionKm), h),
    dot(q.positionKm, p.positionKm),
  );
  return angle * norm(q.positionKm);
}

/** Mean altitude from the element set's mean motion (km above the equatorial radius). */
export function meanAltitudeKm(s: Satellite): number {
  const n = (s.omm.MEAN_MOTION * 2 * Math.PI) / 86_400;
  return Math.cbrt(MU / (n * n)) - RE_KM;
}
