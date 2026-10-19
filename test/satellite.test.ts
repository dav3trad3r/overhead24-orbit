// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { objectsAbove } from '../src/above.js';
import { compassPoint, lookAngles, type Observer } from '../src/observer.js';
import { type Omm, ommEpochMs, parseOmmArray } from '../src/omm.js';
import { summarizeOrbit } from '../src/orbit-summary.js';
import { propagateAt, temeAtMinutes, wrapLongitude } from '../src/propagate.js';
import {
  elementSetAgeDays,
  type Satellite,
  satelliteFromOmm,
  UnsupportedElementSetError,
} from '../src/satellite.js';
import sample from './fixtures/omm-sample-2026-10-19.json' with { type: 'json' };

const records = parseOmmArray(sample).records;
const omm = (id: number) => records.find((r) => r.NORAD_CAT_ID === id) as Omm;
const sat = (id: number): Satellite => satelliteFromOmm(omm(id));
const NEW_YORK: Observer = { latitudeDeg: 40.7128, longitudeDeg: -74.006, heightKm: 0.01 };

describe('epoch precision', () => {
  // A double holds Unix ms in 2026 to about 0.1 us (under 1 mm of ISS motion), hence 3 places.
  it('keeps the microseconds a Date would drop', () => {
    const ms = ommEpochMs('2026-10-18T11:12:47.041632');
    expect(ms - Date.UTC(2026, 9, 18, 11, 12, 47, 41)).toBeCloseTo(0.632, 3);
    expect(ommEpochMs('2026-10-18T11:12:47')).toBe(Date.UTC(2026, 9, 18, 11, 12, 47));
  });

  it('propagates relative to the exact epoch', () => {
    const iss = sat(25544);
    const st = propagateAt(iss, new Date(Date.UTC(2026, 9, 18, 11, 12, 47, 41)));
    expect((st?.minutesFromEpoch ?? 0) * 60_000).toBeCloseTo(-0.632, 3);
  });

  it('reports element-set age, negative for future epochs (Chandra)', () => {
    const now = new Date('2026-10-19T00:31:07Z');
    // 2026-10-18 11:12:47 -> 2026-10-19 00:31:07 is 13 h 18 min 20 s
    expect(elementSetAgeDays(sat(25544), now)).toBeCloseTo(0.5544, 3);
    expect(elementSetAgeDays(sat(25867), now)).toBeLessThan(-1.6);
  });
});

describe('satelliteFromOmm', () => {
  it('propagates every sample object, including 6-digit catalogue numbers', () => {
    const at = new Date('2026-10-19T00:50:00Z');
    for (const r of records) {
      const st = propagateAt(satelliteFromOmm(r), at);
      expect(st, `${r.NORAD_CAT_ID}`).not.toBeNull();
    }
    expect(sat(100000).noradCatId).toBe(100000);
    expect(sat(101004).name).toBe('STARLINK-38435');
  });

  it('refuses element sets that are not SGP4 (e.g. SGP4-XP, type 4)', () => {
    expect(() => satelliteFromOmm({ ...omm(25544), EPHEMERIS_TYPE: 4 })).toThrow(
      UnsupportedElementSetError,
    );
  });

  it('returns null (not a made-up position) once SGP4 reports an error', () => {
    // Vallado case 33333 as OMM: decays within 25 minutes (error 4).
    const decaying = satelliteFromOmm({
      ...omm(25544),
      NORAD_CAT_ID: 33333,
      EPOCH: '2005-11-29T00:28:58.039296',
      MEAN_MOTION: 4.00004038,
      ECCENTRICITY: 0.995,
      INCLINATION: 96.4736,
      RA_OF_ASC_NODE: 157.9986,
      ARG_OF_PERICENTER: 244.0492,
      MEAN_ANOMALY: 110.6523,
      BSTAR: 0.24476e-3,
      MEAN_MOTION_DOT: 0.25992681,
      MEAN_MOTION_DDOT: 0.26967e-3,
    });
    expect(temeAtMinutes(decaying, 20, { decayCheck: false })).not.toBeNull();
    expect(temeAtMinutes(decaying, 30, { decayCheck: false })).toBeNull();
    expect(decaying.satrec.error).toBe(4);
  });
});

describe('summarizeOrbit', () => {
  it.each([
    [25544, 'LEO', false],
    [48274, 'LEO', false],
    [20580, 'LEO', false],
    [101004, 'LEO', false],
    [43641, 'LEO', true],
    [39084, 'LEO', true],
    [25933, 'MEO', false],
    [28358, 'GEO', false],
    [32708, 'GSO', false],
    [44453, 'HEO', false],
    [25867, 'HEO', false],
  ] as const)('NORAD %i is %s (sun-synchronous: %s)', (id, orbitClass, sso) => {
    const s = summarizeOrbit(sat(id));
    expect(s.orbitClass).toBe(orbitClass);
    expect(s.sunSynchronous).toBe(sso);
  });

  it('matches the SATCAT for the ISS (period 92.97 min, 415 x 424 km)', () => {
    const s = summarizeOrbit(sat(25544));
    expect(s.periodMin).toBeCloseTo(92.97, 1);
    expect(Math.abs(s.perigeeKm - 415)).toBeLessThan(5);
    expect(Math.abs(s.apogeeKm - 424)).toBeLessThan(5);
  });
});

describe('objectsAbove', () => {
  it('agrees with single-object propagation and respects the minimum elevation', () => {
    const sats = records.map(satelliteFromOmm);
    const at = new Date('2026-10-19T00:50:00Z');
    const all = objectsAbove(sats, NEW_YORK, at);
    for (const o of all) {
      const st = propagateAt(sats.find((s) => s.noradCatId === o.noradCatId) as Satellite, at);
      if (!st) throw new Error('no state');
      expect(o.elevationDeg).toBeCloseTo(lookAngles(NEW_YORK, st).elevationDeg, 9);
      expect(o.elevationDeg).toBeGreaterThanOrEqual(0);
    }
    expect(all.length).toBeGreaterThan(0);
    const high = objectsAbove(sats, NEW_YORK, at, { minElevationDeg: 30 });
    expect(high.every((o) => o.elevationDeg >= 30)).toBe(true);
    expect(high.length).toBeLessThanOrEqual(all.length);
  });
});

describe('helpers', () => {
  it('wraps longitudes and names compass points', () => {
    expect(wrapLongitude(190)).toBe(-170);
    expect(wrapLongitude(-180)).toBe(-180);
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(44)).toBe('NE');
    expect(compassPoint(359)).toBe('N');
    expect(compassPoint(-90)).toBe('W');
  });
});
