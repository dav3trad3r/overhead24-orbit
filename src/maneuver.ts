// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Manoeuvre detection from two consecutive element sets of one object. The older set is
 * propagated to the newer set's epoch and the two are compared: a change in orbit size (less the
 * drag decay the older set itself predicts) or in tilt beyond what the object's kind of orbit
 * normally shows between updates means it fired its engines.
 *
 * The thresholds come from real catalogue updates (CelesTrak active group, 19 Oct 2026, ~15,900
 * consecutive pairs). Typical update-to-update noise in semi-major axis / inclination:
 *   LEO (not Starlink)  99th percentile 0.15 km / 0.002°
 *   MEO                 99th percentile 0.03 km / 0.004°
 *   GEO                 99th percentile 1.3 km  / 0.023°  (includes routine station-keeping)
 *   HEO                 semi-major axis swings by up to ~190 km on SDP4 refits; only tilt is used
 * Starlink satellites adjust their orbits almost continuously (99th percentile 1.4 km), so callers
 * should leave them out rather than report a stream of routine burns.
 */
import { temeAtMinutes, type Vec3 } from './propagate.js';
import type { Satellite } from './satellite.js';

export type ManeuverRegime = 'LEO' | 'MEO' | 'GEO' | 'HEO';

/** How a newer element set differs from an older one propagated to the newer epoch. */
export interface ElementSetChange {
  noradCatId: number;
  regime: ManeuverRegime;
  /** Hours between the two epochs. */
  hours: number;
  /** Change in semi-major axis, less the drag drift the older set predicts (km). */
  deltaAKm: number;
  /** Change in inclination (degrees). */
  deltaIDeg: number;
  /** Distance between the two predictions at the newer epoch, and its components (km). */
  residualKm: number;
  radialKm: number;
  inTrackKm: number;
  crossTrackKm: number;
}

export interface ManeuverThreshold {
  /** A change at least this large is a manoeuvre; null means not used for this regime. */
  aKm: number | null;
  iDeg: number;
  /** ...and at least this large, a large one (a relocation rather than station-keeping). */
  largeAKm: number | null;
  largeIDeg: number;
}

export const MANEUVER_THRESHOLDS: Record<ManeuverRegime, ManeuverThreshold> = {
  LEO: { aKm: 0.5, iDeg: 0.01, largeAKm: 5, largeIDeg: 0.05 },
  MEO: { aKm: 0.3, iDeg: 0.01, largeAKm: 3, largeIDeg: 0.05 },
  GEO: { aKm: 1.5, iDeg: 0.03, largeAKm: 10, largeIDeg: 0.1 },
  HEO: { aKm: null, iDeg: 0.02, largeAKm: null, largeIDeg: 0.1 },
};

/** Element sets further apart than this aren't compared: drift predictions get unreliable. */
export const MANEUVER_MAX_GAP_HOURS = 240;

/** WGS-72 Earth radius, the unit of satellite.js's semi-major axis. */
const RE_KM = 6378.135;

export function maneuverRegime(sat: Satellite): ManeuverRegime {
  const periodMin = 1440 / sat.omm.MEAN_MOTION;
  const e = sat.omm.ECCENTRICITY;
  if (e > 0.25) return 'HEO';
  if (periodMin > 1300 && periodMin < 1600 && e < 0.05) return 'GEO';
  if (periodMin >= 225) return 'MEO';
  return 'LEO';
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / n, y: a.y / n, z: a.z / n };
};

/**
 * Compares `next` with `prev` propagated to `next`'s epoch. Null if `next` isn't newer, the gap
 * is too long to judge, or either set can't be propagated.
 */
export function compareElementSets(prev: Satellite, next: Satellite): ElementSetChange | null {
  const minutes = (next.epochMs - prev.epochMs) / 60_000;
  const hours = minutes / 60;
  if (minutes <= 0 || hours > MANEUVER_MAX_GAP_HOURS) return null;
  const old = temeAtMinutes(prev, minutes);
  const now = temeAtMinutes(next, 0);
  if (!old || !now) return null;

  const r = now.positionKm;
  const R = unit(r);
  const C = unit(cross(r, now.velocityKmS));
  const I = cross(C, R);
  const d = sub(now.positionKm, old.positionKm);

  // MEAN_MOTION_DOT is half the rate of change of mean motion (rev/day²), as in a TLE.
  const aKm = prev.satrec.a * RE_KM;
  const expectedDn = 2 * prev.omm.MEAN_MOTION_DOT * (hours / 24);
  const expectedDaKm = (-(2 / 3) * aKm * expectedDn) / prev.omm.MEAN_MOTION;
  return {
    noradCatId: next.noradCatId,
    regime: maneuverRegime(next),
    hours,
    deltaAKm: (next.satrec.a - prev.satrec.a) * RE_KM - expectedDaKm,
    deltaIDeg: next.omm.INCLINATION - prev.omm.INCLINATION,
    residualKm: Math.hypot(d.x, d.y, d.z),
    radialKm: dot(d, R),
    inTrackKm: dot(d, I),
    crossTrackKm: dot(d, C),
  };
}

/** 'large', 'small', or null when the change is within normal update-to-update noise. */
export function maneuverSize(change: ElementSetChange): 'small' | 'large' | null {
  const t = MANEUVER_THRESHOLDS[change.regime];
  const da = Math.abs(change.deltaAKm);
  const di = Math.abs(change.deltaIDeg);
  const large = (t.largeAKm !== null && da >= t.largeAKm) || di >= t.largeIDeg;
  if (large) return 'large';
  const any = (t.aKm !== null && da >= t.aKm) || di >= t.iDeg;
  return any ? 'small' : null;
}
