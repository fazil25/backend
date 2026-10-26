const assert = require('assert');
const {
  reverseGeocode,
  geocodeAddress,
  searchPlaces,
  searchNearby,
  calculateRouteAndETA,
  haversineMeters,
  KNOWN_LANDMARKS,
} = require('./src/geo');
const mapplsService = require('./src/services/mapplsService');
const Address = require('./src/models/Address');
const mongoose = require('mongoose');

async function runMapplsIntegrationTests() {
  console.log('================================================================');
  console.log('🗺️  STARTING MAPPLS (MAPMYINDIA) API-KEY AUTHENTICATION TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function recordPass(testName) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  }

  function recordFail(testName, error) {
    console.error(`  ✗ FAIL: ${testName}`);
    console.error(`    Error: ${error.message || error}`);
    failed++;
  }

  // --- TEST 1: Mappls Service API Key Interface ---
  console.log('1. Testing Mappls API Key Interface & Graceful Fallback...');
  try {
    assert.strictEqual(typeof mapplsService.getApiKey, 'function', 'getApiKey is defined');
    assert.strictEqual(typeof mapplsService.isMapplsConfigured, 'function', 'isMapplsConfigured is defined');
    assert.strictEqual(typeof mapplsService.reverseGeocode, 'function', 'reverseGeocode is defined');
    assert.strictEqual(typeof mapplsService.geocode, 'function', 'geocode is defined');
    assert.strictEqual(typeof mapplsService.searchPlaces, 'function', 'searchPlaces is defined');
    assert.strictEqual(typeof mapplsService.searchNearby, 'function', 'searchNearby is defined');
    assert.strictEqual(typeof mapplsService.getRouteAndETA, 'function', 'getRouteAndETA is defined');

    const token = await mapplsService.getAuthToken();
    assert.ok(token === null || (typeof token === 'string' && token.length > 0), 'getAuthToken resolves cleanly');
    recordPass(`Mappls authentication interface verified (token active: ${Boolean(token)})`);
  } catch (err) {
    recordFail('Mappls API key interface', err);
  }

  // --- TEST 2: Reverse Geocoding for Indian Coordinates ---
  console.log('\n2. Testing Reverse Geocoding API for Indian Locations...');
  try {
    // Trichy TVS Tollgate Coordinates
    const trichyGeo = await reverseGeocode(10.7938, 78.6922);
    assert.ok(trichyGeo, 'Reverse geocode result is defined');
    assert.ok(trichyGeo.city || trichyGeo.area, 'City or area is resolved');
    assert.strictEqual(typeof trichyGeo.formattedAddress, 'string', 'Formatted address is a string');
    assert.ok(trichyGeo.formattedAddress.length > 5, 'Formatted address is non-empty');
    assert.strictEqual(trichyGeo.latitude, 10.7938, 'Latitude preserved');
    assert.strictEqual(trichyGeo.longitude, 78.6922, 'Longitude preserved');
    recordPass(`Trichy coordinates resolved: "${trichyGeo.formattedAddress}" (provider: ${trichyGeo.provider})`);

    // Bangalore Coordinates
    const blrGeo = await reverseGeocode(12.9784, 77.6408);
    assert.ok(blrGeo, 'Bangalore reverse geocode result is defined');
    assert.ok(blrGeo.city || blrGeo.area, 'Bangalore city/area resolved');
    recordPass(`Bengaluru coordinates resolved: "${blrGeo.formattedAddress}" (provider: ${blrGeo.provider})`);
  } catch (err) {
    recordFail('Reverse geocoding', err);
  }

  // --- TEST 3: Coordinate Validation ---
  console.log('\n3. Testing Geocode Input Validation...');
  try {
    let threw = false;
    try {
      await reverseGeocode('invalid', 78.6922);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'Throws on non-numeric latitude');

    threw = false;
    try {
      await reverseGeocode(95.0, 78.6922);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'Throws on latitude > 90');
    recordPass('Invalid coordinates rejected safely');
  } catch (err) {
    recordFail('Coordinate validation', err);
  }

  // --- TEST 4: AutoSuggest & Text Search ---
  console.log('\n4. Testing AutoSuggest & Text Search API...');
  try {
    const searchRes = await searchPlaces('Tollgate Trichy');
    assert.ok(Array.isArray(searchRes), 'Search result is an array');
    assert.ok(searchRes.length > 0, 'Found matching results for Tollgate Trichy');
    assert.ok(searchRes[0].formattedAddress, 'Result has formatted address');
    assert.strictEqual(typeof searchRes[0].latitude, 'number', 'Result has latitude');
    assert.strictEqual(typeof searchRes[0].longitude, 'number', 'Result has longitude');
    recordPass(`Found ${searchRes.length} results for "Tollgate Trichy": "${searchRes[0].formattedAddress}"`);

    const shortQuery = await searchPlaces('a');
    assert.deepStrictEqual(shortQuery, [], 'Short query (<2 chars) returns empty array without error');
    recordPass('Short query debounce/filter');
  } catch (err) {
    recordFail('Place search', err);
  }

  // --- TEST 5: Nearby Search API ---
  console.log('\n5. Testing Nearby Search API...');
  try {
    const nearby = await searchNearby(10.7938, 78.6922, 'all', 3000);
    assert.ok(Array.isArray(nearby), 'Nearby result is an array');
    assert.ok(nearby.length > 0, 'Found nearby landmarks/providers');
    assert.ok(nearby[0].placeName, 'Nearby item has name');
    recordPass(`Found ${nearby.length} nearby locations around TVS Tollgate: "${nearby[0].placeName}"`);
  } catch (err) {
    recordFail('Nearby search', err);
  }

  // --- TEST 6: Forward Geocoding ---
  console.log('\n6. Testing Forward Geocoding API...');
  try {
    const geo = await geocodeAddress('TVS Tollgate Trichy');
    assert.ok(geo, 'Geocode result is defined');
    assert.strictEqual(typeof geo.latitude, 'number', 'Latitude is a number');
    assert.strictEqual(typeof geo.longitude, 'number', 'Longitude is a number');
    recordPass(`Address geocoded: "${geo.formattedAddress || 'TVS Tollgate'}" -> (${geo.latitude}, ${geo.longitude})`);
  } catch (err) {
    recordFail('Forward geocoding', err);
  }

  // --- TEST 7: Route Distance and ETA Calculation ---
  console.log('\n7. Testing Route Distance and ETA Calculation...');
  try {
    const route = await calculateRouteAndETA(10.7938, 78.6922, 10.8312, 78.6970);
    assert.ok(route, 'Route result defined');
    assert.strictEqual(route.success, true, 'Route calculation success');
    assert.ok(route.distanceKm > 3 && route.distanceKm < 10, `Distance realistic: ${route.distanceKm} km`);
    assert.ok(route.durationMinutes >= 5, `Duration realistic: ${route.durationMinutes} min`);
    recordPass(`Route computed: ${route.distanceKm} km, ~${route.durationMinutes} min ETA (provider: ${route.provider})`);
  } catch (err) {
    recordFail('Route and ETA calculation', err);
  }

  // --- TEST 8: Address Model Schema Verification ---
  console.log('\n8. Testing Address Model Schema & 2dsphere indexing...');
  try {
    const testDoc = new Address({
      user: new mongoose.Types.ObjectId(),
      label: 'Home',
      line1: '12, Anna Salai',
      house: '12',
      area: 'TVS Tollgate',
      city: 'Tiruchirappalli',
      state: 'Tamil Nadu',
      pincode: '620020',
      latitude: 10.7938,
      longitude: 78.6922,
      location: {
        type: 'Point',
        coordinates: [78.6922, 10.7938],
      },
      source: 'MAP_PIN',
    });

    const validationErr = testDoc.validateSync();
    assert.strictEqual(validationErr, undefined, 'Address document validates successfully');
    assert.strictEqual(testDoc.location.coordinates[0], 78.6922, 'GeoJSON longitude in [0]');
    assert.strictEqual(testDoc.location.coordinates[1], 10.7938, 'GeoJSON latitude in [1]');
    recordPass('Address model validation and GeoJSON Point coordinates schema');
  } catch (err) {
    recordFail('Address model schema', err);
  }

  console.log('\n================================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runMapplsIntegrationTests().catch((err) => {
  console.error('Fatal error during test suite execution:', err);
  process.exit(1);
});
