# fruit-battery

Realtime fruit-battery monitoring system.

## Data updater reliability

The scheduled updater keeps `data.json` as a rolling window of the latest 5,000 raw
measurements. Connectivity births, deaths, reconnects, and timeline events are kept
independently in `longevity.json`; reducing the raw window must not truncate that
history.

For the one-time migration of an existing cache, run `npm run migrate:data`. This
parses the production file, discards only invalid records, sorts valid measurements
oldest-to-newest, retains the newest 5,000, and preserves all top-level metadata.
It does not read or write `longevity.json`.

The updater requests the endpoint with both `limit=5000` and, when local data exists,
`after=<latest ISO timestamp>`. The Google Apps Script endpoint should implement these
parameters by applying `after` first and returning no more than `limit` rows, ordered
by timestamp. Until it does, the updater remains compatible with a full array response,
deduplicates overlap, and trims it locally, but cannot prevent the large download.

GitHub Actions schedules are best-effort and can be delayed or skipped. The workflow
uses an off-minute hourly schedule to reduce peak-time contention, and its timestamped
phase logs distinguish a scheduler/queue delay from fetch, validation, commit, or push
failures and from a successful run with no newer sensor data.

Committing frequently changing telemetry to Git is retained for the current static-site
architecture, but it causes repository history to grow even with the smaller rolling
window. If data volume continues to increase, move raw telemetry to object storage or a
time-series/database service and publish only the small static view needed by the site.
