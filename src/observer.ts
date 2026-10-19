// SPDX-License-Identifier: AGPL-3.0-only
import {
  degreesToRadians,
  ecfToLookAngles,
  type GeodeticLocation,
  radiansToDegrees,
} from 'satellite.js';
import type { SatState, Vec3 } from './propagate.js';

/** A place on Earth: WGS-84 geodetic latitude/longitude and height above the ellipsoid. */
export interface Observer {
  latitudeDeg: number;
  longitudeDeg: number;
  heightKm: number;
}

/** Where a satellite appears from an observer. Azimuth is clockwise from true north. */
export interface LookAngles {
  azimuthDeg: number;
  elevationDeg: number;
  rangeKm: number;
}

export function assertObserver(o: Observer): void {
  const ok =
    Number.isFinite(o.latitudeDeg) &&
    Math.abs(o.latitudeDeg) <= 90 &&
    Number.isFinite(o.longitudeDeg) &&
    Math.abs(o.longitudeDeg) <= 180 &&
    Number.isFinite(o.heightKm) &&
    o.heightKm > -0.5 &&
    o.heightKm < 10;
  if (!ok) throw new RangeError(`Invalid observer ${JSON.stringify(o)}`);
}

export function observerGeodetic(o: Observer): GeodeticLocation {
  return {
    latitude: degreesToRadians(o.latitudeDeg),
    longitude: degreesToRadians(o.longitudeDeg),
    height: o.heightKm,
  };
}

/** Topocentric azimuth, elevation (geometric, no refraction) and range of an Earth-fixed point. */
export function lookAnglesFromEcef(observer: GeodeticLocation, ecefKm: Vec3): LookAngles {
  const la = ecfToLookAngles(observer, ecefKm);
  return {
    azimuthDeg: radiansToDegrees(la.azimuth),
    elevationDeg: radiansToDegrees(la.elevation),
    rangeKm: la.rangeSat,
  };
}

export function lookAngles(observer: Observer, state: SatState): LookAngles {
  return lookAnglesFromEcef(observerGeodetic(observer), state.ecefKm);
}

const COMPASS_16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

export type CompassPoint = (typeof COMPASS_16)[number];

/** 16-point compass direction for an azimuth. */
export function compassPoint(azimuthDeg: number): CompassPoint {
  const i = Math.round((((azimuthDeg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_16[i] as CompassPoint;
}
