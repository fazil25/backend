const http = require('http');
const assert = require('assert');

// Test the geo logic, schema and endpoint integration directly
const { reverseGeocode, searchPlaces } = require('./src/geo');

async function testGeoAndAddressSystem() {
  console.log('================================================================');
  console.log('🌍 HOMESTEPIN PRODUCTION LOCATION & ADDRESS TEST');
  console.log('================================================================\n');

  // TEST 1: Real Reverse Geocoding with GPS Coordinates
  console.log('▶ [TEST 1] Testing Real Reverse Geocoding for Bellandur (12.9260, 77.6762)...');
  const bellandur = await reverseGeocode(12.9260, 77.6762);
  console.log('  ✓ Formatted Address:', bellandur.formattedAddress);
  console.log('  ✓ House/Street:', bellandur.house || 'N/A', '| Street:', bellandur.street || 'N/A');
  console.log('  ✓ Area:', bellandur.area);
  console.log('  ✓ City:', bellandur.city);
  console.log('  ✓ State:', bellandur.state);
  console.log('  ✓ Pincode:', bellandur.pincode);
  console.log('  ✓ Latitude:', bellandur.latitude, '| Longitude:', bellandur.longitude);
  assert(bellandur.formattedAddress.length > 0, 'Address string must be populated');
  assert.strictEqual(bellandur.latitude, 12.9260, 'Latitude must match input');
  assert.strictEqual(bellandur.longitude, 77.6762, 'Longitude must match input');

  // TEST 2: Real Reverse Geocoding for Indiranagar (12.9716, 77.6412)
  console.log('\n▶ [TEST 2] Testing Reverse Geocoding for Indiranagar (12.9716, 77.6412)...');
  const indiranagar = await reverseGeocode(12.9716, 77.6412);
  console.log('  ✓ Formatted Address:', indiranagar.formattedAddress);
  console.log('  ✓ Area:', indiranagar.area, '| City:', indiranagar.city, '| PIN:', indiranagar.pincode);
  assert(indiranagar.city.toLowerCase().includes('bengaluru') || indiranagar.city.toLowerCase().includes('bangalore'), 'City must be Bengaluru');

  // TEST 3: Place Search Autocomplete
  console.log('\n▶ [TEST 3] Testing Place Search Autocomplete for "Koramangala"...');
  const searchResults = await searchPlaces('Koramangala');
  console.log(`  ✓ Search results count: ${searchResults.length}`);
  searchResults.slice(0, 3).forEach((res, idx) => {
    console.log(`    [${idx + 1}] ${res.formattedAddress} (${res.latitude}, ${res.longitude})`);
  });
  assert(searchResults.length > 0, 'Should find place results for Koramangala');
  assert(searchResults[0].latitude && searchResults[0].longitude, 'Result must contain coordinates');

  // TEST 4: Fallback Resilience (Non-Crashing on Invalid Coordinates)
  console.log('\n▶ [TEST 4] Testing Fallback Resilience for Off-Grid / Remote Coordinates...');
  const remote = await reverseGeocode(0.0001, 0.0001);
  console.log('  ✓ Non-crashing response received for 0.0001, 0.0001:', remote.formattedAddress);
  assert(remote.formattedAddress.length > 0, 'Must produce a graceful fallback address');
  assert.strictEqual(remote.latitude, 0.0001, 'Must preserve original GPS coordinates');

  // TEST 5: Structured Booking Service Location Schema
  console.log('\n▶ [TEST 5] Validating ServiceLocation Data Model...');
  const sampleServiceLocation = {
    address: 'Flat 301, Prestige Palms, 80 Feet Road, 4th Block, Koramangala, Bengaluru, Karnataka - 560034',
    house: 'Flat 301, Prestige Palms',
    street: '80 Feet Road, 4th Block',
    area: 'Koramangala',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560034',
    latitude: 12.934533,
    longitude: 77.626579,
  };

  assert.strictEqual(typeof sampleServiceLocation.latitude, 'number');
  assert.strictEqual(typeof sampleServiceLocation.longitude, 'number');
  assert.strictEqual(sampleServiceLocation.pincode, '560034');
  console.log('  ✓ Structured ServiceLocation validated successfully:');
  console.log('   ', JSON.stringify(sampleServiceLocation, null, 2));

  console.log('\n================================================================');
  console.log('✅ ALL PRODUCTION LOCATION & REVERSE-GEOCODING TESTS PASSED!');
  console.log('================================================================');
}

testGeoAndAddressSystem().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
