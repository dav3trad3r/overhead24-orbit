// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Watched satellites (e.g. military ones) in nearly the same orbit as another object, getting
 * closer. Only co-orbital pairs are considered: for objects on crossing orbits the distance at any
 * one moment is chance, but for two objects sharing a plane and height, separation changes
 * slowly and steadily, so three samples a day apart show a real trend.
 *
 * Distances use the current element sets for all three samples, so the trend is "on their present
 * orbits": a manoeuvre in the window changes it.
 */
import { temeAtMinutes, type Vec3 } from './propagate.js';
import { launchOf } from './proximity.js';
import type { Satellite } from './satellite.js';

export interface ApproachingPair {
  /** NORAD numbers, a < b. */
  a: number;
  b: number;
  /** Separation `spanMin` before, at, and after the screening time (km). */
  kmBefore: number;
  kmNow: number;
  kmAfter: number;
}

export interface ApproachingOptions {
  /** Which objects to watch; pairs need at least one watched member. */
  watch: (sat: Satellite) => boolean;
  /** Look at pairs at most this far apart now. Default: 200 km in LEO, 500 km above. */
  radiusKm?: (sat: Satellite) => number;
  /** Time either side of the screening time, minutes. Default 24 h. */
  spanMin?: number;
  /** Orbit planes at most this far apart, degrees. Default 1°. */
  maxPlaneAngleDeg?: number;
  /** Semi-major axes at most this far apart, km. Default 100 km. */
  maxDeltaAKm?: number;
  /** Separation must fall by at least this much across the whole span, km. Default 40 km. */
  minClosingKm?: number;
}

const RE_KM = 6378.135;
const dist = (p: Vec3, q: Vec3) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function defaultRadius(sat: Satellite): number {
  return 1440 / sat.omm.MEAN_MOTION < 128 ? 200 : 500;
}

function planeAngleDeg(p: { positionKm: Vec3; velocityKmS: Vec3 }, q: typeof p): number {
  const h1 = cross(p.positionKm, p.velocityKmS);
  const h2 = cross(q.positionKm, q.velocityKmS);
  const c =
    (h1.x * h2.x + h1.y * h2.y + h1.z * h2.z) /
    (Math.hypot(h1.x, h1.y, h1.z) * Math.hypot(h2.x, h2.y, h2.z));
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

export function screenApproaching(
  sats: Satellite[],
  atMs: number,
  opts: ApproachingOptions,
): ApproachingPair[] {
  const span = opts.spanMin ?? 1440;
  const radiusOf = opts.radiusKm ?? defaultRadius;
  const maxAngle = opts.maxPlaneAngleDeg ?? 1;
  const maxDa = opts.maxDeltaAKm ?? 100;
  const minClosing = opts.minClosingKm ?? 40;
  const at = (s: Satellite, ms: number) => temeAtMinutes(s, (ms - s.epochMs) / 60_000);

  const now = sats.map((s) => at(s, atMs));
  const cell = Math.max(...sats.map(radiusOf), 1);
  const grid = new Map<string, number[]>();
  const keyOf = (p: Vec3, dx = 0, dy = 0, dz = 0) =>
    `${Math.floor(p.x / cell) + dx},${Math.floor(p.y / cell) + dy},${Math.floor(p.z / cell) + dz}`;
  now.forEach((st, i) => {
    if (!st) return;
    const k = keyOf(st.positionKm);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });

  const seen = new Set<string>();
  const out: ApproachingPair[] = [];
  sats.forEach((w, i) => {
    const sw = now[i];
    if (!sw || !opts.watch(w)) return;
    const radius = radiusOf(w);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of grid.get(keyOf(sw.positionKm, dx, dy, dz)) ?? []) {
            if (j === i) continue;
            const o = sats[j] as Satellite;
            const so = now[j];
            if (!so) continue;
            const kmNow = dist(sw.positionKm, so.positionKm);
            if (kmNow > radius) continue;
            const [a, b] = w.noradCatId < o.noradCatId ? [w, o] : [o, w];
            const key = `${a.noradCatId}:${b.noradCatId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (w.omm.OBJECT_ID && launchOf(w.omm.OBJECT_ID) === launchOf(o.omm.OBJECT_ID)) {
              continue;
            }
            if (Math.abs(w.satrec.a - o.satrec.a) * RE_KM > maxDa) continue;
            if (planeAngleDeg(sw, so) > maxAngle) continue;
            const pb = at(w, atMs - span * 60_000);
            const qb = at(o, atMs - span * 60_000);
            const pa = at(w, atMs + span * 60_000);
            const qa = at(o, atMs + span * 60_000);
            if (!pb || !qb || !pa || !qa) continue;
            const kmBefore = dist(pb.positionKm, qb.positionKm);
            const kmAfter = dist(pa.positionKm, qa.positionKm);
            const closing =
              kmBefore >= kmNow && kmNow >= kmAfter && kmBefore - kmAfter >= minClosing;
            if (closing) {
              out.push({ a: a.noradCatId, b: b.noradCatId, kmBefore, kmNow, kmAfter });
            }
          }
        }
      }
    }
  });
  return out.sort((x, y) => x.kmNow - y.kmNow);
}
