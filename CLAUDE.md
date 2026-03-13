# tesla-subscriber — Claude context

## What this service is

Node.js/TypeScript MQTT subscriber deployed on Fly.io (`wattlah-subscriber`, Singapore region). It bridges Tesla Fleet Telemetry (MQTT) to Supabase. It is a long-running process with no HTTP server.

## Key behaviours

- **Topic format**: `tesla/{VIN}/v/{FieldKey}` — one field per message, not batched
- **State map**: `state.ts` holds the latest value of every field per VIN in memory. It is the source of truth for snapshot/trip/charging writes
- **Snapshot debounce**: `scheduleSnapshot()` resets a 1s timer on every field arrival. The snapshot is written after 1s of silence — so a burst of 10 fields = 1 DB write
- **Trip detection**: Speed > 0 → `startTrip()`. Speed = 0 for 3 min → `endTrip()`. Watchdog closes trips silent for 5 min
- **GPS datapoints**: `scheduleGpsDatapoint()` uses a separate 2s debounce so it fires more frequently than snapshots during driving
- **Energy calculation**: `recordTripPower()` samples `PackCurrent × PackVoltage` and integrates with the trapezoidal rule at trip end. Falls back to rated range estimate if <2 samples
- **Charging**: `DetailedChargeState` transitions trigger session open/close. `"DetailedChargeStateCharging"` → strip prefix → `"Charging"`
- **Vehicle map**: Loaded from `vehicles` Supabase table at startup via `loadVehicleMap()`. Keyed by VIN

## Important units

- `VehicleSpeed` from Fleet Telemetry is in **mph** — always convert to km/h with `× 1.60934`
- `EstBatteryRange` is in **miles** — convert to km with `× 1.60934`
- `BatteryLevel` is a float — always `Math.round()` before DB insert
- Energy: `PackVoltage (V) × PackCurrent (A) / 1000 = kW`. PackCurrent is negative when discharging, so negate: `-(V × I) / 1000`

## Database

Supabase project: `jiqidipetgnlxuxdowye`. Tables written by this service:
- `vehicle_snapshots` — latest vehicle state, one row per telemetry burst
- `trips` — one row per drive, opened/closed by trips.ts
- `drive_datapoints` — GPS + power samples during trips
- `charging_sessions` — one row per charge, opened/closed by charging.ts
- `charging_datapoints` — time-series during charging (written alongside each snapshot)
- `vehicles` (read-only here) — VIN → vehicle_id mapping loaded at startup
- `user_settings` (read-only) — `electricity_rate` per user, read at charging session close

## Environment variables

All secrets are set as Fly secrets (`fly secrets set KEY=value`). Non-secrets are in `fly.toml [env]`.

- `MQTT_BROKER`, `MQTT_USERNAME`, `MQTT_PASSWORD` — HiveMQ connection
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — Supabase (service key has full access, never expose)
- `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET` — for token refresh in auth.ts

## Deploy & logs

```bash
fly deploy -a wattlah-subscriber   # from this directory
fly logs -a wattlah-subscriber
fly secrets set KEY=value -a wattlah-subscriber
```

## Do not

- Add an HTTP server — this is a pure subscriber process
- Commit `.env`, `node_modules/`, or `dist/`
- Re-run `supabase-schema.sql` — schema is already applied and data exists
- Store state in a DB between restarts — the in-memory state refills quickly from live telemetry
