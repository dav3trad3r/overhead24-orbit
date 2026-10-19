// SPDX-License-Identifier: AGPL-3.0-only
/**
 * packages/orbit against independent references for real CelesTrak objects (ISS, a 6-digit
 * Starlink, a geostationary satellite, Chandra, a Meridian, a GPS satellite, Tiangong):
 *
 * - python-sgp4 2.27 (Vallado's C++ SGP4, initialised from the same OMM) for raw TEME states;
 * - Skyfield 1.55 + JPL DE421 for geodetic positions, look angles, rise/set events, visibility,
 *   Earth's shadow and the Sun's altitude.
 *
 * The fixture is produced by scripts/gen_reference.py. Tolerances are set from measured
 * differences with margin, and the known model difference is spelled out: Skyfield applies
 * UT1-UTC (about +0.09 s on 2026-10-19 in its IERS table) and polar motion, while the app uses
 * UT1 = UTC, which moves positions ~0.0004 deg (~43 m) east-west.
 */
import { describe, expect, it } from 'vitest';
import { lookAngles, type Observer } from '../src/observer.js';
import { type Omm, parseOmmArray } from '../src/omm.js';
import { findPasses } from '../src/passes.js';
import { propagateAt, temeAtMinutes } from '../src/propagate.js';
import { type Satellite, satelliteFromOmm } from '../src/satellite.js';
import { isSunlit, sunAltitudeDeg } from '../src/sun.js';
import sample from './fixtures/omm-sample-2026-10-19.json' with { type: 'json' };
import ref from './fixtures/reference-skyfield.json' with { type: 'json' };

const TOL = {
  temeKm: 1e-5, // 1 cm (measured 0.6 mm)
  temeKmS: 1e-8, // 0.01 mm/s
  latitudeDeg: 1e-6,
  longitudeDeg: 1e-3, // UT1-UTC term, measured 3.8e-4
  heightKm: 1e-3,
  elevationDeg: 5e-3, // measured 1.5e-3
  azimuthDeg: 1e-2, // measured 3.5e-3 (checked below 85 deg elevation)
  rangeKm: 0.1, // measured 35 m
  sunAltitudeDeg: 5e-3, // measured 2.7e-4
  eventSeconds: 1, // rise/set/culmination, measured <= 0.22 s
  maxElevationDeg: 0.02, // measured 0.006
  visibleEdgeSeconds: 2, // reference sampled at 1 s, measured <= 1.0 s
  shadowSeconds: 3, // measured 1.2 s (we test the Sun's centre with a penumbra model)
} as const;

const records = parseOmmArray(sample).records;
const sat = (id: number): Satellite =>
  satelliteFromOmm(records.find((r) => r.NORAD_CAT_ID === id) as Omm);
const observers = ref.observers as Record<string, Observer>;
const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const dist = (a: { x: number; y: number; z: number }, b: number[]) =>
  Math.hypot(a.x - (b[0] as number), a.y - (b[1] as number), a.z - (b[2] as number));

describe('TEME state vs python-sgp4', () => {
  for (const [id, rows] of Object.entries(ref.teme)) {
    it(`NORAD ${id} at ${rows.length} offsets from epoch`, () => {
      const s = sat(Number(id));
      for (const row of rows) {
        const st = temeAtMinutes(s, row.minutesFromEpoch, { decayCheck: false });
        if (!st) throw new Error(`no state at ${row.minutesFromEpoch} min`);
        expect(dist(st.positionKm, row.r)).toBeLessThan(TOL.temeKm);
        expect(dist(st.velocityKmS, row.v)).toBeLessThan(TOL.temeKmS);
      }
    });
  }
});

describe('positions and look angles vs Skyfield (every 10 min for 24 h)', () => {
  for (const [id, p] of Object.entries(ref.positions)) {
    it(`NORAD ${id}`, () => {
      const s = sat(Number(id));
      let azChecked = 0;
      p.times.forEach((iso, i) => {
        const st = propagateAt(s, new Date(iso));
        if (!st) throw new Error(`no state at ${iso}`);
        expect(Math.abs(st.latitudeDeg - (p.latitudeDeg[i] as number))).toBeLessThan(
          TOL.latitudeDeg,
        );
        expect(angleDiff(st.longitudeDeg, p.longitudeDeg[i] as number)).toBeLessThan(
          TOL.longitudeDeg,
        );
        expect(Math.abs(st.heightKm - (p.heightKm[i] as number))).toBeLessThan(TOL.heightKm);
        for (const [name, look] of Object.entries(p.look)) {
          const la = lookAngles(observers[name] as Observer, st);
          const el = look.elevationDeg[i] as number;
          expect(Math.abs(la.elevationDeg - el)).toBeLessThan(TOL.elevationDeg);
          expect(Math.abs(la.rangeKm - (look.rangeKm[i] as number))).toBeLessThan(TOL.rangeKm);
          if (el > -5 && el < 85) {
            expect(angleDiff(la.azimuthDeg, look.azimuthDeg[i] as number)).toBeLessThan(
              TOL.azimuthDeg,
            );
            azChecked++;
          }
        }
      });
      expect(azChecked).toBeGreaterThan(0);
    });
  }
});

describe('Sun altitude vs Skyfield/DE421', () => {
  it('hourly for 24 h at both observers', () => {
    const sa = ref.sunAltitudes as unknown as { times: string[] } & Record<string, number[]>;
    sa.times.forEach((iso, i) => {
      for (const name of Object.keys(observers)) {
        const ours = sunAltitudeDeg(observers[name] as Observer, new Date(iso));
        expect(Math.abs(ours - (sa[name]?.[i] as number))).toBeLessThan(TOL.sunAltitudeDeg);
      }
    });
  });
});

describe('passes vs Skyfield find_events (3 days from 2026-10-19 00:00 UTC)', () => {
  const start = new Date('2026-10-19T00:00:00Z');
  const end = new Date('2026-10-22T00:00:00Z');

  for (const [id, byObserver] of Object.entries(ref.passes)) {
    for (const [name, expected] of Object.entries(byObserver)) {
      it(`NORAD ${id} over ${name}: ${expected.length} passes`, () => {
        const ours = findPasses(sat(Number(id)), observers[name] as Observer, {
          start,
          end,
        }).filter((p) => !p.risesBeforeWindow && !p.setsAfterWindow);
        expect(ours).toHaveLength(expected.length);
        expected.forEach((e, i) => {
          const p = ours[i];
          if (!p) throw new Error(`missing pass ${i}`);
          const secs = (d: Date, iso: string) => Math.abs(d.getTime() - Date.parse(iso)) / 1000;
          expect(secs(p.rise.date, e.rise)).toBeLessThan(TOL.eventSeconds);
          expect(secs(p.culmination.date, e.culmination)).toBeLessThan(TOL.eventSeconds);
          expect(secs(p.set.date, e.set)).toBeLessThan(TOL.eventSeconds);
          expect(Math.abs(p.culmination.elevationDeg - e.maxElevationDeg)).toBeLessThan(
            TOL.maxElevationDeg,
          );
          expect(p.visible === null).toBe(e.visible === null);
          if (p.visible && e.visible) {
            expect(secs(p.visible.start.date, e.visible.start)).toBeLessThan(
              TOL.visibleEdgeSeconds,
            );
            expect(secs(p.visible.end.date, e.visible.end)).toBeLessThan(TOL.visibleEdgeSeconds);
            // When the visible part starts or ends at its highest point (leaving or entering
            // shadow), the 1 s reference grid can miss the true edge by up to ~0.4 deg.
            expect(
              Math.abs(p.visible.highest.elevationDeg - e.visible.maxElevationDeg),
            ).toBeLessThan(0.5);
          }
        });
      });
    }
  }

  it('explains why the visible part of each ISS pass over New York starts and ends', () => {
    const visible = findPasses(sat(25544), observers['new-york'] as Observer, { start, end })
      .map((p) => p.visible)
      .filter((v) => v !== null);
    expect(
      visible.map((v) => [v.start.date.toISOString().slice(0, 16), v.startReason, v.endReason]),
    ).toEqual([
      ['2026-10-19T09:09', 'leaves-earth-shadow', 'sinks-below-minimum'],
      ['2026-10-19T10:43', 'rises-above-minimum', 'sky-gets-light'],
      ['2026-10-20T09:57', 'leaves-earth-shadow', 'sinks-below-minimum'],
      ['2026-10-21T09:12', 'leaves-earth-shadow', 'sinks-below-minimum'],
    ]);
  });
});

describe("Earth's shadow vs Skyfield is_sunlit", () => {
  it('ISS enters and leaves shadow at the same times over 24 h', () => {
    const s = sat(25544);
    const lit = (ms: number) => {
      const st = propagateAt(s, new Date(ms));
      if (!st) throw new Error('no state');
      return isSunlit(st);
    };
    expect(ref.issShadowTransitions.length).toBeGreaterThan(20);
    for (const tr of ref.issShadowTransitions) {
      const t = Date.parse(tr.time);
      expect(lit(t - TOL.shadowSeconds * 1000)).toBe(!tr.sunlit);
      expect(lit(t + TOL.shadowSeconds * 1000)).toBe(tr.sunlit);
    }
  });
});
