// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from 'satellite.js';
import type { Satellite } from './satellite.js';

/**
 * Orbit classes derived from mean elements. These are this app's labels, with the thresholds in
 * ORBIT_CLASS_RULES; the UI presents them as derived, not as an official designation.
 */
export type OrbitClass = 'LEO' | 'MEO' | 'GEO' | 'GSO' | 'HEO' | 'BEYOND_GEO';

export const ORBIT_CLASS_RULES = {
  /** Low Earth orbit: apogee below this height (km). */
  leoMaxApogeeKm: 2000,
  /** Highly elliptical: eccentricity at or above this. */
  heoMinEccentricity: 0.25,
  /** One sidereal day (min). */
  siderealDayMin: 1436.0682,
  /** Geosynchronous: period within this of a sidereal day (min). */
  geosyncPeriodToleranceMin: 30,
  /** Geostationary: geosynchronous and also below these. */
  geoMaxEccentricity: 0.01,
  geoMaxInclinationDeg: 5,
  /** Sun-synchronous: nodal drift within this of the Sun's mean motion (deg/day). */
  ssoToleranceDegPerDay: 0.05,
} as const;

/** The Sun's mean apparent motion along the ecliptic: 360 degrees per tropical year. */
const SUN_MEAN_MOTION_DEG_PER_DAY = 360 / 365.2422;

export interface OrbitSummary {
  orbitClass: OrbitClass;
  sunSynchronous: boolean;
  periodMin: number;
  semiMajorAxisKm: number;
  /** Heights above the equatorial radius (WGS-72, 6378.135 km), as in the SATCAT. */
  perigeeKm: number;
  apogeeKm: number;
  inclinationDeg: number;
  eccentricity: number;
  /** Secular drift of the ascending node from J2 (deg/day). */
  nodalDriftDegPerDay: number;
}

/** Orbit size, shape and class from the SGP4-initialised (Brouwer) mean elements. */
export function summarizeOrbit(sat: Satellite): OrbitSummary {
  const r = sat.satrec;
  const re = constants.earthRadius;
  const a = r.a * re;
  const e = r.ecco;
  const i = r.inclo;
  const periodMin = (2 * Math.PI) / r.no;
  const perigeeKm = a * (1 - e) - re;
  const apogeeKm = a * (1 + e) - re;
  const p = r.a * (1 - e * e); // semi-latus rectum, Earth radii
  const nodalDriftRadPerMin = (-1.5 * r.no * constants.j2 * Math.cos(i)) / (p * p);
  const nodalDriftDegPerDay = (nodalDriftRadPerMin * 1440 * 180) / Math.PI;
  const inclinationDeg = (i * 180) / Math.PI;

  const R = ORBIT_CLASS_RULES;
  let orbitClass: OrbitClass;
  if (e >= R.heoMinEccentricity) orbitClass = 'HEO';
  else if (Math.abs(periodMin - R.siderealDayMin) <= R.geosyncPeriodToleranceMin) {
    orbitClass =
      e < R.geoMaxEccentricity && inclinationDeg < R.geoMaxInclinationDeg ? 'GEO' : 'GSO';
  } else if (apogeeKm < R.leoMaxApogeeKm) orbitClass = 'LEO';
  else if (periodMin < R.siderealDayMin) orbitClass = 'MEO';
  else orbitClass = 'BEYOND_GEO';

  return {
    orbitClass,
    sunSynchronous:
      orbitClass === 'LEO' &&
      Math.abs(nodalDriftDegPerDay - SUN_MEAN_MOTION_DEG_PER_DAY) <= R.ssoToleranceDegPerDay,
    periodMin,
    semiMajorAxisKm: a,
    perigeeKm,
    apogeeKm,
    inclinationDeg,
    eccentricity: e,
    nodalDriftDegPerDay,
  };
}
