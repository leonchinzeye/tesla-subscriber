import { supabase, getVehicleByVin } from './db';
import { getState } from './state';
import { reverseGeocode } from './geocode';

interface ActiveTrip {
  tripId: number;
  startTime: Date;
  startOdometer: number;
  startBattery: number;
  startRange: number | null;  // EstBatteryRange (miles) at trip start
  startLat: number | null;
  startLng: number | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  stopTime: number | null;    // ms timestamp when speed last dropped to 0
  maxSpeedKmh: number;
  insideTemps: number[];
  outsideTemps: number[];
  powerSamples: { powerKw: number; timestampMs: number }[];
  lastTelemetryMs: number;    // ms timestamp of last MQTT message during this trip
}

const activeTripMap = new Map<string, ActiveTrip | null>();
const TRIP_STOP_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes of 0 speed → end trip
const TELEMETRY_SILENCE_MS = 5 * 60 * 1000; // 5 min silence → watchdog closes trip

setInterval(() => {
  for (const [vin, trip] of activeTripMap) {
    if (!trip) continue;
    if (trip.stopTimer) continue; // normal stop timer already running
    if (Date.now() - trip.lastTelemetryMs > TELEMETRY_SILENCE_MS) {
      console.log(`Watchdog: closing silent trip id=${trip.tripId} vin=${vin}`);
      trip.stopTime = trip.lastTelemetryMs; // use last-heard-from time for accurate duration
      endTrip(vin);
    }
  }
}, 2 * 60 * 1000); // check every 2 minutes

// Separate GPS debounce — fires 2s after last Location update during a trip
const gpsDebounceTimerMap = new Map<string, ReturnType<typeof setTimeout>>();
const GPS_DEBOUNCE_MS = 2000;

export function getActiveTrip(vin: string): ActiveTrip | null {
  return activeTripMap.get(vin) ?? null;
}

export function updateTripTelemetry(vin: string): void {
  const trip = activeTripMap.get(vin);
  if (trip) trip.lastTelemetryMs = Date.now();
}

async function writeGpsDatapoint(vin: string) {
  const activeTrip = activeTripMap.get(vin);
  if (!activeTrip) return;
  const s = getState(vin);
  const location = s['Location'] as { latitude: number; longitude: number } | null;
  if (!location) return;

  // VehicleSpeed from Fleet Telemetry is in mph — convert to km/h
  const rawSpeedMph = s['VehicleSpeed'] as number | null;
  const speedKmh = rawSpeedMph != null ? rawSpeedMph * 1.60934 : null;
  const datapoint = {
    trip_id: activeTrip.tripId,
    timestamp: new Date().toISOString(),
    latitude: location.latitude,
    longitude: location.longitude,
    battery_level: Math.round(s['BatteryLevel'] as number),
    battery_range: (s['EstBatteryRange'] as number) ?? null,
    odometer: s['Odometer'] as number,
    speed_kmh: speedKmh,
    inside_temp: (s['InsideTemp'] as number) ?? null,
    outside_temp: (s['OutsideTemp'] as number) ?? null,
  };
  const { error } = await supabase.from('drive_datapoints').insert(datapoint);
  if (error) console.error('drive_datapoints insert error:', error);
}

export async function recordTripPower(vin: string): Promise<void> {
  const activeTrip = activeTripMap.get(vin);
  if (!activeTrip) return;
  const s = getState(vin);
  const packVoltage = s['PackVoltage'] as number | null;
  const packCurrent = s['PackCurrent'] as number | null;
  if (packVoltage == null || packCurrent == null) return;

  const powerKw = -(packVoltage * packCurrent) / 1000;
  activeTrip.powerSamples.push({ powerKw, timestampMs: Date.now() });

  const { error } = await supabase.from('drive_datapoints').insert({
    trip_id: activeTrip.tripId,
    timestamp: new Date().toISOString(),
    power_kw: powerKw,
    pack_current: packCurrent,
    pack_voltage: packVoltage,
    battery_level: s['BatteryLevel'] != null ? Math.round(s['BatteryLevel'] as number) : null,
    battery_range: (s['EstBatteryRange'] as number) ?? null,
    odometer: (s['Odometer'] as number) ?? null,
  });
  if (error) console.error('drive_datapoints power insert error:', error);
  console.log(`recordTripPower: trip=${activeTrip.tripId} power=${powerKw.toFixed(1)}kW samples=${activeTrip.powerSamples.length}`);
}

async function startTrip(vin: string) {
  const s = getState(vin);
  const location = s['Location'] as { latitude: number; longitude: number } | null;
  const odometer = s['Odometer'] as number;
  const battery = Math.round(s['BatteryLevel'] as number);
  const range = (s['EstBatteryRange'] as number) ?? null;

  const startLocation = location
    ? await reverseGeocode(location.latitude, location.longitude)
    : null;

  const vehicle = getVehicleByVin(vin);
  if (!vehicle) {
    console.error(`Cannot start trip: no vehicle info for VIN ${vin}`);
    return;
  }

  const { data, error } = await supabase
    .from('trips')
    .insert({
      vehicle_id: vehicle.vehicleId,
      user_id: vehicle.userId,
      start_time: new Date().toISOString(),
      start_odometer: odometer,
      start_battery: battery,
      start_latitude: location?.latitude ?? null,
      start_longitude: location?.longitude ?? null,
      start_location: startLocation,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('Failed to create trip:', error);
    return;
  }

  activeTripMap.set(vin, {
    tripId: data.id,
    startTime: new Date(),
    startOdometer: odometer,
    startBattery: battery,
    startRange: range,
    startLat: location?.latitude ?? null,
    startLng: location?.longitude ?? null,
    stopTimer: null,
    stopTime: null,
    maxSpeedKmh: 0,
    insideTemps: [],
    outsideTemps: [],
    powerSamples: [],
    lastTelemetryMs: Date.now(),
  });

  console.log(`Trip started: id=${data.id} vin=${vin} odometer=${odometer} battery=${battery}%`);
}

async function endTrip(vin: string) {
  const activeTrip = activeTripMap.get(vin);
  if (!activeTrip) return;
  const trip = activeTrip;
  activeTripMap.set(vin, null);

  const s = getState(vin);
  const location = s['Location'] as { latitude: number; longitude: number } | null;
  const endOdometer = s['Odometer'] as number;
  const endBattery = Math.round(s['BatteryLevel'] as number);
  const endRange = (s['EstBatteryRange'] as number) ?? null;
  const distanceKm = (endOdometer - trip.startOdometer) * 1.60934;

  const endLocation = location
    ? await reverseGeocode(location.latitude, location.longitude)
    : null;
  const effectiveEndMs = trip.stopTime ?? Date.now();
  const durationMinutes = Math.round((effectiveEndMs - trip.startTime.getTime()) / 60000);

  // Average speed = distance / time (includes stops, more meaningful than moving average)
  const avgSpeedKmh = distanceKm > 0 && durationMinutes > 0
    ? (distanceKm / durationMinutes) * 60
    : null;
  const avgInsideTemp = trip.insideTemps.length > 0
    ? trip.insideTemps.reduce((a, b) => a + b, 0) / trip.insideTemps.length
    : null;
  const avgOutsideTemp = trip.outsideTemps.length > 0
    ? trip.outsideTemps.reduce((a, b) => a + b, 0) / trip.outsideTemps.length
    : null;

  // Rated range used (miles → km)
  const ratedRangeUsedKm = trip.startRange != null && endRange != null
    ? (trip.startRange - endRange) * 1.60934
    : null;

  // Integrate power samples (trapezoidal rule) for accurate energy; fallback to rated range estimate
  let energyUsedKwh: number | null = null;
  if (trip.powerSamples.length >= 2) {
    let total = 0;
    for (let i = 1; i < trip.powerSamples.length; i++) {
      const dtHours = (trip.powerSamples[i].timestampMs - trip.powerSamples[i - 1].timestampMs) / 3_600_000;
      const avgPower = (trip.powerSamples[i].powerKw + trip.powerSamples[i - 1].powerKw) / 2;
      total += avgPower * dtHours;
    }
    energyUsedKwh = Math.max(0, total);
    console.log(`Trip energy (integrated): ${energyUsedKwh.toFixed(3)} kWh from ${trip.powerSamples.length} samples`);
  } else if (ratedRangeUsedKm != null && ratedRangeUsedKm > 0) {
    energyUsedKwh = ratedRangeUsedKm / 6.0;
    console.log(`Trip energy (rated range estimate): ${energyUsedKwh.toFixed(3)} kWh`);
  }
  const avgEnergyWhKm = energyUsedKwh != null && distanceKm > 0
    ? (energyUsedKwh * 1000) / distanceKm
    : null;

  const { error } = await supabase
    .from('trips')
    .update({
      end_time: new Date().toISOString(),
      end_odometer: endOdometer,
      end_battery: endBattery,
      end_latitude: location?.latitude ?? null,
      end_longitude: location?.longitude ?? null,
      end_location: endLocation,
      distance_km: distanceKm,
      duration_minutes: durationMinutes,
      avg_speed_kmh: avgSpeedKmh,
      max_speed_kmh: trip.maxSpeedKmh,
      avg_inside_temp: avgInsideTemp,
      avg_outside_temp: avgOutsideTemp,
      rated_range_used_km: ratedRangeUsedKm != null && ratedRangeUsedKm > 0 ? ratedRangeUsedKm : null,
      energy_used_kwh: energyUsedKwh,
      avg_energy_wh_km: avgEnergyWhKm,
    })
    .eq('id', trip.tripId);

  if (error) {
    console.error('Failed to close trip:', error);
  } else {
    console.log(`Trip ended: id=${trip.tripId} distance=${distanceKm.toFixed(1)}km duration=${durationMinutes}min`);
    // Fire-and-forget: trigger fee enrichment (ERP etc.) in wattlah-insights
    const insightsUrl = process.env.INSIGHTS_URL;
    if (insightsUrl) {
      fetch(`${insightsUrl}/enrich/trip/${trip.tripId}`, {
        method: 'POST',
        headers: { 'x-insights-secret': process.env.INSIGHTS_SECRET ?? '' },
      }).catch(err => console.warn(`[Insights] Failed to notify for trip ${trip.tripId}:`, err));
    }
  }
}

export function handleSpeedUpdate(speedMph: number, vin: string): void {
  const speedKmh = speedMph * 1.60934;
  const activeTrip = activeTripMap.get(vin) ?? null;
  const s = getState(vin);

  if (speedKmh > 0) {
    if (!activeTrip) {
      // Car just started moving — open a new trip
      startTrip(vin);
    } else {
      // Still driving — cancel any pending stop timer
      if (activeTrip.stopTimer) {
        clearTimeout(activeTrip.stopTimer);
        activeTrip.stopTimer = null;
      }
      // Track max speed and temperatures
      if (speedKmh > activeTrip.maxSpeedKmh) activeTrip.maxSpeedKmh = speedKmh;
      const inside = s['InsideTemp'] as number | null;
      const outside = s['OutsideTemp'] as number | null;
      if (inside != null) activeTrip.insideTemps.push(inside);
      if (outside != null) activeTrip.outsideTemps.push(outside);
    }
  } else if (activeTrip && !activeTrip.stopTimer) {
    // Speed dropped to 0 — record the stop time and start the stop timer
    activeTrip.stopTime = Date.now();
    activeTrip.stopTimer = setTimeout(() => endTrip(vin), TRIP_STOP_TIMEOUT_MS);
  }
}

export function scheduleGpsDatapoint(vin: string): void {
  const existing = gpsDebounceTimerMap.get(vin);
  if (existing) clearTimeout(existing);
  gpsDebounceTimerMap.set(vin, setTimeout(() => writeGpsDatapoint(vin), GPS_DEBOUNCE_MS));
}

export async function recoverOrphanedTrips(): Promise<void> {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: orphans, error } = await supabase
    .from('trips')
    .select('id, vehicle_id, start_time, start_odometer')
    .is('end_time', null)
    .lt('start_time', thirtyMinutesAgo);

  if (error) { console.error('recoverOrphanedTrips query error:', error); return; }
  if (!orphans?.length) { console.log('No orphaned trips to recover'); return; }

  console.log(`Recovering ${orphans.length} orphaned trip(s)`);

  for (const trip of orphans) {
    const { data: snap } = await supabase
      .from('vehicle_snapshots')
      .select('odometer, battery_level, battery_range, latitude, longitude, created_at')
      .eq('vehicle_id', trip.vehicle_id)
      .gt('created_at', trip.start_time)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const { data: powerRows } = await supabase
      .from('drive_datapoints')
      .select('power_kw, timestamp')
      .eq('trip_id', trip.id)
      .not('power_kw', 'is', null)
      .order('timestamp', { ascending: true });

    let energyUsedKwh: number | null = null;
    if (powerRows && powerRows.length >= 2) {
      let total = 0;
      for (let i = 1; i < powerRows.length; i++) {
        const dtHours =
          (new Date(powerRows[i].timestamp).getTime() -
            new Date(powerRows[i - 1].timestamp).getTime()) /
          3_600_000;
        const avgPower =
          ((powerRows[i].power_kw as number) + (powerRows[i - 1].power_kw as number)) / 2;
        total += avgPower * dtHours;
      }
      energyUsedKwh = Math.max(0, total);
    }

    const endOdometer = snap?.odometer ?? null;
    const endBattery = snap ? Math.round(snap.battery_level as number) : null;
    const endTime = snap?.created_at ?? new Date().toISOString();
    const distanceKm =
      endOdometer != null ? (endOdometer - trip.start_odometer) * 1.60934 : null;
    const durationMinutes = Math.round(
      (new Date(endTime).getTime() - new Date(trip.start_time).getTime()) / 60000,
    );
    const avgSpeedKmh =
      distanceKm != null && distanceKm > 0 && durationMinutes > 0
        ? (distanceKm / durationMinutes) * 60
        : null;
    const avgEnergyWhKm =
      energyUsedKwh != null && distanceKm != null && distanceKm > 0
        ? (energyUsedKwh * 1000) / distanceKm
        : null;
    const endLocation =
      snap?.latitude != null && snap?.longitude != null
        ? await reverseGeocode(snap.latitude as number, snap.longitude as number)
        : null;

    const { error: updateError } = await supabase
      .from('trips')
      .update({
        end_time: endTime,
        end_odometer: endOdometer,
        end_battery: endBattery,
        end_latitude: snap?.latitude ?? null,
        end_longitude: snap?.longitude ?? null,
        end_location: endLocation,
        distance_km: distanceKm,
        duration_minutes: durationMinutes,
        avg_speed_kmh: avgSpeedKmh,
        energy_used_kwh: energyUsedKwh,
        avg_energy_wh_km: avgEnergyWhKm,
      })
      .eq('id', trip.id);

    if (updateError) {
      console.error(`Failed to recover trip ${trip.id}:`, updateError);
    } else {
      console.log(
        `Recovered orphaned trip id=${trip.id} distance=${distanceKm?.toFixed(1)}km energy=${energyUsedKwh?.toFixed(3)}kWh`,
      );
    }
  }
}
