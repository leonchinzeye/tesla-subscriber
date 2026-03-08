import { supabase, getVehicleByVin } from './db';
import { getState } from './state';
import { reverseGeocode } from './geocode';
import { getValidToken } from './auth';

interface ActiveChargingSession {
  sessionId: number;
  startTime: Date;
  startBattery: number;
  startOdometer: number;
  startRange: number | null;
  powerReadings: number[];  // kW, for avg
  maxPowerKw: number;
}

const activeChargingMap = new Map<string, ActiveChargingSession | null>();
const lastChargeStateMap = new Map<string, string | null>();

const TESLA_API_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';

async function fetchChargerType(
  vehicleId: string,
  userId: string
): Promise<{ isSupercharger: boolean; isFastCharger: boolean }> {
  try {
    const token = await getValidToken(userId);
    if (!token) return { isSupercharger: false, isFastCharger: true };

    const res = await fetch(
      `${TESLA_API_BASE}/api/1/vehicles/${vehicleId}/vehicle_data?endpoints=charge_state`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      console.warn(`fetchChargerType: API returned ${res.status}`);
      return { isSupercharger: false, isFastCharger: true };
    }
    const json = await res.json();
    const cs = json?.response?.charge_state;
    const type: string = cs?.fast_charger_type ?? '';
    const brand: string = cs?.fast_charger_brand ?? '';
    const isSupercharger = type === 'Tesla' || brand === 'Tesla' || type === 'MagicDock';
    const isFastCharger = cs?.fast_charger_present === true;
    return { isSupercharger, isFastCharger };
  } catch (err) {
    console.error('fetchChargerType error:', err);
    return { isSupercharger: false, isFastCharger: true };
  }
}

async function startChargingSession(chargeState: string, vin: string) {
  const vehicle = getVehicleByVin(vin);
  if (!vehicle) {
    console.error(`Cannot start charging session: no vehicle info for VIN ${vin}`);
    return;
  }

  const s = getState(vin);
  const location = s['Location'] as { latitude: number; longitude: number } | null;
  const battery = Math.round(s['BatteryLevel'] as number);
  const odometer = s['Odometer'] as number;
  const range = (s['EstBatteryRange'] as number) ?? null;
  const fastChargerPresent = s['FastChargerPresent'] as boolean | null;
  let isSupercharger = false;
  let isFastCharger = false;
  if (fastChargerPresent) {
    ({ isSupercharger, isFastCharger } = await fetchChargerType(vehicle.vehicleId, vehicle.userId));
  }

  const locationName = location
    ? await reverseGeocode(location.latitude, location.longitude)
    : null;

  const { data, error } = await supabase
    .from('charging_sessions')
    .insert({
      vehicle_id: vehicle.vehicleId,
      user_id: vehicle.userId,
      start_time: new Date().toISOString(),
      start_battery: battery,
      start_odometer: odometer,
      start_range: range,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      location: locationName,
      is_supercharger: isSupercharger,
      is_fast_charger: isFastCharger,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('Failed to create charging session:', error);
    return;
  }

  activeChargingMap.set(vin, {
    sessionId: data.id,
    startTime: new Date(),
    startBattery: battery,
    startOdometer: odometer,
    startRange: range,
    powerReadings: [],
    maxPowerKw: 0,
  });

  console.log(`Charging started: session=${data.id} vin=${vin} battery=${battery}% supercharger=${isSupercharger} fastCharger=${isFastCharger} location=${locationName ?? 'unknown'}`);
}

async function endChargingSession(vin: string) {
  const activeCharging = activeChargingMap.get(vin);
  if (!activeCharging) return;
  const session = activeCharging;
  activeChargingMap.set(vin, null);

  const s = getState(vin);
  const endBattery = Math.round(s['BatteryLevel'] as number);
  const endRange = (s['EstBatteryRange'] as number) ?? null;
  const energyAdded = (s['ACChargingEnergyIn'] as number) ?? null;
  const avgPowerKw = session.powerReadings.length > 0
    ? session.powerReadings.reduce((a, b) => a + b, 0) / session.powerReadings.length
    : null;

  const rangeAdded = endRange != null && session.startRange != null
    ? (endRange - session.startRange) * 1.60934  // miles → km
    : null;

  // Auto-calculate cost from global electricity rate setting
  let cost: number | null = null;
  let costPerKwh: number | null = null;
  const vehicle = getVehicleByVin(vin);
  const chargeRateQuery = supabase.from('user_settings').select('value').eq('key', 'electricity_rate');
  if (vehicle) chargeRateQuery.eq('user_id', vehicle.userId);
  const { data: rateSetting } = await chargeRateQuery.single();
  if (rateSetting) {
    const rate = parseFloat(rateSetting.value);
    if (!isNaN(rate) && energyAdded != null) {
      costPerKwh = rate;
      cost = energyAdded * rate;
    }
  }

  const { error } = await supabase
    .from('charging_sessions')
    .update({
      end_time: new Date().toISOString(),
      end_battery: endBattery,
      end_range: endRange,
      energy_added_kwh: energyAdded,
      rated_range_added: rangeAdded,
      charge_rate_kw: avgPowerKw,
      max_charge_rate_kw: session.maxPowerKw > 0 ? session.maxPowerKw : null,
      cost,
      cost_per_kwh: costPerKwh,
      cost_override: false,
    })
    .eq('id', session.sessionId);

  if (error) {
    console.error('Failed to close charging session:', error);
  } else {
    console.log(`Charging ended: session=${session.sessionId} added=${energyAdded?.toFixed(2)}kWh cost=${cost != null ? cost.toFixed(2) : 'n/a'}`);
  }
}

export function handleChargeStateUpdate(rawValue: string, vin: string): void {
  const chargeState = rawValue.replace(/^DetailedChargeState/, '') || null;
  const lastChargeState = lastChargeStateMap.get(vin) ?? null;

  // Only act on transitions
  if (chargeState === lastChargeState) return;
  lastChargeStateMap.set(vin, chargeState);

  const activeCharging = activeChargingMap.get(vin) ?? null;
  if (chargeState === 'Charging') {
    if (!activeCharging) startChargingSession(chargeState, vin);
  } else {
    if (activeCharging) endChargingSession(vin);
  }
}

export async function recordChargingDatapoint(vin: string): Promise<void> {
  const activeCharging = activeChargingMap.get(vin);
  if (!activeCharging) return;
  const s = getState(vin);
  const powerKw = (s['ACChargingPower'] as number) ?? null;
  if (powerKw != null) {
    activeCharging.powerReadings.push(powerKw);
    if (powerKw > activeCharging.maxPowerKw) activeCharging.maxPowerKw = powerKw;
  }
  const datapoint = {
    session_id: activeCharging.sessionId,
    battery_level: Math.round(s['BatteryLevel'] as number),
    battery_range: (s['EstBatteryRange'] as number) ?? null,
    charger_power: powerKw,
    charger_voltage: (s['ChargerVoltage'] as number) ?? null,
    charger_actual_current: (s['ChargeAmps'] as number) ?? null,
    charge_energy_added: (s['ACChargingEnergyIn'] as number) ?? null,
  };
  const { error } = await supabase.from('charging_datapoints').insert(datapoint);
  if (error) console.error('charging_datapoints insert error:', error);
}
