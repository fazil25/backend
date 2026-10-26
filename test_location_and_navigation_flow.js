const assert = require('assert');

const BASE_URL = 'http://127.0.0.1:4000';

async function post(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, data: text };
  }
}

async function get(url, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, data: text };
  }
}

async function patch(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, data: text };
  }
}

async function runTests() {
  console.log('--- STARTING LOCATION & REVERSE GEOCODING TEST SUITE ---');

  // 1. Test Reverse Geocode API
  console.log('[1] Testing Reverse Geocode API with Bellandur coordinates (12.9260, 77.6762)...');
  const revRes = await post(`${BASE_URL}/api/geo/reverse-geocode`, {
    latitude: 12.9260,
    longitude: 77.6762,
  });
  assert.strictEqual(revRes.status, 200, 'Reverse geocode status should be 200');
  assert.strictEqual(revRes.data.success, true, 'Reverse geocode should succeed');
  assert(revRes.data.formattedAddress, 'Should return formattedAddress');
  assert.strictEqual(revRes.data.latitude, 12.9260, 'Should preserve exact latitude');
  assert.strictEqual(revRes.data.longitude, 77.6762, 'Should preserve exact longitude');
  console.log('✓ Reverse geocoding result:', revRes.data.formattedAddress, `(Area: ${revRes.data.area}, City: ${revRes.data.city}, PIN: ${revRes.data.pincode})`);

  // 2. Test Search Places API
  console.log('[2] Testing Places Search API with query "Indiranagar"...');
  const searchRes = await post(`${BASE_URL}/api/geo/search-places`, { query: 'Indiranagar' });
  assert.strictEqual(searchRes.status, 200, 'Search places status should be 200');
  assert(Array.isArray(searchRes.data.results), 'Should return results array');
  assert(searchRes.data.results.length > 0, 'Should find matching places');
  console.log('✓ Found places:', searchRes.data.results.length, 'Top result:', searchRes.data.results[0].formattedAddress);

  // 3. Login as Customer
  console.log('[3] Logging in as Customer...');
  const custLogin = await post(`${BASE_URL}/api/auth/login`, {
    identifier: 'customer@homestep.in',
    password: 'password123',
  });
  assert.strictEqual(custLogin.status, 200, 'Customer login should succeed');
  const custToken = custLogin.data.token;
  console.log('✓ Logged in as:', custLogin.data.user.name);

  // 4. Create Booking with Exact Structured Location
  console.log('[4] Creating Booking with Structured GPS Location (HSR Layout: 12.9121, 77.6446)...');
  const structuredLocation = {
    address: 'Flat 402, Lotus Orchid Apartments, 14th Main, HSR Layout Sector 1, Bengaluru, Karnataka - 560102',
    house: 'Flat 402, Lotus Orchid Apartments',
    street: '14th Main',
    area: 'HSR Layout',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560102',
    latitude: 12.9121,
    longitude: 77.6446,
  };

  const bookingRes = await post(
    `${BASE_URL}/api/customer/bookings`,
    {
      service: 'AC Service & Repair',
      category: 'AC & Climate',
      quantity: 1,
      date: 'Today',
      time: '04:00 PM',
      location: structuredLocation,
      latitude: 12.9121,
      longitude: 77.6446,
      paymentMethod: 'Cash on Service',
    },
    custToken
  );

  assert.strictEqual(bookingRes.status, 200, 'Booking creation should succeed');
  const createdBooking = bookingRes.data.booking;
  assert(createdBooking.id, 'Booking should have an ID');
  assert.strictEqual(createdBooking.latitude, 12.9121, 'Booking latitude must match customer GPS');
  assert.strictEqual(createdBooking.longitude, 77.6446, 'Booking longitude must match customer GPS');
  assert(createdBooking.location, 'Booking must store structured location');
  assert.strictEqual(createdBooking.location.pincode, '560102', 'Structured location pincode must match');
  console.log('✓ Booking created successfully:', createdBooking.id, 'Coordinates:', createdBooking.latitude, createdBooking.longitude);

  // 5. Test Pre-Confirmation Location Update
  console.log('[5] Testing Pre-Confirmation Address Update to Koramangala (12.9345, 77.6265)...');
  const updatedLocation = {
    address: 'Plot 88, 5th Block, Koramangala, Bengaluru, Karnataka - 560034',
    house: 'Plot 88',
    street: '5th Block',
    area: 'Koramangala',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560034',
    latitude: 12.9345,
    longitude: 77.6265,
  };

  const updateRes = await patch(
    `${BASE_URL}/api/customer/bookings/${createdBooking.id}/address`,
    {
      location: updatedLocation,
    },
    custToken
  );
  assert.strictEqual(updateRes.status, 200, 'Address update should succeed');
  assert.strictEqual(updateRes.data.booking.latitude, 12.9345, 'Updated latitude must be reflected');
  assert.strictEqual(updateRes.data.booking.longitude, 77.6265, 'Updated longitude must be reflected');
  console.log('✓ Address updated before assignment to:', updateRes.data.booking.location.address);

  // 6. Login as Worker & Verify Destination Coordinates
  console.log('[6] Logging in as Worker (worker@homestep.in)...');
  const workerLogin = await post(`${BASE_URL}/api/auth/login`, {
    identifier: 'worker@homestep.in',
    password: 'password123',
  });
  assert.strictEqual(workerLogin.status, 200, 'Worker login should succeed');
  const workerToken = workerLogin.data.token;

  console.log('[7] Worker accepts the job...');
  const acceptRes = await post(
    `${BASE_URL}/api/worker/jobs/${createdBooking.id}/accept`,
    {},
    workerToken
  );
  assert.strictEqual(acceptRes.status, 200, 'Job accept should succeed');
  const assignedJob = acceptRes.data.job;
  assert.strictEqual(assignedJob.latitude, 12.9345, 'Worker job latitude must match confirmed booking latitude');
  assert.strictEqual(assignedJob.longitude, 77.6265, 'Worker job longitude must match confirmed booking longitude');
  assert.strictEqual(assignedJob.destination.latitude, 12.9345, 'Worker job destination latitude must match booking');
  assert.strictEqual(assignedJob.destination.longitude, 77.6265, 'Worker job destination longitude must match booking');
  console.log('✓ Assigned Job verified with exact customer GPS coordinates:', assignedJob.destination);

  console.log('--- ALL LOCATION AND NAVIGATION TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch((err) => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
