// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { alongTrackKm, closestApproach, meanAltitudeKm } from '../src/encounter.js';
import { parseOmmArray } from '../src/omm.js';
import { satelliteFromOmm } from '../src/satellite.js';
import omms from './fixtures/proximity-omm-2026-10-19.json' with { type: 'json' };

// TerraSAR-X's real elements, plus a constructed neighbour 0.3° behind it in a plane turned 0.3°,
// going slightly faster: it catches up in about 7 hours.
const base = omms.find((o) => o.NORAD_CAT_ID === 31698) as (typeof omms)[number];
const neighbour = {
  ...base,
  NORAD_CAT_ID: 900003,
  OBJECT_ID: '2099-003A',
  OBJECT_NAME: 'CHASER',
  MEAN_ANOMALY: base.MEAN_ANOMALY - 0.3,
  RA_OF_ASC_NODE: base.RA_OF_ASC_NODE + 0.3,
  MEAN_MOTION: base.MEAN_MOTION + 0.003,
};
const [tsx, chaser] = parseOmmArray([base, neighbour]).records.map(satelliteFromOmm) as [
  ReturnType<typeof satelliteFromOmm>,
  ReturnType<typeof satelliteFromOmm>,
];
const T = Date.parse(`${base.EPOCH}Z`);
const H = 3600_000;

describe('closestApproach', () => {
  const c = closestApproach(chaser, tsx, T, T + 3 * 24 * H);

  it('finds the closest point of the encounter and splits the miss three ways', () => {
    expect(c).not.toBeNull();
    if (!c) return;
    expect(c.atWindowEnd).toBe(false);
    expect(c.tcaMs).toBeGreaterThan(T + 3 * H);
    expect(c.tcaMs).toBeLessThan(T + 12 * H);
    expect(Math.hypot(c.radialKm, c.inTrackKm, c.crossTrackKm)).toBeCloseTo(c.missKm, 6);
    // A real minimum: a minute either side is farther.
    for (const dt of [-60_000, 60_000]) {
      const later = closestApproach(chaser, tsx, c.tcaMs + dt, c.tcaMs + dt);
      expect(later?.missKm).toBeGreaterThan(c.missKm);
    }
    // The planes are 0.3° apart, so the relative speed is mostly cross-track: tens of m/s.
    expect(c.relSpeedKmS * 1000).toBeGreaterThan(10);
    expect(c.relSpeedKmS * 1000).toBeLessThan(100);
  });

  it('reports the next-closest crossing too', () => {
    expect(c?.runnerUp).not.toBeNull();
    expect(c?.runnerUp?.missKm).toBeGreaterThanOrEqual(c?.missKm ?? 0);
  });

  it('says when the pair is still closing at the end of the window', () => {
    // In the same plane the gap only shrinks (no plane crossings to make minima of their own).
    const sameRaan = { ...neighbour, RA_OF_ASC_NODE: base.RA_OF_ASC_NODE };
    const [inPlane] = parseOmmArray([sameRaan]).records.map(satelliteFromOmm);
    if (!inPlane) throw new Error('constructed elements did not parse');
    const early = closestApproach(inPlane, tsx, T, T + H);
    expect(early?.atWindowEnd).toBe(true);
    expect(early?.tcaMs).toBe(T + H);
  });
});

describe('alongTrackKm and meanAltitudeKm', () => {
  it('puts the chaser behind, catching up', () => {
    const now = alongTrackKm(chaser, tsx, T) as number;
    const later = alongTrackKm(chaser, tsx, T + 2 * H) as number;
    expect(now).toBeLessThan(-20);
    expect(later).toBeGreaterThan(now);
    expect(alongTrackKm(tsx, chaser, T)).toBeGreaterThan(20);
  });

  it('gives the mean altitude from the mean motion', () => {
    expect(meanAltitudeKm(tsx)).toBeGreaterThan(500);
    expect(meanAltitudeKm(tsx)).toBeLessThan(530);
    expect(meanAltitudeKm(chaser)).toBeLessThan(meanAltitudeKm(tsx));
  });
});
