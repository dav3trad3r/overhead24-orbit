# How overhead24 works things out

[overhead24.com](https://overhead24.com) turns public orbit data into plain-language detections:
which satellites changed orbit, which are closing on others, which stopped being tracked, and
which countries' military satellites pass over places where fighting was recorded. This page
says exactly how each one is worked out, so anyone can judge what it means and what it doesn't.

The orbit maths (SGP4 propagation, passes, proximity screening, manoeuvre comparison) is the
code in this repository. The rules that run on top of it (when to log an event, the conflict
and baseline rules) live in overhead24's private worker; their parameters are given here in full.

**What none of this can tell you.** Everything is computed from public orbital elements, which
are accurate to around a kilometre when issued and get worse with age. A satellite being over a
place says nothing about what it is doing there. A pattern in orbits is a pattern in orbits, not
evidence of intent. Not for collision avoidance, navigation or targeting.

## Sources

| Data | Source | Licence |
|---|---|---|
| Orbital elements (OMM), element history, satellite catalogue, re-entries | [Space-Track.org](https://www.space-track.org) (US Space Force), with [CelesTrak](https://celestrak.org) as fallback | Space-Track's approval for basic space-situational-awareness data, with citation |
| Owners, countries, military class (payload class D) | [GCAT](https://planet4589.org/space/gcat) by Jonathan McDowell | CC BY 4.0 |
| Where fighting was recorded | [UCDP](https://ucdp.uu.se) Candidate Events (state-based, 25+ deaths), placed by coordinates in 0.5° cells; conflict start years from UCDP/PRIO Armed Conflict Dataset 26.1 (Davies, Pettersson & Öberg 2026) | CC BY 4.0 |
| Launches | [Launch Library 2](https://thespacedevs.com/llapi) (The Space Devs) | Free use, attribution |

"Working" means CelesTrak's catalogue lists the satellite as operational (or partly, backup,
spare or extended mission), or it was launched after that list was made.

## Propagation and passes

SGP4/SDP4 via [satellite.js](https://github.com/shashwatak/satellite-js), fed OMM records
directly (catalogue numbers above 99999 have no TLEs). Checked against Vallado et al. 2006 and
Skyfield; see [README](README.md#accuracy-what-the-tests-check). A pass is visible when the
satellite is at least 10° up, in sunlight, and the Sun is at least 6° below the horizon.

## Close approaches

- **Staying close:** pairs within 100 km now that stay within 200 km for 24 hours either side.
- **Passing close:** closest approaches under 5 km in the next 6 hours, screened every 10 s and
  refined. Shown in distance bands, never as exact misses.
- **Closing in (military and unclassified):** a watched satellite and another object in nearly
  the same orbit (planes within 1°, semi-major axes within 100 km, now within 200 km in low orbit
  or 500 km higher), whose separation falls by at least 40 km across the day before and after.
  Distances use the current elements for all three samples, so the trend is "on present orbits".
  Watched satellites are those GCAT classes as military, plus working satellites GCAT hasn't
  classified yet (mostly recent launches; Starlink and rocket bodies left out), whose purpose
  isn't known. Pairs from the same launch are skipped, so a batch spreading out after deployment
  doesn't count.
- **Closest-approach forecast (approaching pairs):** whenever either satellite of an approaching
  pair gets a new element set, the closest approach in the next 7 days is worked out again:
  scanned every 20 s, refined to about a millisecond, and split into radial, in-track and
  cross-track offsets in the second satellite's frame, with the relative speed. Co-orbital pairs
  pass through two near-equal minima per orbit, where their planes cross, so the next-closest is
  kept too. Each forecast is stored with the two element-set epochs it used, so the history shows
  how the prediction moves as tracking comes in. Pairs are followed until a day after the pass;
  after it, the window opens 12 hours before the last predicted closest approach, so post-pass
  element sets re-measure the pass. Who is catching whom comes from the along-track gap now and a
  day later, and from which satellite is lower (and so faster). Public element sets carry no
  uncertainty, so these are predicted distances, not collision probabilities.

## Orbit changes (manoeuvres)

Each new element set is compared with the previous one propagated to the new epoch. A change in
orbit size (less the drag decay the old set predicts) or in tilt beyond normal update noise is a
candidate:

| Orbit | Size change | Tilt change | "Large" (relocation) |
|---|---|---|---|
| Low (LEO) | 0.5 km | 0.01° | 5 km / 0.05° |
| Medium (MEO) | 0.3 km | 0.01° | 3 km / 0.05° |
| Geostationary | 1.5 km | 0.03° | 10 km / 0.1° |
| Highly elliptical | not used | 0.02° | 0.1° |

The thresholds sit above the 99th percentile of update-to-update noise measured over ~15,900
real updates (19 Oct 2026). Element sets more than 10 days apart aren't compared. **A candidate
becomes a manoeuvre only when the next element set shows the same change again**, so a one-off
poor fit is never reported. Starlink is left out (it adjusts almost continuously). Satellites
in very low orbits (under ~350 km) re-boost every day or two against drag: those show as frequent
small orbit raises and are routine.

## Public tracking stopped ("gone dark")

A satellite whose newest public element set is older than three times its usual update gap
(at least 72 hours; 7 days when the gap isn't known yet), or that dropped out of the public
download for 12 hours or more. This is about public tracking data only: it says nothing about
radio contact. Only working satellites count as news.

## Conflict-zone clusters

Over the next 24 hours, in 1-minute steps: moments when satellites from **4 or more different
launches** of one country's working military satellites are over places where fighting was
recorded, at once. "Over" means the point beneath the satellite is in a 0.5° fighting cell or
one next to it (about 50–100 km). Satellites from one launch count once (formations fly
together), a country over itself doesn't count, and clusters of the same country over the same
place within 5 minutes merge. Satellites that changed orbit in the past week are marked. Passes
are fixed by orbits days ahead, so most clusters are coincidences of geometry.

## Coverage of conflict areas

Per UTC day, for each country and conflict area: predicted passes (entries into the fighting
cells by the rule above), minutes overhead and number of satellites. Week-on-week arrows compare
the last 7 days with the 7 before, on at least 35 passes in the earlier week. Each change names
the satellites behind it: newly launched (in the fortnight), moved in or out after an orbit
change, or no longer working. With such a cause, an arrow shows from a 10% (and 5-pass) change.
Without one it needs 35%, because ground tracks repeat over several days and weeks differ on
their own: with the same satellites both weeks, the change was 4% typically and 32% at most
(measured 20 Oct 2026 over every country and area with at least five passes a day). The days before coverage
went live (20 Oct 2026) were worked out from each satellite's own past elements, leaving out any
day where under 95% of the satellites then in orbit had elements under a week old.

## Geostationary moves

Each geostationary payload's longitude at midnight UTC (SGP4) and its drift, from mean motion
against one sidereal day: (n − 1.00273791) × 360° a day. At least 0.15°/day is drifting, under
0.05°/day is stationed; in between, it keeps the state it had. A working satellite going from
stationed to drifting has **left its slot**; from drifting to stationed, it has **arrived**, and
other countries' working satellites within 0.5° are named (parking beside another satellite is
how inspection satellites work).

## Possible breakups

Space-Track's full catalogue of objects in orbit (payloads, rocket bodies, debris), once a day.
Three or more pieces newly catalogued within a week from a launch more than a month old are
logged. That usually means something broke up recently, or that older debris was only now
catalogued: the log says both.

## Busier than usual

Daily counts per country: military orbit changes, military satellites closing on others, new
military satellites catalogued, military geostationary relocations, and predicted passes over
conflict areas. A country's last 7 days are flagged when they are **at least 3, at least twice
its usual week, and at least 3 standard deviations (Poisson) above it**, where "usual" is the 90
days before. No country is judged until its normal has 28 days of counts; each count starts on
the first day its input was complete (orbit changes from the element history, the rest from the
day they were first counted).

## Corrections

If something here is wrong, or a detection looks wrong, please
[open an issue](../../issues) with the satellite's catalogue number and the time.
