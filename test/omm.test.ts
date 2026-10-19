// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { MAX_NORAD_CAT_ID, ommEpochDate, ommEpochIso, parseOmmArray } from '../src/omm.js';
import issOmm from './fixtures/iss-25544-2026-10-19.json' with { type: 'json' };

describe('parseOmmArray', () => {
  it('accepts a real CelesTrak OMM record and keeps it unchanged', () => {
    const { records, rejected } = parseOmmArray(issOmm);
    expect(rejected).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(issOmm[0]);
  });

  it('accepts 6-digit catalogue numbers, which have no TLE form', () => {
    const sixDigit = { ...issOmm[0], NORAD_CAT_ID: 101074 };
    const { records, rejected } = parseOmmArray([sixDigit]);
    expect(rejected).toEqual([]);
    expect(records[0]?.NORAD_CAT_ID).toBe(101074);
  });

  it('keeps fields it does not know about', () => {
    const extended = { ...issOmm[0], CENTER_NAME: 'EARTH' };
    expect(parseOmmArray([extended]).records[0]).toHaveProperty('CENTER_NAME', 'EARTH');
  });

  it('rejects, and does not repair, records missing SGP4 fields', () => {
    const { MEAN_MOTION: _omit, ...broken } = issOmm[0] as Record<string, unknown>;
    const { records, rejected } = parseOmmArray([broken, issOmm[0]]);
    expect(records).toHaveLength(1);
    expect(rejected).toEqual([
      { index: 0, noradCatId: 25544, issues: [expect.stringContaining('MEAN_MOTION')] },
    ]);
  });

  it('rejects out-of-range values', () => {
    const bad = [
      { ...issOmm[0], ECCENTRICITY: 1 },
      { ...issOmm[0], INCLINATION: 181 },
      { ...issOmm[0], NORAD_CAT_ID: MAX_NORAD_CAT_ID + 1 },
      { ...issOmm[0], EPOCH: '18 Oct 2026' },
    ];
    expect(parseOmmArray(bad).rejected).toHaveLength(4);
  });

  it('throws when the payload is not an array (e.g. an upstream text message)', () => {
    expect(() => parseOmmArray('GP data has not updated')).toThrow(TypeError);
    expect(() => parseOmmArray({ error: 'x' })).toThrow(TypeError);
  });
});

describe('OMM epoch', () => {
  it('treats CelesTrak epochs (no zone suffix) as UTC and keeps microseconds', () => {
    expect(ommEpochIso('2026-10-18T11:12:47.041632')).toBe('2026-10-18T11:12:47.041632Z');
    expect(ommEpochDate('2026-10-18T11:12:47.041632').toISOString()).toBe(
      '2026-10-18T11:12:47.041Z',
    );
  });

  it('leaves an explicit Z alone and rejects other formats', () => {
    expect(ommEpochIso('2026-10-18T11:12:47Z')).toBe('2026-10-18T11:12:47Z');
    expect(() => ommEpochIso('2026-10-18 11:12:47')).toThrow(RangeError);
    expect(() => ommEpochIso('2026-10-18T11:12:47+02:00')).toThrow(RangeError);
  });
});
