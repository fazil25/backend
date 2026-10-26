const https = require('https');
const http = require('http');
const config = require('../config');

// In-memory OAuth token cache
let cachedOAuthToken = null;
let oAuthTokenExpiresAt = 0;
let tokenRequestPromise = null;

function requestJson(url, options = {}, postData = null, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const client = isHttps ? https : http;
    const urlObj = new URL(url);

    const headers = {
      Accept: 'application/json',
      'User-Agent': 'HomeStepIn-App/2.0',
      ...(options.headers || {}),
    };

    if (postData) {
      if (typeof postData === 'string') {
        headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(postData);
      } else if (typeof postData === 'object') {
        headers['Content-Type'] = 'application/json';
        postData = JSON.stringify(postData);
        headers['Content-Length'] = Buffer.byteLength(postData);
      }
    }

    const reqOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || (postData ? 'POST' : 'GET'),
      headers,
      timeout: timeoutMs,
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data, parseError: true });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Mappls API request timed out'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/**
 * Resolves active Mappls authorization token (either direct API key or OAuth 2.0 bearer token)
 */
async function getAuthToken() {
  // 1. Direct Static API Key / Token
  const staticKey =
    config.mapplsApiKey ||
    process.env.MAPPLS_API_KEY ||
    process.env.MAPPLS_REST_API_KEY ||
    process.env.MAPPLS_ACCESS_TOKEN ||
    '';

  if (staticKey.trim().length > 0) {
    return staticKey.trim();
  }

  // 2. Automated OAuth 2.0 Token Generation via Client ID & Secret
  const clientId = config.mapplsClientId || process.env.MAPPLS_CLIENT_ID;
  const clientSecret = config.mapplsClientSecret || process.env.MAPPLS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  const now = Date.now();
  if (cachedOAuthToken && oAuthTokenExpiresAt > now + 60000) {
    return cachedOAuthToken;
  }

  if (tokenRequestPromise) {
    return tokenRequestPromise;
  }

  tokenRequestPromise = (async () => {
    try {
      const postBody = `grant_type=client_credentials&client_id=${encodeURIComponent(
        clientId
      )}&client_secret=${encodeURIComponent(clientSecret)}`;

      const response = await requestJson(
        'https://outpost.mappls.com/api/security/oauth/token',
        { method: 'POST' },
        postBody,
        7000
      );

      if (response.status === 200 && response.data && response.data.access_token) {
        cachedOAuthToken = response.data.access_token;
        const ttlSec = Number(response.data.expires_in) || 86400;
        oAuthTokenExpiresAt = Date.now() + ttlSec * 1000;
        return cachedOAuthToken;
      }

      cachedOAuthToken = null;
      return null;
    } catch (err) {
      cachedOAuthToken = null;
      return null;
    } finally {
      tokenRequestPromise = null;
    }
  })();

  return tokenRequestPromise;
}

/**
 * Clears cached OAuth token upon 401 Unauthorized
 */
function invalidateToken() {
  cachedOAuthToken = null;
  oAuthTokenExpiresAt = 0;
}

/**
 * Checks if Mappls backend credentials are configured
 */
function isMapplsConfigured() {
  const hasStaticKey = Boolean(config.mapplsApiKey || process.env.MAPPLS_API_KEY || process.env.MAPPLS_REST_API_KEY);
  const hasOAuth = Boolean(
    (config.mapplsClientId || process.env.MAPPLS_CLIENT_ID) &&
      (config.mapplsClientSecret || process.env.MAPPLS_CLIENT_SECRET)
  );
  return hasStaticKey || hasOAuth;
}

/**
 * 1. Mappls Reverse Geocoding API
 * Converts latitude and longitude into structured Indian address representation
 */
async function reverseGeocode(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error('Invalid latitude/longitude coordinates');
  }

  const token = await getAuthToken();
  if (!token) {
    return null;
  }

  try {
    const url = `https://apis.mappls.com/advancedmaps/v1/${token}/rev_geocode?lat=${lat}&lng=${lng}`;
    const res = await requestJson(url, {}, null, 5000);

    if (res.status === 401) {
      invalidateToken();
      return null;
    }

    if (res.status === 200 && res.data) {
      const results = res.data.results;
      const first = Array.isArray(results) ? results[0] : results;
      if (first) {
        const house = (first.houseNumber || first.houseName || '').trim();
        const street = (first.street || first.road || '').trim();
        const sublocality = (first.subSubLocality || first.subLocality || '').trim();
        const locality = (first.locality || first.subDistrict || sublocality || '').trim();
        const city = (first.city || first.district || locality || '').trim();
        const district = (first.district || city || '').trim();
        const state = (first.state || '').trim();
        const pincode = (first.pincode || '').trim();
        const eLoc = (first.eLoc || first.place_id || '').trim();
        const formattedAddress = (first.formatted_address || '').trim();

        return {
          house,
          street,
          area: locality || sublocality || city,
          locality: locality || sublocality,
          landmark: (first.poi || '').trim(),
          city: city || district,
          district,
          state,
          pincode,
          country: 'India',
          formattedAddress:
            formattedAddress ||
            [house, street, sublocality, locality, city, state, pincode]
              .filter(Boolean)
              .join(', '),
          latitude: lat,
          longitude: lng,
          eLoc,
          provider: 'mappls',
        };
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * 2. Mappls Forward Geocoding API
 * Converts address string into geographic coordinates
 */
async function geocode(address) {
  if (!address || typeof address !== 'string' || !address.trim()) return null;

  const token = await getAuthToken();
  if (!token) return null;

  try {
    const cleanAddr = encodeURIComponent(address.trim());
    const url = `https://apis.mappls.com/advancedmaps/v1/${token}/geo_code?addr=${cleanAddr}`;
    const res = await requestJson(url, {}, null, 5000);

    if (res.status === 401) {
      invalidateToken();
      return null;
    }

    if (res.status === 200 && res.data && Array.isArray(res.data.results) && res.data.results.length > 0) {
      const first = res.data.results[0];
      return {
        latitude: Number(first.lat || first.latitude),
        longitude: Number(first.lng || first.longitude),
        formattedAddress: first.formatted_address || address,
        city: first.city || '',
        state: first.state || '',
        pincode: first.pincode || '',
        eLoc: first.eLoc || '',
        provider: 'mappls',
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * 3. Mappls AutoSuggest & Text Search API
 * Searches Indian localities, places, landmarks, and street addresses
 */
async function searchPlaces(query, locationBias = null) {
  if (!query || !query.trim() || query.trim().length < 2) return [];

  const token = await getAuthToken();
  if (!token) {
    return null;
  }

  try {
    const cleanQ = encodeURIComponent(query.trim());
    let url = `https://atlas.mappls.com/api/places/search/json?query=${cleanQ}&country=IND`;
    if (locationBias && typeof locationBias.latitude === 'number' && typeof locationBias.longitude === 'number') {
      url += `&location=${locationBias.latitude},${locationBias.longitude}`;
    }

    const headers = { Authorization: `Bearer ${token}` };
    let res = await requestJson(url, { headers }, null, 5000);

    if (res.status === 401) {
      invalidateToken();
      // Try secondary endpoint
      const advUrl = `https://apis.mappls.com/advancedmaps/v1/${token}/places/search/json?query=${cleanQ}`;
      res = await requestJson(advUrl, {}, null, 5000);
    }

    if (res.status === 200 && res.data && Array.isArray(res.data.suggestedLocations)) {
      return res.data.suggestedLocations.map((item) => {
        const house = (item.houseNumber || '').trim();
        const street = (item.street || '').trim();
        const locality = (item.locality || item.subLocality || '').trim();
        const city = (item.city || item.district || '').trim();
        const state = (item.state || '').trim();
        const pincode = (item.pincode || '').trim();
        const eLoc = (item.eLoc || item.placeAddress || '').trim();

        return {
          house,
          street,
          area: locality || city,
          locality,
          city,
          district: (item.district || city).trim(),
          state,
          pincode,
          country: 'India',
          formattedAddress: item.placeAddress || item.placeName || '',
          placeName: item.placeName || '',
          latitude: typeof item.latitude === 'number' ? item.latitude : Number(item.latitude) || 0,
          longitude: typeof item.longitude === 'number' ? item.longitude : Number(item.longitude) || 0,
          eLoc,
          provider: 'mappls',
        };
      });
    }

    return null;
  } catch (err) {
    return null;
  }
}

/**
 * 4. Mappls Nearby Search API
 * Searches nearby categories, services, or landmarks around reference coordinates
 */
async function searchNearby(latitude, longitude, keywords = 'all', radiusMeters = 5000) {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (isNaN(lat) || isNaN(lng)) {
    throw new Error('Invalid coordinates for nearby search');
  }

  const token = await getAuthToken();
  if (!token) return null;

  try {
    const cleanKeywords = encodeURIComponent(keywords || 'services');
    const url = `https://atlas.mappls.com/api/places/nearby/json?keywords=${cleanKeywords}&refLocation=${lat},${lng}&radius=${radiusMeters}`;
    const headers = { Authorization: `Bearer ${token}` };
    let res = await requestJson(url, { headers }, null, 5000);

    if (res.status === 401) {
      invalidateToken();
      const advUrl = `https://apis.mappls.com/advancedmaps/v1/${token}/nearby?keywords=${cleanKeywords}&refLocation=${lat},${lng}&radius=${radiusMeters}`;
      res = await requestJson(advUrl, {}, null, 5000);
    }

    if (res.status === 200 && res.data && Array.isArray(res.data.suggestedLocations)) {
      return res.data.suggestedLocations.map((item) => ({
        placeName: item.placeName || '',
        placeAddress: item.placeAddress || '',
        latitude: Number(item.latitude) || 0,
        longitude: Number(item.longitude) || 0,
        distanceMeters: Number(item.distance) || null,
        eLoc: item.eLoc || '',
        provider: 'mappls',
      }));
    }

    return null;
  } catch (err) {
    return null;
  }
}

/**
 * 5. Mappls Distance Matrix & Routing Calculation
 * Computes driving road distance, estimated travel duration, and route polyline
 */
async function getRouteAndETA(originLat, originLng, destLat, destLng) {
  const oLat = Number(originLat);
  const oLng = Number(originLng);
  const dLat = Number(destLat);
  const dLng = Number(destLng);

  if (isNaN(oLat) || isNaN(oLng) || isNaN(dLat) || isNaN(dLng)) {
    throw new Error('Invalid origin or destination coordinates');
  }

  const token = await getAuthToken();
  if (!token) {
    return null;
  }

  try {
    const url = `https://apis.mappls.com/advancedmaps/v1/${token}/route_adv/driving/${oLng},${oLat};${dLng},${dLat}?geometries=polyline&overview=full`;
    const res = await requestJson(url, {}, null, 5000);

    if (res.status === 401) {
      invalidateToken();
      return null;
    }

    if (res.status === 200 && res.data && Array.isArray(res.data.routes) && res.data.routes.length > 0) {
      const bestRoute = res.data.routes[0];
      const distanceMeters = Math.round(bestRoute.distance || 0);
      const durationSeconds = Math.round(bestRoute.duration || 0);

      return {
        success: true,
        distanceMeters,
        distanceKm: Number((distanceMeters / 1000).toFixed(2)),
        durationSeconds,
        durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
        polylineGeometry: bestRoute.geometry || null,
        provider: 'mappls',
        origin: { latitude: oLat, longitude: oLng },
        destination: { latitude: dLat, longitude: dLng },
      };
    }

    return null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  getAuthToken,
  getApiKey: getAuthToken,
  isMapplsConfigured,
  reverseGeocode,
  geocode,
  searchPlaces,
  searchNearby,
  getRouteAndETA,
  invalidateToken,
};
