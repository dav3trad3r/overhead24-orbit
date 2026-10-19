// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseOmmArray } from '../src/omm.js';
import { launchOf, PassScreener, screenPassing, screenStaying } from '../src/proximity.js';
import { satelliteFromOmm } from '../src/satellite.js';
import omms from './fixtures/proximity-omm-2026-10-19.json' with { type: 'json' };

// Real CelesTrak elements (active group, downloaded 2026-10-19 00:31 UTC) for: Intelsat 10-02
// and MEV-2 (docked), TerraSAR-X and TanDEM-X (formation), Intelsat 39 and Luch-5X (20 km apart
// on the geostationary ring), Capella-11 and TOM-2 (a crossing), plus the ISS and a Starlink.
const sats = parseOmmArray(omms).records.map(satelliteFromOmm);
const T = Date.parse('2026-10-19T03:32:00Z');

describe('screenStaying', () => {
  const pairs = screenStaying(sats, T);
  const find = (a: number, b: number) => pairs.find((p) => p.a === a && p.b === b);

  it('finds the docked, formation and shadowing pairs and nothing else', () => {
    expect(pairs.map((p) => [p.a, p.b])).toEqual([
      [28358, 46113],
      [31698, 36605],
      [44476, 55841],
    ]);
  });

  it('measures how close they stay over 24 h either side', () => {
    expect(find(28358, 46113)?.maxKm).toBeLessThan(0.01); // MEV-2 docked to Intelsat 10-02
    const formation = find(31698, 36605);
    expect(formation?.minKm).toBeGreaterThan(0.05);
    expect(formation?.maxKm).toBeLessThan(1);
    const luch = find(44476, 55841);
    expect(luch?.nowKm).toBeCloseTo(19.7, 0);
    expect(luch?.minKm).toBeGreaterThan(10);
    expect(luch?.maxKm).toBeLessThan(40);
  });
});

describe('PassScreener', () => {
  it('finds the Capella-11 / TOM-2 crossing, skipping pairs that stay together', () => {
    const staying = new Set(screenStaying(sats, T).map((p) => `${p.a}:${p.b}`));
    const passes = screenPassing(sats, T, {
      skip: (a, b) => staying.has(a < b ? `${a}:${b}` : `${b}:${a}`),
    });
    expect(passes).toHaveLength(1);
    const p = passes[0];
    expect([p?.a, p?.b]).toEqual([57693, 69914]);
    expect(Math.abs((p?.tcaMs ?? 0) - Date.parse('2026-10-19T05:45:27.4Z'))).toBeLessThan(1000);
    expect(p?.missKm).toBeLessThan(1);
    expect(p?.relSpeedKmS).toBeCloseTo(14.6, 1);
  });

  it('can be run one step at a time', () => {
    const s = new PassScreener(sats, T, { horizonMin: 1 });
    let steps = 0;
    while (!s.step()) steps++;
    expect(steps).toBe(6);
    expect(s.progress).toBe(1);
  });

  it('treats objects from one launch as one family', () => {
    expect(launchOf('2023-031A')).toBe('2023-031');
    expect(launchOf('2026-156AX')).toBe('2026-156');
  });
});
