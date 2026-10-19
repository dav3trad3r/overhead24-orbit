# SPDX-License-Identifier: AGPL-3.0-only
"""Generate independent reference values for the packages/orbit tests.

Reads   test/fixtures/omm-sample-2026-10-19.json   (real CelesTrak OMM records)
Writes  test/fixtures/reference-skyfield.json

References used (none of them share code with satellite.js):
  * python-sgp4 (Brandon Rhodes): Vallado's C++ SGP4, initialised from OMM -> TEME states.
  * Skyfield (Brandon Rhodes) + JPL DE421 -> geodetic sub-points, topocentric look angles,
    horizon-crossing events, Earth-shadow tests and Sun altitudes. Skyfield applies its built-in
    IERS UT1 and polar-motion tables; the app assumes UT1 = UTC with no polar motion, so the
    tests allow for that difference explicitly.

Run (from packages/orbit/scripts):
  py -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt
  .venv/Scripts/python gen_reference.py
"""

import datetime as dt
import json
from pathlib import Path

import jplephem
import numpy as np
import sgp4
import skyfield
from sgp4 import omm
from sgp4.api import Satrec
from skyfield.api import EarthSatellite, Loader, wgs84

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "test" / "fixtures"
UTC = dt.timezone.utc

load = Loader(str(HERE / ".skyfield"))
ts = load.timescale()
eph = load("de421.bsp")
earth, sun = eph["earth"], eph["sun"]

records = json.loads((FIXTURES / "omm-sample-2026-10-19.json").read_text(encoding="utf-8"))
by_id = {r["NORAD_CAT_ID"]: r for r in records}

OBSERVERS = {
    "new-york": {"latitudeDeg": 40.7128, "longitudeDeg": -74.006, "heightKm": 0.010},
    "sydney": {"latitudeDeg": -33.8597, "longitudeDeg": 151.2049, "heightKm": 0.040},
}
WINDOW_START = dt.datetime(2026, 10, 19, 0, 0, 0, tzinfo=UTC)


def fields(record):
    return {k: str(v) for k, v in record.items()}


def topos(name):
    o = OBSERVERS[name]
    return wgs84.latlon(o["latitudeDeg"], o["longitudeDeg"], elevation_m=o["heightKm"] * 1000)


def skyfield_sat(norad):
    return EarthSatellite.from_omm(ts, fields(by_id[norad]))


def iso(t):
    d = t.utc_datetime()
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def instants(minutes_step, count):
    return [WINDOW_START + dt.timedelta(minutes=minutes_step * k) for k in range(count)]


def teme_states():
    """Raw SGP4 output (TEME) at fixed offsets from each object's epoch."""
    offsets = [-1440.0, -60.0, 0.0, 1.0, 90.5, 720.0, 1440.0, 4320.0]
    out = {}
    for norad in [25544, 101004, 100000, 25867, 44453, 28358, 25933]:
        sat = Satrec()
        omm.initialize(sat, fields(by_id[norad]))
        rows = []
        for m in offsets:
            err, r, v = sat.sgp4_tsince(m)
            rows.append({"minutesFromEpoch": m, "error": err, "r": list(r), "v": list(v)})
        out[str(norad)] = rows
    return out


def positions():
    """Geodetic sub-points and look angles every 10 min for 24 h."""
    times = ts.from_datetimes(instants(10, 145))
    out = {}
    for norad in [25544, 101004, 28358]:
        s = skyfield_sat(norad)
        geo = s.at(times)
        lat, lon = wgs84.latlon_of(geo)
        height = wgs84.height_of(geo)
        entry = {
            "times": [iso(t) for t in times],
            "latitudeDeg": lat.degrees.tolist(),
            "longitudeDeg": lon.degrees.tolist(),
            "heightKm": height.km.tolist(),
            "look": {},
        }
        for name in OBSERVERS:
            alt, az, dist = (s - topos(name)).at(times).altaz()
            entry["look"][name] = {
                "elevationDeg": alt.degrees.tolist(),
                "azimuthDeg": az.degrees.tolist(),
                "rangeKm": dist.km.tolist(),
            }
        out[str(norad)] = entry
    return out


def sun_altitudes():
    times = ts.from_datetimes(instants(60, 25))
    out = {"times": [iso(t) for t in times]}
    for name in OBSERVERS:
        alt, _, _ = (earth + topos(name)).at(times).observe(sun).apparent().altaz()
        out[name] = alt.degrees.tolist()
    return out


def visible_window(s, observer, rise, set_):
    """Visible part of one pass at 1 s resolution: >= 10 deg, sunlit, Sun <= -6 deg."""
    n = int(round((set_.tt - rise.tt) * 86400)) + 1
    times = ts.tt_jd(rise.tt + np.arange(n) / 86400.0)
    alt = (s - observer).at(times).altaz()[0].degrees
    lit = s.at(times).is_sunlit(eph)
    sun_alt = (earth + observer).at(times).observe(sun).apparent().altaz()[0].degrees
    ok = (alt >= 10.0) & lit & (sun_alt <= -6.0)
    idx = np.flatnonzero(ok)
    if idx.size == 0:
        return None
    return {
        "start": iso(times[int(idx[0])]),
        "end": iso(times[int(idx[-1])]),
        "maxElevationDeg": float(alt[idx].max()),
    }


def passes():
    t0 = ts.from_datetime(WINDOW_START)
    t1 = ts.from_datetime(WINDOW_START + dt.timedelta(days=3))
    out = {}
    for norad in [25544, 101004, 48274]:
        s = skyfield_sat(norad)
        out[str(norad)] = {}
        for name in OBSERVERS:
            obs = topos(name)
            times, events = s.find_events(obs, t0, t1, altitude_degrees=0.0)
            found = []
            i = 0
            while i + 2 < len(events):
                if list(events[i : i + 3]) == [0, 1, 2]:
                    rise, culm, set_ = times[i], times[i + 1], times[i + 2]
                    alt = (s - obs).at(culm).altaz()[0].degrees
                    found.append(
                        {
                            "rise": iso(rise),
                            "culmination": iso(culm),
                            "set": iso(set_),
                            "maxElevationDeg": float(alt),
                            "visible": visible_window(s, obs, rise, set_),
                        }
                    )
                    i += 3
                else:
                    i += 1
            out[str(norad)][name] = found
    return out


def vallado_23599():
    """python-sgp4 at every time in vallado/23599.e. That case's C++ reference diverges after
    280.5 min (its "Lyddane" edge); this gives the tests an independent value to check against."""
    vdir = FIXTURES / "vallado"
    lines = [
        ln.rstrip("\n")
        for ln in (vdir / "SGP4-VER.TLE").read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.startswith("#")
    ]
    for i in range(0, len(lines), 2):
        if lines[i][2:7].strip() == "23599":
            sat = Satrec.twoline2rv(lines[i], lines[i + 1][:69])
            break
    rows = []
    in_data = False
    for ln in (vdir / "23599.e").read_text(encoding="utf-8").splitlines():
        if ln.startswith("EphemerisTimePosVel"):
            in_data = True
            continue
        cols = ln.split()
        if not in_data or len(cols) < 7 or ln.strip().startswith("END"):
            continue
        seconds = float(cols[0])
        err, r, v = sat.sgp4_tsince(seconds / 60.0)
        rows.append({"seconds": seconds, "error": err, "r": list(r), "v": list(v)})
    return rows


def shadow_transitions():
    """Times the ISS enters and leaves Earth's shadow over 24 h (1 s resolution)."""
    s = skyfield_sat(25544)
    t0 = ts.from_datetime(WINDOW_START)
    times = ts.tt_jd(t0.tt + np.arange(86400) / 86400.0)
    lit = s.at(times).is_sunlit(eph)
    flips = np.flatnonzero(lit[1:] != lit[:-1]) + 1
    return [{"time": iso(times[int(i)]), "sunlit": bool(lit[int(i)])} for i in flips]


result = {
    "generatedBy": "packages/orbit/scripts/gen_reference.py",
    "generatedAt": dt.datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "versions": {
        "skyfield": skyfield.__version__,
        "sgp4": sgp4.__version__,
        "numpy": np.__version__,
        "jplephem": jplephem.__version__,
        "ephemeris": "de421.bsp",
    },
    "observers": OBSERVERS,
    "teme": teme_states(),
    "positions": positions(),
    "sunAltitudes": sun_altitudes(),
    "passes": passes(),
    "issShadowTransitions": shadow_transitions(),
    "vallado23599PythonSgp4": vallado_23599(),
}
(FIXTURES / "reference-skyfield.json").write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
print("wrote reference-skyfield.json")
