// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CCSDS Orbit Mean-Elements Message (OMM) records, in the JSON keyword form CelesTrak publishes
 * (https://celestrak.org/NORAD/documentation/gp-data-formats.php).
 *
 * Validation is strict about the fields SGP4 needs and keeps unknown fields untouched, so a raw
 * record can be stored exactly as received.
 */
import { z } from 'zod';

/** CelesTrak EPOCH: ISO 8601 UTC with optional fraction and no zone suffix, e.g. 2026-10-18T11:12:47.041632 */
const EPOCH_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z?$/;

/** OMM supports catalogue numbers up to 9 digits; TLE stopped at 99999 on 2026-07-11. */
export const MAX_NORAD_CAT_ID = 999_999_999;

const angle360 = z.number().min(0).max(360);

export const ommSchema = z.looseObject({
  OBJECT_NAME: z.string().min(1),
  OBJECT_ID: z.string(),
  EPOCH: z.string().regex(EPOCH_PATTERN, 'EPOCH must be ISO 8601 UTC'),
  MEAN_MOTION: z.number().positive(),
  ECCENTRICITY: z.number().min(0).lt(1),
  INCLINATION: z.number().min(0).max(180),
  RA_OF_ASC_NODE: angle360,
  ARG_OF_PERICENTER: angle360,
  MEAN_ANOMALY: angle360,
  EPHEMERIS_TYPE: z.number().int(),
  CLASSIFICATION_TYPE: z.string().length(1),
  NORAD_CAT_ID: z.number().int().positive().max(MAX_NORAD_CAT_ID),
  ELEMENT_SET_NO: z.number().int(),
  REV_AT_EPOCH: z.number().int().min(0),
  BSTAR: z.number(),
  MEAN_MOTION_DOT: z.number(),
  MEAN_MOTION_DDOT: z.number(),
});

export type Omm = z.infer<typeof ommSchema>;

export interface RejectedOmm {
  index: number;
  noradCatId: number | null;
  issues: string[];
}

export interface OmmParseResult {
  records: Omm[];
  rejected: RejectedOmm[];
}

/**
 * Validates an upstream OMM array record by record. Invalid records are reported, never repaired.
 * Throws if the payload is not an array at all, because that means the upstream response is not
 * OMM data (CelesTrak returns plain-text messages for some failures).
 */
export function parseOmmArray(payload: unknown): OmmParseResult {
  if (!Array.isArray(payload)) {
    throw new TypeError('OMM payload is not a JSON array');
  }
  const records: Omm[] = [];
  const rejected: RejectedOmm[] = [];
  payload.forEach((item, index) => {
    const result = ommSchema.safeParse(item);
    if (result.success) {
      records.push(result.data);
      return;
    }
    const id = (item as { NORAD_CAT_ID?: unknown } | null)?.NORAD_CAT_ID;
    rejected.push({
      index,
      noradCatId: typeof id === 'number' ? id : null,
      issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
  });
  return { records, rejected };
}

/** Returns the OMM EPOCH as an explicit-UTC ISO string, keeping its full (sub-millisecond) precision. */
export function ommEpochIso(epoch: string): string {
  if (!EPOCH_PATTERN.test(epoch)) {
    throw new RangeError(`Invalid OMM EPOCH: ${epoch}`);
  }
  return epoch.endsWith('Z') ? epoch : `${epoch}Z`;
}

/** Returns the OMM EPOCH as a Date (millisecond precision, UTC). */
export function ommEpochDate(epoch: string): Date {
  return new Date(ommEpochIso(epoch));
}

/**
 * Returns the OMM EPOCH as Unix milliseconds INCLUDING the sub-millisecond fraction.
 * CelesTrak epochs carry microseconds; a JS Date would drop them, which for a low-orbit object
 * moving at ~7.7 km/s means up to ~7.7 m of along-track error.
 */
export function ommEpochMs(epoch: string): number {
  const iso = ommEpochIso(epoch);
  const whole = Date.parse(`${iso.slice(0, 19)}Z`);
  const fraction = iso.length > 20 ? Number(`0${iso.slice(19, -1)}`) : 0;
  return whole + fraction * 1000;
}
