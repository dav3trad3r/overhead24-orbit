// SPDX-License-Identifier: AGPL-3.0-only
import {
  checkForDecay,
  eciToEcf,
  eciToGeodetic,
  gstime,
  radiansToDegrees,
  SatRecError,
  sgp4,
} from 'satellite.js';
import type { Satellite } from './satellite.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A satellite's state at one instant. */
export interface SatState {
  date: Date;
  /** Minutes from the element-set epoch (negative before it). */
  minutesFromEpoch: number;
  /** SGP4 output in the TEME frame: position in km, velocity in km/s. */
  temePositionKm: Vec3;
  temeVelocityKmS: Vec3;
  /** Greenwich mean sidereal time used for the Earth-fixed conversion (radians, IAU-82). */
  gmstRad: number;
  /** Earth-fixed position (km). */
  ecefKm: Vec3;
  /** WGS-84 geodetic sub-satellite point and height above the ellipsoid. */
  latitudeDeg: number;
  longitudeDeg: number;
  heightKm: number;
  /** Inertial speed (km/s). */
  speedKmS: number;
}

export interface PropagateOptions {
  /**
   * Discard positions for objects that decayed long ago, which plain SGP4 can return as
   * garbage instead of an error (satellite.js community check). Default true. The SGP4
   * verification tests turn it off to compare the unmodified algorithm.
   */
  decayCheck?: boolean;
}

/**
 * Propagates with SGP4/SDP4 to `date`. Returns null when SGP4 reports an error or the object has
 * decayed; `sat.satrec.error` then holds the reason.
 *
 * Time since epoch is computed here from the full-precision epoch (see `ommEpochMs`) instead of
 * through satellite.js's `propagate`, whose OMM path rounds the epoch to whole milliseconds.
 *
 * Earth-fixed conversion: TEME -> pseudo-Earth-fixed by GMST (IAU-82) evaluated with UT1 = UTC,
 * no polar motion. UT1-UTC is kept within 0.9 s, so this shifts the sub-satellite point east-west
 * by at most ~0.4 km at the equator; in practice (|UT1-UTC| ~ 0.1 s) by tens of metres, far
 * below SGP4's own error of around a kilometre per day of element age.
 */
export function propagateAt(
  sat: Satellite,
  date: Date,
  opts: PropagateOptions = {},
): SatState | null {
  const minutesFromEpoch = (date.getTime() - sat.epochMs) / 60_000;
  const pv = sgp4(sat.satrec, minutesFromEpoch);
  if (!pv || sat.satrec.error !== SatRecError.None) return null;
  if ((opts.decayCheck ?? true) && checkForDecay(sat.satrec)) {
    sat.satrec.error = SatRecError.Decayed;
    return null;
  }
  const gmstRad = gstime(date);
  const ecef = eciToEcf(pv.position, gmstRad);
  const geo = eciToGeodetic(pv.position, gmstRad);
  const v = pv.velocity;
  return {
    date,
    minutesFromEpoch,
    temePositionKm: { x: pv.position.x, y: pv.position.y, z: pv.position.z },
    temeVelocityKmS: { x: v.x, y: v.y, z: v.z },
    gmstRad,
    ecefKm: { x: ecef.x, y: ecef.y, z: ecef.z },
    latitudeDeg: radiansToDegrees(geo.latitude),
    longitudeDeg: wrapLongitude(radiansToDegrees(geo.longitude)),
    heightKm: geo.height,
    speedKmS: Math.hypot(v.x, v.y, v.z),
  };
}

/**
 * Raw SGP4/SDP4 output in TEME at an exact time offset from the element-set epoch, for callers
 * that need sub-millisecond timing (a Date can't represent it). Null on SGP4 error or decay.
 */
export function temeAtMinutes(
  sat: Satellite,
  minutesFromEpoch: number,
  opts: PropagateOptions = {},
): { positionKm: Vec3; velocityKmS: Vec3 } | null {
  const pv = sgp4(sat.satrec, minutesFromEpoch);
  if (!pv || sat.satrec.error !== SatRecError.None) return null;
  if ((opts.decayCheck ?? true) && checkForDecay(sat.satrec)) {
    sat.satrec.error = SatRecError.Decayed;
    return null;
  }
  return {
    positionKm: { x: pv.position.x, y: pv.position.y, z: pv.position.z },
    velocityKmS: { x: pv.velocity.x, y: pv.velocity.y, z: pv.velocity.z },
  };
}

/** Wraps a longitude into [-180, 180). */
export function wrapLongitude(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}
