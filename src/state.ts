const stateMap = new Map<string, Record<string, unknown>>();

export function getState(vin: string): Record<string, unknown> {
  if (!stateMap.has(vin)) stateMap.set(vin, {});
  return stateMap.get(vin)!;
}
