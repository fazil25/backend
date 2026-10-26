const https = require('https');
const http = require('http');
const mapplsService = require('./services/mapplsService');

// Local landmark reference points with strict spatial radius boundary (<= 3 km)
const KNOWN_LANDMARKS = [
  // Tiruchirappalli (Trichy) Key Locations & Landmarks
  { name: 'Trichy TVS Tollgate', area: 'TVS Tollgate', city: 'Tiruchirappalli', state: 'Tamil Nadu', pincode: '620020', lat: 10.7938, lng: 78.6922 },
  { name: 'TVS Tollgate Bus Stop', area: 'TVS Tollgate', city: 'Tiruchirappalli', state: 'Tamil Nadu', pincode: '620020', lat: 10.7941, lng: 78.6925 },
  { name: 'Khaja Nagar', area: 'Khaja Nagar', city: 'Tiruchirappalli', state: 'Tamil Nadu', pincode: '620020', lat: 10.7905, lng: 78.6980 },
  { name: 'Thillai Nagar Main Road', area: 'Thillai Nagar', city: 'Tiruchirappalli', state: 'Tamil Nadu', pincode: '620018', lat: 10.8277, lng: 78.6946 },
  { name: 'Thillai Nagar Cross Road', area: 'Thillai Nagar', city: 'Tiruchirappalli', state: 'Tamil Nadu', pincode: '620018', lat: 10.8285, lng: 78.6950 },
  { name: 'Main Guard Gate Chatram', area: 'Chatram', city: 'Tiruchirappalli', state: 'Tamil Nadu', pincode: '620002', lat: 10.8312, lng: 78.6970 },
  { name: 'KK Nagar Trichy', area: 'KK Nagar', city: 'Tiruchirappalli', state: 'Tamil Nadu', pincode: '620021', lat: 10.7726, lng: 78.7042 },
  { name: 'Cantonment Central Bus Stand', area: 'Cantonment', city: 'Tiruchirappalli', state: 'Tamil Nadu', pincode: '620001', lat: 10.8030, lng: 78.6856 },
  { name: 'Srirangam Temple Tower', area: 'Srirangam', city: 'Tiruchirappalli', state: 'Tamil Nadu', pincode: '620006', lat: 10.8623, lng: 78.6901 },
  { name: 'Trichy International Airport', area: 'Airport Area', city: 'Tiruchirappalli', state: 'Tamil Nadu', pincode: '620007', lat: 10.7654, lng: 78.7097 },
  { name: 'Ariyalur Railway Station Road', area: 'Ariyalur', city: 'Ariyalur', state: 'Tamil Nadu', pincode: '621704', lat: 11.1401, lng: 79.0786 },
  { name: 'Ariyalur Bus Stand', area: 'Ariyalur', city: 'Ariyalur', state: 'Tamil Nadu', pincode: '621704', lat: 11.1385, lng: 79.0750 },
  { name: 'Chennai Central Railway Station', area: 'Park Town', city: 'Chennai', state: 'Tamil Nadu', pincode: '600003', lat: 13.0827, lng: 80.2755 },
  { name: 'Anna Nagar Roundtana', area: 'Anna Nagar', city: 'Chennai', state: 'Tamil Nadu', pincode: '600040', lat: 13.0850, lng: 80.2101 },
  { name: 'T Nagar Panagal Park', area: 'T Nagar', city: 'Chennai', state: 'Tamil Nadu', pincode: '600017', lat: 13.0405, lng: 80.2337 },
  { name: 'Indiranagar 100 Feet Road', area: 'Indiranagar', city: 'Bengaluru', state: 'Karnataka', pincode: '560038', lat: 12.9784, lng: 77.6408 },
  { name: 'Koramangala 4th Block', area: 'Koramangala', city: 'Bengaluru', state: 'Karnataka', pincode: '560034', lat: 12.9345, lng: 77.6265 },
  { name: 'HSR Layout Sector 1', area: 'HSR Layout', city: 'Bengaluru', state: 'Karnataka', pincode: '560102', lat: 12.9121, lng: 77.6446 },
  { name: 'Whitefield Main Road', area: 'Whitefield', city: 'Bengaluru', state: 'Karnataka', pincode: '560066', lat: 12.9698, lng: 77.7499 },
  { name: 'Electronic City Phase 1', area: 'Electronic City', city: 'Bengaluru', state: 'Karnataka', pincode: '560100', lat: 12.8399, lng: 77.6770 },
  { name: 'Bellandur EcoSpace', area: 'Bellandur', city: 'Bengaluru', state: 'Karnataka', pincode: '560103', lat: 12.9260, lng: 77.6762 },
];

/**
 * Calculates geodesic distance between two coordinate pairs in meters
 */
function haversineMeters(a, b) {
  if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function etaMinutes(meters) {
  if (meters == null) return null;
  const transitMetersPerMin = 333; // ~20 km/h average
  return Math.max(1, Math.round(meters / transitMetersPerMin));
}

/**
 * Finds a known landmark strictly within a close spatial proximity (max 3 km)
 */
function findNearestLandmark(lat, lng, maxDistanceMeters = 3000) {
  let best = null;
  let minDistance = Infinity;
  for (const lm of KNOWN_LANDMARKS) {
    const dist = haversineMeters({ lat, lng }, { lat: lm.lat, lng: lm.lng });
    if (dist !== null && dist < minDistance && dist <= maxDistanceMeters) {
      minDistance = dist;
      best = lm;
    }
  }
  return best ? { landmark: best, distanceMeters: minDistance } : { landmark: null, distanceMeters: null };
}

/**
 * Parses OpenStreetMap Nominatim reverse geocode JSON response into structured address components
 */
function parseNominatimAddress(raw, lat, lng) {
  const addr = raw.address || {};
  
  // 1. House / Building / Flat identifier
  const house = (
    addr.house_number ||
    addr.building ||
    addr.house_name ||
    addr.flats ||
    ''
  ).trim();

  // 2. Verified Landmark / Nearby POI
  const landmarkCandidate = (
    (raw.name && raw.name !== addr.road && raw.name !== addr.city && raw.name !== addr.suburb ? raw.name : '') ||
    addr.amenity ||
    addr.office ||
    addr.shop ||
    addr.tourism ||
    addr.historic ||
    addr.place_of_worship ||
    addr.commercial ||
    ''
  ).trim();

  // 3. Street / Road / Highway
  const street = (
    addr.road ||
    addr.street ||
    addr.footway ||
    addr.path ||
    addr.pedestrian ||
    addr.lane ||
    ''
  ).trim();

  // 4. Area / Locality / Suburb / Village
  const area = (
    addr.suburb ||
    addr.neighbourhood ||
    addr.residential ||
    addr.subdistrict ||
    addr.quarter ||
    addr.city_district ||
    addr.block ||
    addr.village ||
    addr.hamlet ||
    ''
  ).trim();

  // 5. City / Town / Municipality
  const city = (
    addr.city ||
    addr.town ||
    addr.municipality ||
    addr.city_district ||
    addr.county ||
    addr.district ||
    ''
  ).trim();

  // 6. District
  const district = (
    addr.state_district ||
    addr.county ||
    addr.district ||
    ''
  ).trim();

  // 7. State / Region
  const state = (
    addr.state ||
    addr.province ||
    addr.state_district ||
    ''
  ).trim();

  // 8. Postal / Pincode
  const pincode = (
    addr.postcode ||
    addr.postal_code ||
    ''
  ).trim();

  // 9. Country
  const country = (
    addr.country ||
    'India'
  ).trim();

  // Construct clean formatted address string without duplicates
  const cleanLandmark = (landmarkCandidate || '').replace(/^(near\s+)+/i, '').trim();
  const cleanParts = [];
  if (house) cleanParts.push(house);
  if (street && street !== house) cleanParts.push(street);
  if (cleanLandmark && cleanLandmark !== street && cleanLandmark !== house) {
    cleanParts.push(`Near ${cleanLandmark}`);
  }
  if (area && area !== street && area !== house) cleanParts.push(area);
  if (city && city !== area && city !== street) cleanParts.push(city);
  if (state && state !== city) cleanParts.push(state);
  if (pincode) cleanParts.push(pincode);

  let formattedAddress = '';
  if (raw.display_name && typeof raw.display_name === 'string') {
    formattedAddress = raw.display_name;
  } else {
    formattedAddress = cleanParts.join(', ');
  }

  if (!formattedAddress || formattedAddress.trim().length === 0) {
    formattedAddress = `Location at ${Number(lat).toFixed(4)}° N, ${Number(lng).toFixed(4)}° E`;
  }

  return {
    house,
    street,
    area: area || city || '',
    locality: area || '',
    landmark: cleanLandmark,
    city: city || district || area || '',
    district,
    state,
    pincode,
    country,
    formattedAddress,
    latitude: Number(lat),
    longitude: Number(lng),
  };
}

function httpFetchJson(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const client = isHttps ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': 'HomeStepIn-App/2.0 (support@homestepin.com)',
          Accept: 'application/json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error('Invalid JSON response from geocoding service'));
          }
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Geocoding request timed out'));
    });
  });
}

/**
 * Reverse geocodes exact coordinates into structured address representation
 */
async function reverseGeocode(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error('Invalid latitude/longitude coordinates');
  }

  // 1. Primary: Query Mappls (MapmyIndia) Reverse Geocoding API if configured
  try {
    const mapplsResult = await mapplsService.reverseGeocode(lat, lng);
    if (mapplsResult && (mapplsResult.formattedAddress || mapplsResult.city || mapplsResult.locality)) {
      return mapplsResult;
    }
  } catch (err) {
    // Graceful fallback to secondary geocoders
  }

  const nominatimBase = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';
  const bdcBase = process.env.BIGDATACLOUD_BASE_URL || 'https://api.bigdatacloud.net';

  // 2. Secondary: Query OpenStreetMap Nominatim
  try {
    const url = `${nominatimBase}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1&zoom=18`;
    const json = await httpFetchJson(url, 5000);
    if (json && json.address) {
      const parsed = parseNominatimAddress(json, lat, lng);
      parsed.provider = 'osm';
      return parsed;
    }
  } catch (err) {
    // Secondary failed: try tertiary
  }

  // 3. Tertiary: BigDataCloud Reverse Geocode Client API
  try {
    const bdcUrl = `${bdcBase}/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
    const bdc = await httpFetchJson(bdcUrl, 5000);
    if (bdc && (bdc.city || bdc.locality || bdc.principalSubdivision)) {
      const area = (bdc.locality || bdc.principalSubdivisionDistrict || '').trim();
      const city = (bdc.city || bdc.locality || bdc.principalSubdivisionDistrict || '').trim();
      const district = (bdc.principalSubdivisionDistrict || '').trim();
      const state = (bdc.principalSubdivision || '').trim();
      const pincode = (bdc.postcode || '').trim();
      const country = (bdc.countryName || 'India').trim();
      const cleanParts = [area, city, state, pincode].filter(Boolean);
      const formatted = cleanParts.join(', ');

      return {
        house: '',
        street: '',
        area: area || city,
        locality: area,
        landmark: '',
        city: city || area,
        district,
        state,
        pincode,
        country,
        formattedAddress: formatted,
        latitude: lat,
        longitude: lng,
        provider: 'bigdatacloud',
      };
    }
  } catch (err) {
    // Tertiary failed: try spatial landmark proximity check
  }

  // 4. Spatial Landmark Proximity Check (strictly <= 3 km)
  const { landmark } = findNearestLandmark(lat, lng, 3000);
  if (landmark) {
    const formatted = `${landmark.name}, ${landmark.area}, ${landmark.city}, ${landmark.state} - ${landmark.pincode}`;
    return {
      house: '',
      street: landmark.name,
      area: landmark.area,
      locality: landmark.area,
      city: landmark.city,
      district: '',
      state: landmark.state,
      pincode: landmark.pincode,
      country: 'India',
      formattedAddress: formatted,
      latitude: lat,
      longitude: lng,
      provider: 'landmark',
    };
  }

  // 5. Coordinate-Based Representation
  return {
    house: '',
    street: '',
    area: '',
    locality: '',
    city: '',
    district: '',
    state: '',
    pincode: '',
    country: 'India',
    formattedAddress: '',
    latitude: lat,
    longitude: lng,
    provider: 'coordinates',
  };
}

/**
 * Autocomplete / place search with coordinates
 * Supports Mappls AutoSuggest, verified landmarks, and Nominatim geocoding
 */
async function searchPlaces(query, locationBias = null) {
  if (!query || !query.trim() || query.trim().length < 2) return [];
  const rawQ = query.trim();
  const cleanQ = encodeURIComponent(rawQ);

  // 1. Primary: Mappls AutoSuggest if configured
  try {
    const mapplsList = await mapplsService.searchPlaces(rawQ, locationBias);
    if (Array.isArray(mapplsList) && mapplsList.length > 0) {
      return mapplsList;
    }
  } catch (err) {
    // Fallback to local landmark + Nominatim
  }

  // Normalize query string (e.g. "tolgate" -> "tollgate", "trichi" -> "trichy")
  let normalizedQuery = rawQ
    .toLowerCase()
    .replace(/\btolgate\b/g, 'tollgate')
    .replace(/\btiruchi\b/g, 'trichy')
    .replace(/\btiruchirapalli\b/g, 'tiruchirappalli');

  const lowerTokens = normalizedQuery.split(/\s+/).filter((k) => k.length > 1);

  // 2. Local landmark search with multi-keyword scoring
  const matchedLandmarks = KNOWN_LANDMARKS.filter((lm) => {
    const fullText = `${lm.name} ${lm.area} ${lm.city} ${lm.state} ${lm.pincode}`.toLowerCase();
    if (fullText.includes(normalizedQuery)) return true;
    if (fullText.includes(rawQ.toLowerCase())) return true;
    if (lowerTokens.length > 0) {
      const matchedTokens = lowerTokens.filter((t) => fullText.includes(t));
      if (matchedTokens.length === lowerTokens.length) return true;
      if (lowerTokens.length >= 2 && matchedTokens.length >= 2) return true;
    }
    return false;
  }).map((lm) => ({
    house: '',
    street: lm.name,
    area: lm.area,
    locality: lm.area,
    city: lm.city,
    district: '',
    state: lm.state,
    pincode: lm.pincode,
    country: 'India',
    formattedAddress: `${lm.name}, ${lm.area}, ${lm.city}, ${lm.state} - ${lm.pincode}`,
    latitude: lm.lat,
    longitude: lm.lng,
    provider: 'landmark',
  }));

  // 3. Nominatim Geocoding search
  let nominatimResults = [];
  const nominatimBase = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';
  try {
    const url = `${nominatimBase}/search?format=jsonv2&q=${cleanQ}&addressdetails=1&limit=8&countrycodes=in`;
    const list = await httpFetchJson(url, 5000);
    if (Array.isArray(list) && list.length > 0) {
      nominatimResults = list.map((item) => {
        const parsed = parseNominatimAddress(item, item.lat, item.lon);
        parsed.provider = 'osm';
        return parsed;
      });
    }
  } catch (err) {}

  // Combine and deduplicate
  const combined = [...matchedLandmarks, ...nominatimResults];
  const uniqueMap = new Map();
  combined.forEach((item) => {
    const key = (item.formattedAddress || `${item.area}_${item.city}`).toLowerCase();
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, item);
    }
  });

  return Array.from(uniqueMap.values());
}

/**
 * Calculates road routing distance, estimated duration, and polyline
 */
async function calculateRouteAndETA(originLat, originLng, destLat, destLng) {
  const oLat = Number(originLat);
  const oLng = Number(originLng);
  const dLat = Number(destLat);
  const dLng = Number(destLng);

  if (isNaN(oLat) || isNaN(oLng) || !isFinite(oLat) || !isFinite(oLng)) {
    throw new Error('Invalid origin coordinates');
  }
  if (isNaN(dLat) || isNaN(dLng) || !isFinite(dLat) || !isFinite(dLng)) {
    throw new Error('Invalid destination coordinates');
  }

  // 1. Try Mappls road routing & directions
  try {
    const mapplsRoute = await mapplsService.getRouteAndETA(oLat, oLng, dLat, dLng);
    if (mapplsRoute && mapplsRoute.distanceMeters != null) {
      return mapplsRoute;
    }
  } catch (err) {
    // Fallback to haversine estimation
  }

  // 2. Haversine Straight-line Distance Fallback
  const straightMeters = Math.round(haversineMeters({ lat: oLat, lng: oLng }, { lat: dLat, lng: dLng }) || 0);
  // Estimate driving road distance (~1.3x straight line factor)
  const estimatedRoadMeters = Math.round(straightMeters * 1.3);
  const durationMin = etaMinutes(estimatedRoadMeters);

  return {
    success: true,
    distanceMeters: estimatedRoadMeters,
    distanceKm: Number((estimatedRoadMeters / 1000).toFixed(2)),
    durationSeconds: durationMin * 60,
    durationMinutes: durationMin,
    polylineGeometry: null,
    provider: 'haversine_estimate',
    origin: { latitude: oLat, longitude: oLng },
    destination: { latitude: dLat, longitude: dLng },
  };
}

/**
 * Geocodes an address string to coordinates
 */
async function geocodeAddress(address) {
  if (!address || typeof address !== 'string' || !address.trim()) return null;
  try {
    const mapplsGeo = await mapplsService.geocode(address);
    if (mapplsGeo && mapplsGeo.latitude) {
      return mapplsGeo;
    }
  } catch (e) {}

  const places = await searchPlaces(address);
  if (places && places.length > 0) {
    return places[0];
  }
  return null;
}

/**
 * Searches nearby points of interest or service landmarks
 */
async function searchNearby(latitude, longitude, keywords = 'all', radiusMeters = 5000) {
  try {
    const mapplsNearby = await mapplsService.searchNearby(latitude, longitude, keywords, radiusMeters);
    if (Array.isArray(mapplsNearby) && mapplsNearby.length > 0) {
      return mapplsNearby;
    }
  } catch (e) {}

  const { landmark, distanceMeters } = findNearestLandmark(latitude, longitude, radiusMeters);
  if (landmark) {
    return [
      {
        placeName: landmark.name,
        placeAddress: `${landmark.name}, ${landmark.area}, ${landmark.city}`,
        latitude: landmark.lat,
        longitude: landmark.lng,
        distanceMeters,
        eLoc: '',
        provider: 'landmark',
      },
    ];
  }
  return [];
}

module.exports = {
  haversineMeters,
  etaMinutes,
  reverseGeocode,
  geocodeAddress,
  searchPlaces,
  searchNearby,
  findNearestLandmark,
  calculateRouteAndETA,
  KNOWN_LANDMARKS,
};


