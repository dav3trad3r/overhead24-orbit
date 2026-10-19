// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SGP4/SDP4 core against the official verification set: Vallado, Crawford, Hujsak & Kelso,
 * "Revisiting Spacetrack Report #3", AIAA 2006-6753 (test cases SGP4-VER.TLE and the C++
 * reference ephemerides, one .e file per case, TEME km and km/s).
 *
 * TLE input is used ONLY here, because that is the form the verification set is published in;
 * the app itself reads OMM. A second test shows the OMM path produces the same states.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { sgp4, twoline2satrec } from 'satellite.js';
import { describe, expect, it } from 'vitest';
import { parseOmmArray } from '../src/omm.js';
import { temeAtMinutes } from '../src/propagate.js';
import { satelliteFromOmm } from '../src/satellite.js';
import reference from './fixtures/reference-skyfield.json' with { type: 'json' };

const DIR = new URL('./fixtures/vallado/', import.meta.url);
/** Position within 1 mm and velocity within 0.01 mm/s of the C++ reference. */
const POS_TOL_KM = 1e-6;
const VEL_TOL_KMS = 1e-8;
/** Case 23599 ("Lyddane bug at > 280.5 min"): see the test below. */
const LYDDANE_EDGE_MIN = 280.5;

interface Case {
  id: string;
  line1: string;
  line2: string;
}

function cases(): Case[] {
  const lines = readFileSync(new URL('SGP4-VER.TLE', DIR), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#'));
  const out: Case[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const line1 = lines[i] as string;
    const line2 = (lines[i + 1] as string).slice(0, 69);
    out.push({ id: line1.slice(2, 7).trim().padStart(5, '0'), line1, line2 });
  }
  return out;
}

function ephemeris(id: string): { seconds: number; r: number[]; v: number[] }[] {
  const text = readFileSync(new URL(`${id}.e`, DIR), 'utf8').split(/\r?\n/);
  const start = text.findIndex((l) => l.startsWith('EphemerisTimePosVel'));
  return text
    .slice(start + 1)
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((c) => c.length >= 7 && c.every(Number.isFinite))
    .map((c) => ({ seconds: c[0] as number, r: c.slice(1, 4), v: c.slice(4, 7) }));
}

const dist = (a: { x: number; y: number; z: number }, b: number[]) =>
  Math.hypot(a.x - (b[0] as number), a.y - (b[1] as number), a.z - (b[2] as number));

const all = cases();
const withEphemeris = new Set(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.e'))
    .map((f) => f.slice(0, 5)),
);

describe('SGP4 verification set (AIAA 2006-6753)', () => {
  it('has a C++ reference ephemeris for every test case', () => {
    // 33 entries for 32 objects: 20413 is listed twice with identical elements and two time
    // spans; its one .e file holds the second run, which either entry can be checked against.
    expect(all).toHaveLength(33);
    expect(new Set(all.map((c) => c.id)).size).toBe(32);
    expect(all.filter((c) => !withEphemeris.has(c.id))).toEqual([]);
  });

  const regular = all.filter((c) => !['23599', '33334'].includes(c.id));
  it.each(regular.map((c) => [c.id, c] as const))(
    'case %s matches to 1 mm and 0.01 mm/s',
    (_id, c) => {
      const rec = twoline2satrec(c.line1, c.line2);
      const rows = ephemeris(c.id);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const pv = sgp4(rec, row.seconds / 60);
        expect(pv, `t=${row.seconds}s error ${rec.error}`).not.toBeNull();
        if (!pv) continue;
        expect(dist(pv.position, row.r)).toBeLessThan(POS_TOL_KM);
        expect(dist(pv.velocity, row.v)).toBeLessThan(VEL_TOL_KMS);
      }
    },
  );

  it('case 33333 stops with error 4 (perturbed eccentricity) right after the reference ends', () => {
    const c = all.find((x) => x.id === '33333') as Case;
    const rec = twoline2satrec(c.line1, c.line2);
    const last = ephemeris('33333').at(-1)?.seconds ?? 0;
    expect(sgp4(rec, last / 60 + 5)).toBeNull();
    expect(rec.error).toBe(4);
  });

  it('case 33334 is rejected at epoch (its .e row is a leftover state from the previous case)', () => {
    const c = all.find((x) => x.id === '33334') as Case;
    const rec = twoline2satrec(c.line1, c.line2);
    expect(sgp4(rec, 0)).toBeNull();
    expect(rec.error).not.toBe(0);
  });

  it('case 23599 matches the C++ reference to 280.5 min, and python-sgp4 everywhere', () => {
    // After 280.5 min this case exercises the Lyddane modification edge named in the test file.
    // The C++ build that wrote 23599.e (2021) diverges there by up to ~1 km from BOTH satellite.js
    // and python-sgp4 2.27 (Vallado's C++ wrapped independently), which agree with each other to
    // 1 mm. We follow the two agreeing implementations.
    const c = all.find((x) => x.id === '23599') as Case;
    const rec = twoline2satrec(c.line1, c.line2);
    const early = ephemeris('23599').filter((r) => r.seconds / 60 <= LYDDANE_EDGE_MIN);
    expect(early.length).toBeGreaterThan(10);
    for (const row of early) {
      const pv = sgp4(rec, row.seconds / 60);
      if (!pv) throw new Error(`t=${row.seconds}s error ${rec.error}`);
      expect(dist(pv.position, row.r)).toBeLessThan(POS_TOL_KM);
    }
    const python = reference.vallado23599PythonSgp4;
    expect(python).toHaveLength(37);
    for (const row of python) {
      const pv = sgp4(rec, row.seconds / 60);
      if (!pv) throw new Error(`t=${row.seconds}s error ${rec.error}`);
      expect(dist(pv.position, row.r)).toBeLessThan(POS_TOL_KM);
      expect(dist(pv.velocity, row.v)).toBeLessThan(VEL_TOL_KMS);
    }
  });
});

describe('the OMM path gives the same states as the TLE path', () => {
  /** OMM fields built from a TLE, with the TLE epoch written out to the nanosecond. */
  function ommFromTle(c: Case) {
    const l1 = c.line1;
    const l2 = c.line2;
    const yy = Number(l1.slice(18, 20));
    const year = yy < 57 ? 2000 + yy : 1900 + yy;
    const dayOfYear = Number(l1.slice(20, 32));
    const totalNs =
      BigInt(Date.UTC(year, 0, 1)) * 1_000_000n + BigInt(Math.round((dayOfYear - 1) * 86_400e9));
    const d = new Date(Number(totalNs / 1_000_000n));
    const subMs = (totalNs % 1_000_000n).toString().padStart(6, '0');
    const iso = `${d.toISOString().slice(0, 23)}${subMs}`;
    const expo = (s: string) =>
      Number(`${s[0] === '-' ? '-' : ''}0.${s.slice(1, 6).trim()}e${s.slice(6, 8)}`);
    return {
      OBJECT_NAME: `VALLADO ${c.id}`,
      OBJECT_ID: '',
      EPOCH: iso,
      MEAN_MOTION: Number(l2.slice(52, 63)),
      ECCENTRICITY: Number(`0.${l2.slice(26, 33)}`),
      INCLINATION: Number(l2.slice(8, 16)),
      RA_OF_ASC_NODE: Number(l2.slice(17, 25)),
      ARG_OF_PERICENTER: Number(l2.slice(34, 42)),
      MEAN_ANOMALY: Number(l2.slice(43, 51)),
      EPHEMERIS_TYPE: 0,
      CLASSIFICATION_TYPE: 'U',
      NORAD_CAT_ID: Number(c.id),
      ELEMENT_SET_NO: 999,
      REV_AT_EPOCH: Number(l2.slice(63, 68)),
      BSTAR: expo(l1.slice(53, 61)),
      MEAN_MOTION_DOT: Number(l1.slice(33, 43)),
      MEAN_MOTION_DDOT: expo(l1.slice(44, 52)),
    };
  }

  // A near-Earth case with drag, a 12 h resonant Molniya, and a geosynchronous case. Within 1 cm:
  // satellite.js initialises deep-space terms at the epoch rounded to the millisecond (1.2 mm
  // for the Molniya); propagation time itself uses the exact epoch.
  it.each(['06251', '08195', '28626'])('case %s', (id) => {
    const c = all.find((x) => x.id === id) as Case;
    const { records, rejected } = parseOmmArray([ommFromTle(c)]);
    expect(rejected).toEqual([]);
    const sat = satelliteFromOmm(records[0] as (typeof records)[number]);
    const rec = twoline2satrec(c.line1, c.line2);
    for (const minutes of [0, 30, 360, 1440, 2880]) {
      const tle = sgp4(rec, minutes);
      const omm = temeAtMinutes(sat, minutes, { decayCheck: false });
      if (!tle || !omm) throw new Error(`no state at ${minutes} min`);
      expect(dist(omm.positionKm, [tle.position.x, tle.position.y, tle.position.z])).toBeLessThan(
        1e-5,
      );
    }
  });
});
