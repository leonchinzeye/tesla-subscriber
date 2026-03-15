import { supabase, getVehicleByVin } from './db';
import { getState } from './state';
import { recordChargingDatapoint } from './charging';

const debounceTimerMap = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 30000;

async function writeSnapshot(vin: string) {
  const s = getState(vin);
  if (s['BatteryLevel'] == null || s['Odometer'] == null) return;

  const vehicle = getVehicleByVin(vin);
  if (!vehicle) {
    console.error(`Cannot write snapshot: no vehicle info for VIN ${vin}`);
    return;
  }

  const location = s['Location'] as { latitude: number; longitude: number } | null;
  const chargeStateRaw = s['DetailedChargeState'];
  const chargeState = typeof chargeStateRaw === 'string'
    ? chargeStateRaw.replace(/^DetailedChargeState/, '') || null
    : null;

  const snapshot = {
    vehicle_id: vehicle.vehicleId,
    user_id: vehicle.userId,
    display_name: vehicle.displayName,
    battery_level: Math.round(s['BatteryLevel'] as number),
    battery_range: (s['EstBatteryRange'] as number) ?? null,
    charging_state: chargeState,
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
    odometer: s['Odometer'] as number,
    inside_temp: (s['InsideTemp'] as number) ?? null,
    outside_temp: (s['OutsideTemp'] as number) ?? null,
    charger_power: (s['ACChargingPower'] as number) ?? null,
    charger_voltage: (s['ChargerVoltage'] as number) ?? null,
    charger_actual_current: (s['ChargeAmps'] as number) ?? null,
    charge_energy_added: (s['ACChargingEnergyIn'] as number) ?? null,
    hvac_on: s['HvacACEnabled'] != null ? Boolean(s['HvacACEnabled']) : null,
    front_driver_door: (s['DoorState'] as any)?.DriverFront ?? (s['DoorState'] as any)?.driverFront ?? null,
    front_passenger_door: (s['DoorState'] as any)?.PassengerFront ?? (s['DoorState'] as any)?.passengerFront ?? null,
    rear_driver_door: (s['DoorState'] as any)?.DriverRear ?? (s['DoorState'] as any)?.driverRear ?? null,
    rear_passenger_door: (s['DoorState'] as any)?.PassengerRear ?? (s['DoorState'] as any)?.passengerRear ?? null,
    trunk_open: (s['DoorState'] as any)?.TrunkRear ?? (s['DoorState'] as any)?.trunkRear ?? null,
    frunk_open: (s['DoorState'] as any)?.TrunkFront ?? (s['DoorState'] as any)?.trunkFront ?? null,
    sentry_mode: s['SentryMode'] != null ? Boolean(s['SentryMode']) : null,
    locked: s['Locked'] != null ? Boolean(s['Locked']) : null,
  };

  console.log(`Writing snapshot: vin=${vin} battery=${snapshot.battery_level}% odometer=${snapshot.odometer} charging=${snapshot.charging_state}`);

  try {
    const { error } = await supabase.from('vehicle_snapshots').insert(snapshot);
    if (error) console.error('Supabase insert error:', error);
    else console.log('Snapshot inserted');
  } catch (err) {
    console.error('Error writing to Supabase:', err);
  }

  await recordChargingDatapoint(vin);
}

export function scheduleSnapshot(vin: string): void {
  const existing = debounceTimerMap.get(vin);
  if (existing) clearTimeout(existing);
  debounceTimerMap.set(vin, setTimeout(() => writeSnapshot(vin), DEBOUNCE_MS));
}
