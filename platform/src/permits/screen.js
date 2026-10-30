// Automatic pre-screens for an address, from public federal data:
//   jurisdiction  U.S. Census geocoder: is the address inside the city's incorporated limits?
//   flood         FEMA National Flood Hazard Layer: which flood zone is it in?
// These are screens to speed up staff review, not determinations. The city makes the official
// zoning and floodplain determinations.

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
const FEMA = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';

async function getJson(url, ms = 12000) {
  const res = await fetch(url, { headers: { 'User-Agent': 'CityHallOS permit screening' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function screenAddress(address, city) {
  const out = { address, at: new Date().toISOString(), jurisdiction: { checked: false }, flood: { checked: false } };
  const placeName = city.settings.shortName || city.name.replace(/^(City|Town|Village) of /i, '');
  const query = /\b[A-Z]{2}\b\s*\d{5}|,\s*[A-Z]{2}\s*$/i.test(address) ? address : `${address}, ${placeName}, ${city.state}`;
  try {
    const q = new URLSearchParams({ address: query, benchmark: 'Public_AR_Current', vintage: 'Current_Current', layers: 'Incorporated Places,Counties', format: 'json' });
    const d = await getJson(`${CENSUS}?${q}`);
    const m = d.result?.addressMatches?.[0];
    if (m) {
      const place = m.geographies?.['Incorporated Places']?.[0];
      const county = m.geographies?.Counties?.[0];
      out.matchedAddress = m.matchedAddress.replace(/\b([A-Z])([A-Z]+)\b/g, (w, a, b) => (w.length === 2 ? w : a + b.toLowerCase())).replace(/, ([A-Z]{2}), (\d{5})$/, ', $1 $2');
      out.lat = m.coordinates.y; out.lon = m.coordinates.x;
      out.jurisdiction = {
        checked: true, source: 'U.S. Census Bureau geocoder',
        place: place?.NAME || null, county: county?.NAME ? `${county.NAME}` : null,
        inCity: !!place && place.NAME.toLowerCase().replace(/ (city|town|village)$/, '') === placeName.toLowerCase(),
      };
    } else {
      out.jurisdiction = { checked: false, error: 'The Census geocoder could not match this address.' };
    }
  } catch (e) {
    out.jurisdiction = { checked: false, error: `Census geocoder unavailable (${e.message}).` };
  }
  if (out.lat != null) {
    try {
      const q = new URLSearchParams({ geometry: `${out.lon},${out.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
        outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID', returnGeometry: 'false', f: 'json' });
      const d = await getJson(`${FEMA}?${q}`, 15000);
      const a = d.features?.[0]?.attributes;
      out.flood = a
        ? { checked: true, source: 'FEMA National Flood Hazard Layer', zone: a.FLD_ZONE, subtype: a.ZONE_SUBTY || null, sfha: a.SFHA_TF === 'T', bfe: a.STATIC_BFE > -9000 ? a.STATIC_BFE : null, panel: a.DFIRM_ID }
        : { checked: true, source: 'FEMA National Flood Hazard Layer', zone: null, sfha: false, note: 'No mapped flood zone at this point.' };
    } catch (e) {
      out.flood = { checked: false, error: `FEMA flood map service unavailable (${e.message}).` };
    }
  }
  return out;
}

// One line for the resident, right after they give the address.
export function screenSummary(sc, city) {
  if (!sc) return '';
  const name = city.settings.shortName;
  const parts = [];
  if (sc.jurisdiction.checked) {
    parts.push(sc.jurisdiction.inCity
      ? `I found **${sc.matchedAddress}**, inside ${name} city limits, so the City of ${name} handles this permit. If that's not the right property, just type the address again.`
      : `I found **${sc.matchedAddress}**, but federal Census maps place it ${sc.jurisdiction.place ? `in ${sc.jurisdiction.place}` : `outside ${name} city limits`}${sc.jurisdiction.county ? ` (${sc.jurisdiction.county})` : ''}. If it's outside city limits, the county issues the permit. I'll flag it so City Hall can confirm.`);
  } else {
    parts.push(`I couldn't match that address on federal maps, so City Hall will confirm the location.`);
  }
  if (sc.flood.checked && sc.flood.zone) {
    parts.push(sc.flood.sfha
      ? `FEMA maps show it in flood zone **${sc.flood.zone}**, a special flood hazard area, so a floodplain development permit will likely be needed too.`
      : `FEMA maps show flood zone **${sc.flood.zone}**${sc.flood.subtype ? ` (${sc.flood.subtype.toLowerCase()})` : ''}.`);
  }
  return parts.join(' ');
}
