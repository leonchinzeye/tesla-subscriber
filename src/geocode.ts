interface NominatimAddress {
  house_number?: string;
  road?: string;
  suburb?: string;
  quarter?: string;
  neighbourhood?: string;
  city_district?: string;
  country?: string;
  postcode?: string;
}

interface NominatimResponse {
  display_name?: string;
  address?: NominatimAddress;
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'tezzlah/1.0 (tesla-dashboard)' },
    });
    if (!res.ok) return null;
    const data = await res.json() as NominatimResponse;

    const addr = data.address;
    if (!addr?.road) return data.display_name ?? null;

    const streetPart = addr.house_number
      ? `${addr.house_number} ${addr.road}`
      : addr.road;

    const district = addr.suburb ?? addr.quarter ?? addr.neighbourhood ?? addr.city_district;
    const country = addr.country ?? 'Singapore';
    const postcode = addr.postcode;

    const parts: string[] = [streetPart];
    if (district) parts.push(district);
    parts.push(postcode ? `${country} ${postcode}` : country);

    return parts.join(', ');
  } catch {
    return null;
  }
}
