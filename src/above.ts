// SPDX-License-Identifier: AGPL-3.0-only
import {
  type LookAngles,
  lookAnglesFromEcef,
  type Observer,
  observerGeodetic,
} from './observer.js';
import { propagateAt } from './propagate.js';
import type { Satellite } from './satellite.js';
import { isSunlit, sunEciAu } from './sun.js';

export interface SkyObject extends LookAngles {
  noradCatId: number;
  name: string;
  /** Height above the WGS-84 ellipsoid, km. */
  heightKm: number;
  sunlit: boolean;
}

/**
 * Every satellite at or above `minElevationDeg` (default 0, the geometric horizon) for an
 * observer at one instant. Objects SGP4 can't propagate (decayed, errors) are left out.
 */
export function objectsAbove(
  sats: readonly Satellite[],
  observer: Observer,
  date: Date,
  opts: { minElevationDeg?: number } = {},
): SkyObject[] {
  const minEl = opts.minElevationDeg ?? 0;
  const geo = observerGeodetic(observer);
  const sunAu = sunEciAu(date);
  const out: SkyObject[] = [];
  for (const sat of sats) {
    const s = propagateAt(sat, date);
    if (!s) continue;
    const la = lookAnglesFromEcef(geo, s.ecefKm);
    if (la.elevationDeg < minEl) continue;
    out.push({
      noradCatId: sat.noradCatId,
      name: sat.name,
      ...la,
      heightKm: s.heightKm,
      sunlit: isSunlit(s, sunAu),
    });
  }
  return out;
}
