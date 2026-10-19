// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  compareElementSets,
  MANEUVER_THRESHOLDS,
  maneuverSize,
  type Omm,
  satelliteFromOmm,
  screenApproaching,
} from '../src/index.js';
import pairs from './fixtures/maneuver-pairs-2026-10-19.json' with { type: 'json' };
import proximity from './fixtures/proximity-omm-2026-10-19.json' with { type: 'json' };

// Real consecutive element sets from CelesTrak's active group, downloaded 19 Oct 2026.
function change(labelStart: string) {
  const p = pairs.find((x) => x.label.startsWith(labelStart));
  if (!p) throw new Error(`no fixture ${labelStart}`);
  const c = compareElementSets(
    satelliteFromOmm(p.prev as unknown as Omm),
    satelliteFromOmm(p.next as unknown as Omm),
  );
  if (!c) throw new Error(`no comparison for ${labelStart}`);
  return c;
}

describe('compareElementSets / maneuverSize', () => {
  it('flags a large orbit change: QIANFAN-196 lowered by about 16 km', () => {
    const c = change('QIANFAN-196');
    expect(c.regime).toBe('LEO');
    expect(c.deltaAKm).toBeGreaterThan(-17);
    expect(c.deltaAKm).toBeLessThan(-14);
    expect(maneuverSize(c)).toBe('large');
  });

  it('flags a geostationary manoeuvre as small (station-keeping size)', () => {
    const c = change("ES'HAIL 1");
    expect(c.regime).toBe('GEO');
    expect(Math.abs(c.deltaAKm)).toBeGreaterThan(MANEUVER_THRESHOLDS.GEO.aKm as number);
    expect(maneuverSize(c)).toBe('small');
  });

  it('leaves routine updates alone (ISS, ZHONGXING-3A)', () => {
    const iss = change('ISS');
    expect(iss.regime).toBe('LEO');
    expect(maneuverSize(iss)).toBeNull();
    const zx = change('ZHONGXING-3A');
    expect(zx.regime).toBe('GEO');
    expect(maneuverSize(zx)).toBeNull();
  });

  it('ignores semi-major-axis swings on highly elliptical deep-space refits (MMS 1)', () => {
    const c = change('MMS 1');
    expect(c.regime).toBe('HEO');
    expect(Math.abs(c.deltaAKm)).toBeGreaterThan(100);
    expect(maneuverSize(c)).toBeNull();
  });

  it('only compares a newer set with an older one', () => {
    const p = pairs[0] as (typeof pairs)[number];
    const prev = satelliteFromOmm(p.prev as unknown as Omm);
    const next = satelliteFromOmm(p.next as unknown as Omm);
    expect(compareElementSets(next, prev)).toBeNull();
    expect(compareElementSets(prev, prev)).toBeNull();
  });
});

describe('screenApproaching', () => {
  // LUCH-5X's real geostationary elements as the base for constructed neighbours.
  const base = proximity.find((r) => r.NORAD_CAT_ID === 55841) as unknown as Omm;
  const watched = { ...base, NORAD_CAT_ID: 900001, OBJECT_ID: '2099-001A', OBJECT_NAME: 'WATCHED' };
  const atMs = satelliteFromOmm(watched).epochMs;
  // 0.0005 rev/day faster closes about 132 km a day along the GEO ring; 0.364° behind is ~268 km.
  const neighbour = (id: number, over: Partial<Omm>): Omm => ({
    ...base,
    NORAD_CAT_ID: id,
    OBJECT_ID: `2099-0${id - 900000}0A`.slice(0, 9),
    OBJECT_NAME: `N${id}`,
    ...over,
  });
  const closer = neighbour(900002, {
    MEAN_ANOMALY: base.MEAN_ANOMALY - 0.3642,
    MEAN_MOTION: base.MEAN_MOTION + 0.0005,
  });
  const receding = neighbour(900003, {
    MEAN_ANOMALY: base.MEAN_ANOMALY + 0.3642,
    MEAN_MOTION: base.MEAN_MOTION + 0.0005,
  });
  const otherPlane = neighbour(900004, {
    MEAN_ANOMALY: base.MEAN_ANOMALY - 0.3642,
    MEAN_MOTION: base.MEAN_MOTION + 0.0005,
    INCLINATION: base.INCLINATION + 5,
  });
  const sats = [watched, closer, receding, otherPlane].map(satelliteFromOmm);

  it('finds a co-orbital neighbour closing in, with distances a day apart', () => {
    const found = screenApproaching(sats, atMs, { watch: (s) => s.noradCatId === 900001 });
    expect(found.map((p) => [p.a, p.b])).toEqual([[900001, 900002]]);
    const p = found[0] as (typeof found)[number];
    expect(p.kmBefore).toBeGreaterThan(380);
    expect(p.kmNow).toBeGreaterThan(250);
    expect(p.kmNow).toBeLessThan(290);
    expect(p.kmAfter).toBeLessThan(170);
  });

  it('ignores pairs moving apart, in another orbit plane, or with nobody watched', () => {
    expect(screenApproaching(sats, atMs, { watch: () => false })).toEqual([]);
    const ids = screenApproaching(sats, atMs, { watch: (s) => s.noradCatId === 900001 }).flatMap(
      (p) => [p.a, p.b],
    );
    expect(ids).not.toContain(900003);
    expect(ids).not.toContain(900004);
  });
});
