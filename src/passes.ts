// SPDX-License-Identifier: AGPL-3.0-only
import {
  type LookAngles,
  lookAnglesFromEcef,
  type Observer,
  observerGeodetic,
} from './observer.js';
import { propagateAt } from './propagate.js';
import type { Satellite } from './satellite.js';
import { isSunlit, sunAltitudeDeg, TWILIGHT_DEG } from './sun.js';

export interface PassPoint extends LookAngles {
  date: Date;
}

/** Why the visible part of a pass begins. */
export type VisibleStartReason =
  | 'window-start'
  | 'rises-above-minimum'
  | 'leaves-earth-shadow'
  | 'sky-gets-dark';

/** Why the visible part of a pass ends. */
export type VisibleEndReason =
  | 'window-end'
  | 'sinks-below-minimum'
  | 'enters-earth-shadow'
  | 'sky-gets-light';

/** The stretch of a pass that is high enough, sunlit, and seen against a dark enough sky. */
export interface VisiblePart {
  start: PassPoint;
  highest: PassPoint;
  end: PassPoint;
  startReason: VisibleStartReason;
  endReason: VisibleEndReason;
}

export interface Pass {
  noradCatId: number;
  /** Crosses the horizon going up (or the window start if already up). */
  rise: PassPoint;
  /** Highest elevation of the pass. */
  culmination: PassPoint;
  /** Crosses the horizon going down (or the window end if still up). */
  set: PassPoint;
  risesBeforeWindow: boolean;
  setsAfterWindow: boolean;
  /** The first visible stretch of the pass, or null if none of it is visible. */
  visible: VisiblePart | null;
}

export interface PassSearchOptions {
  start: Date;
  end: Date;
  /** Horizon for rise and set, degrees. Default 0. */
  horizonDeg?: number;
  /** Lowest elevation counted as visible, degrees. Default 10. */
  minVisibleElevationDeg?: number;
  /** The Sun must be at or below this altitude for a dark enough sky. Default -6 (civil). */
  maxSunAltitudeDeg?: number;
  /** Coarse search step, seconds. Passes shorter than this can be missed. Default 20. */
  stepSeconds?: number;
  /** Sampling step inside a pass when looking for the visible part, seconds. Default 5. */
  visibleStepSeconds?: number;
}

/** Event times are refined until bracketed within this many milliseconds. */
const TOLERANCE_MS = 100;
/** A local elevation maximum this close below the horizon is checked for a grazing pass. */
const GRAZE_MARGIN_DEG = 5;
const INV_PHI = (Math.sqrt(5) - 1) / 2;

/**
 * Finds every pass of `sat` over `observer` between `start` and `end` (SGP4 positions, geometric
 * elevations without refraction). Searches in coarse steps, then refines each horizon crossing by
 * bisection and each culmination by golden-section search to within 0.1 s.
 */
export function findPasses(sat: Satellite, observer: Observer, opts: PassSearchOptions): Pass[] {
  const start = opts.start.getTime();
  const end = opts.end.getTime();
  if (!(end > start)) throw new RangeError('findPasses: end must be after start');
  const horizon = opts.horizonDeg ?? 0;
  const step = (opts.stepSeconds ?? 20) * 1000;
  const geo = observerGeodetic(observer);

  const look = (ms: number): PassPoint | null => {
    const date = new Date(ms);
    const s = propagateAt(sat, date);
    return s ? { date, ...lookAnglesFromEcef(geo, s.ecefKm) } : null;
  };
  const elevation = (ms: number) => look(ms)?.elevationDeg ?? Number.NEGATIVE_INFINITY;
  const isUp = (ms: number) => elevation(ms) >= horizon;

  const passes: Pass[] = [];
  const build = (
    riseMs: number,
    setMs: number,
    bestMs: number,
    before: boolean,
    after: boolean,
  ) => {
    const culmMs = goldenMax(
      elevation,
      Math.max(riseMs, bestMs - step),
      Math.min(setMs, bestMs + step),
    );
    const rise = look(riseMs);
    const culmination = look(culmMs);
    const set = look(setMs);
    if (!rise || !culmination || !set) return;
    passes.push({
      noradCatId: sat.noradCatId,
      rise,
      culmination,
      set,
      risesBeforeWindow: before,
      setsAfterWindow: after,
      // A pass that never reaches the visibility minimum can't have a visible part.
      visible:
        culmination.elevationDeg >= (opts.minVisibleElevationDeg ?? 10)
          ? visiblePart(sat, observer, opts, riseMs, setMs, culmination, before, after)
          : null,
    });
  };

  let prevMs = start;
  let prev = look(start);
  if (!prev) return passes;
  let prevPrevEl = Number.NaN;
  let riseMs: number | null = prev.elevationDeg >= horizon ? start : null;
  let risesBefore = riseMs !== null;
  let bestMs = start;
  let bestEl = prev.elevationDeg;

  while (prevMs < end) {
    const t = Math.min(prevMs + step, end);
    const cur = look(t);
    if (!cur) break; // decayed or SGP4 error: no further positions exist
    const up = cur.elevationDeg >= horizon;
    if (riseMs === null) {
      if (up) {
        riseMs = bisect(isUp, prevMs, t);
        bestMs = t;
        bestEl = cur.elevationDeg;
      } else if (
        prevPrevEl < prev.elevationDeg &&
        cur.elevationDeg < prev.elevationDeg &&
        prev.elevationDeg > horizon - GRAZE_MARGIN_DEG
      ) {
        // A peak between samples while below the horizon: check for a short grazing pass.
        const a = Math.max(start, prevMs - step);
        const peakMs = goldenMax(elevation, a, t);
        if (elevation(peakMs) >= horizon) {
          build(bisect(isUp, a, peakMs), bisect(isUp, peakMs, t), peakMs, false, false);
        }
      }
    } else if (up) {
      if (cur.elevationDeg > bestEl) {
        bestEl = cur.elevationDeg;
        bestMs = t;
      }
    } else {
      build(riseMs, bisect(isUp, prevMs, t), bestMs, risesBefore, false);
      riseMs = null;
      risesBefore = false;
    }
    prevPrevEl = prev.elevationDeg;
    prev = cur;
    prevMs = t;
  }
  if (riseMs !== null) build(riseMs, prevMs, bestMs, risesBefore, prevMs >= end);
  return passes;
}

interface Conditions {
  high: boolean;
  lit: boolean;
  dark: boolean;
}

function visiblePart(
  sat: Satellite,
  observer: Observer,
  opts: PassSearchOptions,
  riseMs: number,
  setMs: number,
  culmination: PassPoint,
  risesBefore: boolean,
  setsAfter: boolean,
): VisiblePart | null {
  const minVis = opts.minVisibleElevationDeg ?? 10;
  const maxSun = opts.maxSunAltitudeDeg ?? TWILIGHT_DEG.civil;
  const step = (opts.visibleStepSeconds ?? 5) * 1000;
  const geo = observerGeodetic(observer);

  const conditions = (ms: number): Conditions | null => {
    const date = new Date(ms);
    const s = propagateAt(sat, date);
    if (!s) return null;
    return {
      high: lookAnglesFromEcef(geo, s.ecefKm).elevationDeg >= minVis,
      lit: isSunlit(s),
      dark: sunAltitudeDeg(observer, date) <= maxSun,
    };
  };
  const visibleAt = (ms: number) => {
    const c = conditions(ms);
    return !!c && c.high && c.lit && c.dark;
  };

  const times: number[] = [];
  for (let t = riseMs; t < setMs; t += step) times.push(t);
  times.push(setMs);
  const flags = times.map(visibleAt);
  const first = flags.indexOf(true);
  if (first < 0) return null;
  let last = first;
  while (last + 1 < flags.length && flags[last + 1]) last++;

  const startMs =
    first === 0 ? riseMs : bisect(visibleAt, times[first - 1] as number, times[first] as number);
  const endMs =
    last === times.length - 1
      ? setMs
      : bisect(visibleAt, times[last] as number, times[last + 1] as number);

  const geoLook = (ms: number): PassPoint | null => {
    const date = new Date(ms);
    const s = propagateAt(sat, date);
    return s ? { date, ...lookAnglesFromEcef(geo, s.ecefKm) } : null;
  };
  const start = geoLook(startMs);
  const end = geoLook(endMs);
  if (!start || !end) return null;
  const culmMs = culmination.date.getTime();
  const highest =
    culmMs >= startMs && culmMs <= endMs
      ? culmination
      : start.elevationDeg >= end.elevationDeg
        ? start
        : end;

  return {
    start,
    highest,
    end,
    startReason:
      first === 0 && risesBefore
        ? 'window-start'
        : startReason(conditions, startMs - TOLERANCE_MS, startMs + TOLERANCE_MS),
    endReason:
      last === times.length - 1 && setsAfter
        ? 'window-end'
        : endReason(conditions, endMs - TOLERANCE_MS, endMs + TOLERANCE_MS),
  };
}

type ConditionsAt = (ms: number) => Conditions | null;

function startReason(c: ConditionsAt, beforeMs: number, afterMs: number): VisibleStartReason {
  const b = c(beforeMs);
  const a = c(afterMs);
  if (b && a) {
    if (!b.lit && a.lit) return 'leaves-earth-shadow';
    if (!b.dark && a.dark) return 'sky-gets-dark';
  }
  return 'rises-above-minimum';
}

function endReason(c: ConditionsAt, beforeMs: number, afterMs: number): VisibleEndReason {
  const b = c(beforeMs);
  const a = c(afterMs);
  if (b && a) {
    if (b.lit && !a.lit) return 'enters-earth-shadow';
    if (b.dark && !a.dark) return 'sky-gets-light';
  }
  return 'sinks-below-minimum';
}

/** Time where `pred` changes value between `a` and `b` (pred(a) !== pred(b)), within 0.1 s. */
function bisect(pred: (ms: number) => boolean, a: number, b: number): number {
  const atA = pred(a);
  let lo = a;
  let hi = b;
  while (hi - lo > TOLERANCE_MS) {
    const mid = (lo + hi) / 2;
    if (pred(mid) === atA) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

/** Time of the maximum of a unimodal `f` on [a, b], within 0.1 s (golden-section search). */
function goldenMax(f: (ms: number) => number, a: number, b: number): number {
  let lo = a;
  let hi = b;
  let x1 = hi - INV_PHI * (hi - lo);
  let x2 = lo + INV_PHI * (hi - lo);
  let f1 = f(x1);
  let f2 = f(x2);
  while (hi - lo > TOLERANCE_MS) {
    if (f1 < f2) {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + INV_PHI * (hi - lo);
      f2 = f(x2);
    } else {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - INV_PHI * (hi - lo);
      f1 = f(x1);
    }
  }
  return Math.round((lo + hi) / 2);
}
