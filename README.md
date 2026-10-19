# @overhead/orbit

Orbit propagation and pass prediction for the overhead space-awareness app, from real
orbital elements in CCSDS OMM form (as published by CelesTrak).

- **Input is OMM, never TLE.** The 5-digit catalogue ran out on 2026-07-11. Objects numbered
  100000+ have no TLE data, so this package does not depend on the TLE format.
- Pure functions only: no network access, no I/O, no storage.
- Propagation uses SGP4/SDP4 via [satellite.js](https://github.com/shashwatak/satellite-js) (MIT),
  checked against published reference vectors (see `test/`).

## Status

| Module | State |
|---|---|
| `omm` | OMM parsing and validation |
| propagation, look angles, passes | Next build step |

## Licence

AGPL-3.0-only. See [LICENSE](./LICENSE).
