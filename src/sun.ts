// SPDX-License-Identifier: AGPL-3.0-only
import { Observer as AstroObserver, Body, Equator, Horizon } from 'astronomy-engine';
import { type EciVec3, jday, shadowFraction, sunPos } from 'satellite.js';
import type { Observer } from './observer.js';
import type { SatState } from './propagate.js';

/** Sun altitudes that bound the twilights (degrees, Sun centre, no refraction). */
export const TWILIGHT_DEG = { civil: -6, nautical: -12, astronomical: -18 } as const;

/**
 * A satellite counts as sunlit when less than this fraction of the Sun's disc is hidden by the
 * Earth, i.e. the Sun's centre is still visible from it.
 */
export const SUNLIT_MAX_SHADOW_FRACTION = 0.5;

/**
 * Topocentric altitude of the Sun's centre in degrees, geometric (no atmospheric refraction),
 * from astronomy-engine (apparent position of date, light-time and aberration corrected).
 */
export function sunAltitudeDeg(observer: Observer, date: Date): number {
  const obs = new AstroObserver(
    observer.latitudeDeg,
    observer.longitudeDeg,
    observer.heightKm * 1000,
  );
  const eq = Equator(Body.Sun, date, obs, true, true);
  return Horizon(date, obs, eq.ra, eq.dec).altitude;
}

/** Geocentric Sun position (AU, ECI) from satellite.js's low-precision model (~0.01 deg). */
export function sunEciAu(date: Date): EciVec3<number> {
  return sunPos(jday(date)).rsun;
}

/**
 * Fraction of the Sun's disc hidden by the Earth as seen from the satellite: 0 fully lit,
 * 1 in umbra, between in penumbra.
 */
export function shadowFractionAt(
  state: SatState,
  sunAu: EciVec3<number> = sunEciAu(state.date),
): number {
  return shadowFraction(sunAu, state.temePositionKm);
}

export function isSunlit(state: SatState, sunAu?: EciVec3<number>): boolean {
  return shadowFractionAt(state, sunAu) < SUNLIT_MAX_SHADOW_FRACTION;
}
