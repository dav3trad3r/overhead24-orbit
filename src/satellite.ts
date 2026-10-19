// SPDX-License-Identifier: AGPL-3.0-only
import { json2satrec, type OMMJsonObject, type SatRec, SatRecError } from 'satellite.js';
import { type Omm, ommEpochMs } from './omm.js';

/** The element set can't be propagated with standard SGP4/SDP4. */
export class UnsupportedElementSetError extends Error {
  override name = 'UnsupportedElementSetError';
}

/** An object ready to propagate: its OMM record plus the initialised SGP4 state. */
export interface Satellite {
  readonly noradCatId: number;
  readonly name: string;
  readonly omm: Omm;
  /** Element-set epoch as Unix ms, keeping the sub-millisecond fraction. */
  readonly epochMs: number;
  /** satellite.js SGP4 record. Mutated by every propagation call (error code, scratch values). */
  readonly satrec: SatRec;
}

/**
 * Initialises SGP4 (WGS-72 constants, 'improved' operation mode, as in Vallado et al. 2006) from
 * an OMM record. Only EPHEMERIS_TYPE 0 (SGP4) is accepted: other mean-element theories, such as
 * SGP4-XP (type 4), would give wrong positions with this propagator.
 */
export function satelliteFromOmm(omm: Omm): Satellite {
  if (omm.EPHEMERIS_TYPE !== 0) {
    throw new UnsupportedElementSetError(
      `${omm.NORAD_CAT_ID}: EPHEMERIS_TYPE ${omm.EPHEMERIS_TYPE} is not SGP4 (0)`,
    );
  }
  const satrec = json2satrec(omm as unknown as OMMJsonObject);
  if (satrec.error !== SatRecError.None) {
    throw new UnsupportedElementSetError(
      `${omm.NORAD_CAT_ID}: SGP4 initialisation failed (${SatRecError[satrec.error]})`,
    );
  }
  return {
    noradCatId: omm.NORAD_CAT_ID,
    name: omm.OBJECT_NAME,
    omm,
    epochMs: ommEpochMs(omm.EPOCH),
    satrec,
  };
}

/** Age of the element set at `date`, in days. Negative when the epoch is in the future. */
export function elementSetAgeDays(sat: Satellite, date: Date): number {
  return (date.getTime() - sat.epochMs) / 86_400_000;
}
