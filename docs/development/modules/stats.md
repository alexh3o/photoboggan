<!-- verified: none | sources: src-tauri/src/stats.rs, src/stats.js, src/stats.css -->
# Collection statistics

## Purpose
A read-only window, opened from the chart icon next to the shortcuts guide in Settings, that summarises the catalogue over a period chosen by the user: top 5 lenses, top 5 cameras, number of photos per month (per day for the last month) and the 15 most given keywords, then how many photos are geolocated and how many are not, and, when face detection is on, the number of people and faces.

## Files
| File | Role |
|---|---|
| `stats.rs` | `get_collection_stats(since, until, byDay)`: one blocking pass over `photos`, plus one grouped query on `photo_keywords` |
| `stats.js` | Window wiring (open, close, Escape), period calendar, rendering of rankings, chart and notes |
| `stats.css` | Layout, background bars of the rankings, chart columns |

## How it works
- The period is sliding and ends today: last month, 3 months, year, 2 years, or all time. `stats.js` turns it into two local-calendar days (`YYYYMMDD`); the backend only compares dates and never reads the clock. The first day is clamped to the end of a shorter month.
- Without a period every photo counts, dated or not. With one, only photos whose date taken is inside it count: a photo without a usable date cannot be placed in a period. In "all time" the photos without a date are counted in the rankings and reported under the chart.
- Dates are read like `extractTimeKey` in `main.js` (first `YYYY?MM?DD` of the text), but a month or day that does not exist, or a year outside 1900-2200, is no date.
- Cameras use the same label as the camera filter (`cameraLabel`); lenses and cameras are grouped without regard to case. Photos without the information are left out of the ranking, and a note under it says how many have it.
- Keywords are counted from the link table (last level of each path, like the keyword panel), not from the text column. Each shows its ancestors path.
- The chart has one column per month, empty ones included (from the first to the last month met for "all time"), or one per day for the last month. Wide periods scroll sideways.
- Geolocated means latitude and longitude both known (same rule as the geolocation filter, `gps_lat` / `gps_lon`); the other photos of the period are the not geolocated ones. The two rows show their share of all the photos counted.
- People and faces are shown only when `isFaceDetectionEnabled()` (faces-panel.js) is true; the backend always computes them. A face counts unless its state is `ignored`, `not_face` or `filtered`; a person counts when at least one such face is attributed to them (`person_id`; a mere suggestion is not an attribution).
- Shooting settings (focal length, aperture, shutter speed, ISO): one histogram each over fixed ranges (`FOCAL`, `APERTURE`, `SHUTTER`, `ISO` in `stats.rs`), all four computed in the same pass and returned together; the selector in the window only switches which one is drawn. Values are read like the shooting filters (`parseFocal`, `parseAperture`, `parseShutter` of shooting-filters.js: focal in whole mm, f-number to the tenth, shutter with 0.5 % tolerance, fractions such as `10/2500` accepted). A range includes its lower bound. Photos without the setting are in no range; a note says how many have it. Changing a range means editing the `Scale` constant only.
- The figures come from the catalogue, not from the displayed list, which is capped at 50,000 photos.

## Invariants
- Read-only: nothing is written to the catalogue or the files.
- The heavy part runs in `spawn_blocking`; the interface ignores an answer that arrives after a newer request or after closing.
- Escape closes only this window (capture phase), not Settings underneath.

## Gotchas
- `byDay` is honoured only for a bounded period of at most 400 days; otherwise the backend answers per month.
- A new lens or camera spelling is a new line: names are not merged beyond case.
