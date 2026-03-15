import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export interface VehicleInfo {
  vehicleId: string;   // Tesla numeric vehicle_id as string
  displayName: string;
  userId: string;
  batteryCapacityKwh: number | null;
}

const vehicleMap = new Map<string, VehicleInfo>();

export const getVehicleByVin = (vin: string) => vehicleMap.get(vin);

export function setVehicleMap(map: Map<string, VehicleInfo>) {
  vehicleMap.clear();
  map.forEach((v, k) => vehicleMap.set(k, v));
}

export function addVehicleToMap(vin: string, info: VehicleInfo) {
  vehicleMap.set(vin, info);
  console.log(`[Realtime] Vehicle added to map: vin=${vin} id=${info.vehicleId}`);
}
