# @overhead/orbit

Orbit propagation and visible-pass prediction from real orbital elements in CCSDS OMM form
(as published by CelesTrak), for the overhead24 space-awareness app. Pure functions: no network,
no I/O, safe in browsers and Web Workers.

- **Input is OMM, never TLE.** The 5-digit catalogue ran out on 2026-07-11; objects numbered
  100000+ have no TLE data.
- **Propagation is SGP4/SDP4** ([satellite.js](https://github.com/shashwatak/satellite-js) 7.1, MIT;
  WGS-72, "improved" mode), checked against published references (below).
- **The Sun** comes from [astronomy-engine](https://github.com/cosinekitty/astronomy) (MIT) for
  twilight, and satellite.js's model for Earth-shadow tests.

## API

| Function | Does |
|---|---|
| `parseOmmArray(json)` | Validates OMM records one by one; invalid ones are reported, never repaired |
| `satelliteFromOmm(omm)` | Initialises SGP4. Rejects non-SGP4 element sets (EPHEMERIS_TYPE ≠ 0) |
| `propagateAt(sat, date)` | TEME state, Earth-fixed position, geodetic sub-point, height, speed; `null` on SGP4 error or decay |
| `temeAtMinutes(sat, minutes)` | Raw SGP4 output at an exact offset from epoch |
| `lookAngles(observer, state)` | Azimuth, elevation (geometric), range |
| `objectsAbove(sats, observer, date)` | Every object above the horizon at one instant, with sunlit flag |
| `findPasses(sat, observer, {start, end})` | Rise, culmination, set, and the visible part with why it starts and ends |
| `sunAltitudeDeg(observer, date)`, `isSunlit(state)` | Twilight and Earth-shadow tests |
| `summarizeOrbit(sat)` | Period, perigee/apogee, class (LEO/MEO/GEO/GSO/HEO), sun-synchronous |
| `elementSetAgeDays(sat, date)` | How old the elements are (negative for future epochs) |

"Visible" means: at least 10° up, sunlit (the Sun's centre visible from the satellite), with
the Sun at least 6° below the observer's horizon. All three are options.

## Accuracy (what the tests check)

| Against | What | Limit in tests | Measured |
|---|---|---|---|
| Vallado et al. 2006 (AIAA 2006-6753) C++ reference, 32 objects, ~690 points | TEME position / velocity | 1 mm / 0.01 mm/s | 0.008 mm / 0.001 mm/s |
| python-sgp4 2.27, same OMM | TEME position / velocity | 1 cm / 0.01 mm/s | 0.6 mm |
| Skyfield 1.55 + DE421 | Sub-satellite latitude / longitude | 1e-6° / 0.001° | 2e-8° / 0.0004° |
| Skyfield | Elevation / azimuth / range | 0.005° / 0.01° / 100 m | 0.0015° / 0.0035° / 35 m |
| Skyfield | Rise, culmination, set times (ISS, Starlink, CSS; 2 sites; 3 days) | 1 s | 0.22 s |
| Skyfield | Visible-part start and end | 2 s | 1.0 s (reference is sampled at 1 s) |
| Skyfield | ISS shadow entry/exit | 3 s | 1.2 s |
| Skyfield/DE421 | Sun altitude | 0.005° | 0.0003° |

Known, documented differences:

- **UT1 = UTC.** Earth-fixed positions use GMST with UT1 = UTC and no polar motion. Skyfield
  applies IERS data; the difference is a ~0.0004° (~43 m) east-west shift on 2026-10-19, far
  below SGP4's own error (~1 km per day of element age).
- **Vallado case 23599** after 280.5 min (the "Lyddane" edge named in the test file): the 2021
  C++ reference differs by up to ~1 km from both satellite.js and python-sgp4, which agree with
  each other to 1 mm. We follow the two that agree.
- **Epoch precision.** satellite.js's OMM loader rounds the epoch to whole milliseconds; this
  package computes time since epoch from the full-precision string instead (to ~0.1 µs).

## Regenerating the reference fixture

```bash
cd packages/orbit/scripts
py -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python gen_reference.py
```

Fixture provenance is listed in [test/fixtures/README.md](./test/fixtures/README.md).

## Licence

AGPL-3.0-only. See [LICENSE](./LICENSE).
