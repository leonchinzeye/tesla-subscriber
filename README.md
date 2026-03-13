# tesla-subscriber

MQTT subscriber that receives Tesla Fleet Telemetry data and writes it to Supabase. Deployed on Fly.io as `wattlah-subscriber`.

## What it does

Connects to a HiveMQ MQTT broker, subscribes to `tesla/+/v/+`, and processes field-level telemetry updates from one or more Tesla vehicles. On each update it:

- Maintains an in-memory state map per VIN (latest value of every telemetry field)
- Debounces incoming fields and writes a `vehicle_snapshots` row after 1s of silence
- Detects trips via `VehicleSpeed` transitions → creates/closes rows in `trips` and `drive_datapoints`
- Detects charging via `DetailedChargeState` transitions → creates/closes rows in `charging_sessions` and `charging_datapoints`
- Writes GPS datapoints to `drive_datapoints` on every `Location` update during an active trip (2s debounce)
- Integrates `PackCurrent`/`PackVoltage` samples during trips for accurate energy calculation (kWh)
- Reverse-geocodes start/end locations via Nominatim (OpenStreetMap)
- Runs a watchdog timer that closes trips silent for >5 min

Vehicle metadata (VIN → vehicle_id, display_name, user_id) is loaded from the `vehicles` Supabase table at startup.

## Source layout

```
src/
  index.ts      — MQTT client, message dispatch
  db.ts         — Supabase client, VehicleInfo type, vehicle map
  state.ts      — Per-VIN in-memory field state
  snapshot.ts   — Debounced vehicle_snapshots writes + charging datapoint trigger
  trips.ts      — Trip start/end detection, GPS datapoints, power integration
  charging.ts   — Charging session start/end, datapoints, cost calculation
  geocode.ts    — Nominatim reverse geocode helper
  auth.ts       — Tesla token refresh utilities
```

## MQTT topic format

```
tesla/{VIN}/v/{FieldKey}
```

Each message payload is a JSON-encoded scalar (number, string, or `{latitude, longitude}` object for `Location`).

## Supabase tables written

| Table | Written by |
|---|---|
| `vehicle_snapshots` | snapshot.ts — every telemetry burst |
| `trips` | trips.ts — on trip start and end |
| `drive_datapoints` | trips.ts — GPS + power samples during trips |
| `charging_sessions` | charging.ts — on charge start and end |
| `charging_datapoints` | charging.ts — every snapshot during charging |

## Environment variables

| Variable | Where set |
|---|---|
| `MQTT_BROKER` | `fly.toml` (non-secret) |
| `MQTT_USERNAME` | Fly secret |
| `MQTT_PASSWORD` | Fly secret |
| `NEXT_PUBLIC_SUPABASE_URL` | `fly.toml` (non-secret) |
| `SUPABASE_SERVICE_KEY` | Fly secret |
| `TESLA_CLIENT_ID` | Fly secret |
| `TESLA_CLIENT_SECRET` | Fly secret |
| `INSIGHTS_URL` | Fly secret — URL of `wattlah-insights`; fires `POST /enrich/trip/:id` after each trip closes |

For local dev, copy these into a `.env` file (gitignored).

## Local dev

```bash
npm install
npm run dev        # tsx watch — hot reload
```

## Deploy

```bash
fly deploy         # from this directory
fly logs -a wattlah-subscriber
```
