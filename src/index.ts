import 'dotenv/config';
import http from 'http';
import mqtt from 'mqtt';
import { supabase, VehicleInfo, setVehicleMap, getVehicleByVin } from './db';
import { getState } from './state';
import { handleSpeedUpdate, scheduleGpsDatapoint, getActiveTrip, recordTripPower, updateTripTelemetry, recoverOrphanedTrips } from './trips';
import { handleChargeStateUpdate } from './charging';
import { scheduleSnapshot } from './snapshot';

const MQTT_BROKER = process.env.MQTT_BROKER!;
const MQTT_USERNAME = process.env.MQTT_USERNAME!;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD!;

async function loadVehicleMap() {
  const { data, error } = await supabase
    .from('vehicles')
    .select('id, vin, display_name, user_id');
  if (!data?.length) {
    console.error('No vehicles found:', error?.message);
    return;
  }
  const map = new Map<string, VehicleInfo>();
  for (const v of data) {
    map.set(v.vin, { vehicleId: String(v.id), displayName: v.display_name, userId: v.user_id });
    console.log(`Loaded vehicle: vin=${v.vin} id=${v.id}`);
  }
  setVehicleMap(map);
}

async function seedStateFromLastSnapshot() {
  const { data } = await supabase
    .from('vehicle_snapshots')
    .select('vehicle_id, odometer, battery_level, battery_range')
    .order('created_at', { ascending: false })
    .limit(10);
  if (!data?.length) return;

  // Find the latest snapshot per VIN and seed odometer into state
  const seen = new Set<string>();
  for (const row of data) {
    if (seen.has(row.vehicle_id)) continue;
    seen.add(row.vehicle_id);

    // Find the VIN for this vehicle_id from the vehicle map
    const { data: vehicles } = await supabase
      .from('vehicles')
      .select('vin')
      .eq('id', row.vehicle_id)
      .single();
    if (!vehicles?.vin) continue;

    const s = getState(vehicles.vin);
    if (row.odometer != null) s['Odometer'] = row.odometer;
    if (row.battery_level != null) s['BatteryLevel'] = row.battery_level;
    if (row.battery_range != null) s['EstBatteryRange'] = row.battery_range;
    console.log(`Seeded state from last snapshot: vin=${vehicles.vin} odometer=${row.odometer}`);
  }
}

loadVehicleMap().then(seedStateFromLastSnapshot);
recoverOrphanedTrips();

const client = mqtt.connect(`mqtts://${MQTT_BROKER}:8883`, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
});

client.on('connect', () => {
  console.log('Connected to HiveMQ');
  client.subscribe('tesla/#', (err) => {
    if (err) console.error('Subscribe error:', err);
    else console.log('Subscribed to tesla/#');
  });
});

client.on('message', (topic, payload) => {
  // topic format: tesla/{VIN}/v/{FieldKey}
  const parts = topic.split('/');
  if (parts.length !== 4 || parts[0] !== 'tesla' || parts[2] !== 'v') return;

  const vin = parts[1];
  const fieldKey = parts[3];

  let value: unknown;
  try {
    value = JSON.parse(payload.toString());
  } catch {
    value = payload.toString();
  }

  const s = getState(vin);
  const prevValue = s[fieldKey];
  s[fieldKey] = value;

  // Sentry mode: detect session end (true → false) and trigger enrichment
  if (fieldKey === 'SentryMode') {
    const wasActive = prevValue != null && Boolean(prevValue);
    const isActive = value != null && Boolean(value);
    if (wasActive && !isActive) {
      const insightsUrl = process.env.INSIGHTS_URL;
      if (insightsUrl) {
        const vehicle = getVehicleByVin(vin);
        if (vehicle) {
          fetch(`${insightsUrl}/enrich/sentry-sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vehicle_id: vehicle.vehicleId }),
          }).catch(err => console.error('[Sentry] Failed to trigger enrichment:', err));
        }
      }
    }
  }

  // Trip detection: handle speed updates immediately (don't wait for debounce)
  if (fieldKey === 'VehicleSpeed' && typeof value === 'number') {
    handleSpeedUpdate(value, vin);
  }

  // Charging detection: handle charge state transitions immediately
  if (fieldKey === 'DetailedChargeState' && typeof value === 'string') {
    handleChargeStateUpdate(value, vin);
  }


  // GPS tracking: write drive datapoint 2s after last Location update (separate from snapshot debounce)
  if (fieldKey === 'Location' && getActiveTrip(vin)) {
    scheduleGpsDatapoint(vin);
  }

  // Power tracking: record power sample when PackCurrent arrives during an active trip
  if (fieldKey === 'PackCurrent' && getActiveTrip(vin)) {
    recordTripPower(vin);
  }

  // Update last-telemetry timestamp for watchdog (no-op if no active trip)
  updateTripTelemetry(vin);

  // Debounce: schedule snapshot on meaningful fields only.
  // PackCurrent/PackVoltage arrive every 5s and would prevent the 30s debounce from ever firing.
  if (fieldKey !== 'PackCurrent' && fieldKey !== 'PackVoltage') {
    scheduleSnapshot(vin);
  }
});

client.on('error', (err) => console.error('MQTT error:', err));
client.on('disconnect', () => console.log('Disconnected from HiveMQ'));

// Health check server — keeps Fly.io from stopping the machine
http.createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(8080);
