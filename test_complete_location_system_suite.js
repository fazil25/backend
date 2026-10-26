const http = require('http');

const BASE_URL = process.env.API_URL || 'http://127.0.0.1:4000';

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: reqHeaders,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runComprehensiveLocationSuite() {
  console.log('================================================================');
  console.log('🌍 COMPLETE HOMESTEPIN LOCATION SYSTEM SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // 1. PLACE SEARCH TESTS (REST /api/location/search and /api/geo/search-places)
  console.log('--- TEST 1: Place Search for Specific Indian Localities ---');

  const searchQueries = [
    { q: 'Trichy', expectSub: 'tiruchirappalli' },
    { q: 'Trichy TVS Tolgate', expectSub: 'tvs tollgate' },
    { q: 'Khaja Nagar', expectSub: 'khaja nagar' },
    { q: 'Ariyalur', expectSub: 'ariyalur' },
    { q: 'Chennai Central', expectSub: 'chennai' },
    { q: '620020', expectSub: '620020' },
  ];

  for (const item of searchQueries) {
    console.log(`Searching for "${item.q}"...`);
    const res = await makeRequest('GET', `/api/location/search?q=${encodeURIComponent(item.q)}`);
    assert(res.status === 200, `GET /api/location/search status is 200 for ${item.q}`);
    const results = res.data.results || [];
    assert(results.length > 0, `Returned ${results.length} results for ${item.q}`);
    if (results.length > 0) {
      const first = results[0];
      console.log(`    Result 0: "${first.formattedAddress}" [${first.latitude}, ${first.longitude}]`);
      assert(
        typeof first.latitude === 'number' && typeof first.longitude === 'number',
        `Coordinates are valid numbers: ${first.latitude}, ${first.longitude}`
      );
      assert(
        first.latitude !== 0 && first.longitude !== 0,
        `Coordinates are non-zero`
      );
    }
  }

  // 2. REVERSE GEOCODING TESTS
  console.log('\n--- TEST 2: Reverse Geocoding with Exact Coordinates ---');

  const revQueries = [
    { name: 'Trichy TVS Tolgate', lat: 10.7938, lng: 78.6922, expectInCityOrAddress: 'tiruchirappalli' },
    { name: 'Khaja Nagar', lat: 10.7905, lng: 78.6984, expectInCityOrAddress: 'tiruchirappalli' },
    { name: 'Ariyalur', lat: 11.1401, lng: 79.0786, expectInCityOrAddress: 'ariyalur' },
  ];

  for (const item of revQueries) {
    console.log(`Reverse geocoding ${item.name} (${item.lat}, ${item.lng})...`);
    const res = await makeRequest('GET', `/api/location/reverse-geocode?lat=${item.lat}&lng=${item.lng}`);
    assert(res.status === 200, `Reverse geocode status is 200 for ${item.name}`);
    const loc = res.data.location || res.data;
    assert(loc.formattedAddress && loc.formattedAddress.length > 0, `Has formattedAddress: ${loc.formattedAddress}`);
    assert(
      !loc.formattedAddress.toLowerCase().includes('indiranagar') &&
      !loc.formattedAddress.toLowerCase().includes('560038'),
      `No fake Indiranagar / Bengaluru fallback contamination`
    );
  }

  // 3. ADDRESS VALIDATION
  console.log('\n--- TEST 3: Address Validation Endpoint ---');
  const validRes = await makeRequest('POST', '/api/location/validate', {
    pincode: '620020',
    phone: '9842412345',
    latitude: 10.7938,
    longitude: 78.6922,
    houseNumber: '12B',
    street: 'Anna Salai',
    area: 'TVS Tolgate',
    city: 'Trichy',
    state: 'Tamil Nadu'
  });
  assert(validRes.status === 200, 'POST /api/location/validate is 200');
  assert(validRes.data.valid === true, 'Address is valid');

  const invalidRes = await makeRequest('POST', '/api/location/validate', {
    pincode: '000000',
    phone: '12345',
    latitude: 'invalid',
    longitude: 78.6922,
  });
  assert(
    invalidRes.status === 400 || (invalidRes.status === 200 && invalidRes.data.valid === false),
    'Invalid address/coordinates are caught by validation endpoint'
  );

  // 4. AUTH & ADDRESS CRUD TESTS (WITH USER ISOLATION)
  console.log('\n--- TEST 4: Customer Authentication & Address CRUD & Isolation ---');

  // Register Customer A
  const custAPhone = `9840${Math.floor(100000 + Math.random() * 900000)}`;
  const regARes = await makeRequest('POST', '/api/auth/register-customer', {
    name: 'Vinothan Customer A',
    phone: custAPhone,
    email: `vinothan_${Date.now()}@example.com`,
    password: 'Password@123',
    confirmPassword: 'Password@123',
  });
  assert(regARes.status === 200 || regARes.status === 201, 'Customer A registration status 200/201');
  const tokenA = regARes.data.token;
  const userA = regARes.data.user;
  assert(tokenA && tokenA.length > 0, 'Customer A JWT token received');

  // Register Customer B (for isolation test)
  const custBPhone = `9841${Math.floor(100000 + Math.random() * 900000)}`;
  const regBRes = await makeRequest('POST', '/api/auth/register-customer', {
    name: 'Suresh Customer B',
    phone: custBPhone,
    email: `suresh_${Date.now()}@example.com`,
    password: 'Password@123',
    confirmPassword: 'Password@123',
  });
  const tokenB = regBRes.data.token;
  assert(tokenB && tokenB.length > 0, 'Customer B JWT token received');

  // Customer A adds Address 1 (Home)
  console.log('Customer A creates Address 1 (Home in Trichy)...');
  const addr1Payload = {
    label: 'Home',
    recipientName: 'Vinothan',
    phone: custAPhone,
    houseNumber: '14-A',
    building: 'Jar Complex',
    street: 'Hanifa Colony',
    landmark: 'Near Mosque',
    area: 'Khaja Nagar',
    city: 'Tiruchirappalli',
    state: 'Tamil Nadu',
    pincode: '620020',
    country: 'India',
    latitude: 10.7905,
    longitude: 78.6984,
    formattedAddress: '14-A, Jar Complex, Hanifa Colony, Khaja Nagar, Tiruchirappalli, Tamil Nadu 620020',
    isDefault: true,
  };

  const addRes1 = await makeRequest('POST', '/api/addresses', addr1Payload, {
    Authorization: `Bearer ${tokenA}`,
  });
  assert(addRes1.status === 201 || addRes1.status === 200, 'Customer A added address 1');
  const addr1 = addRes1.data.address;
  assert(addr1 && addr1.id, `Created address ID: ${addr1?.id}`);
  assert(addr1.isDefault === true, 'Address 1 is marked as default');
  assert(addr1.latitude === 10.7905 && addr1.longitude === 78.6984, 'Exact coordinates preserved');

  // Customer A adds Address 2 (Work)
  console.log('Customer A creates Address 2 (Work in Thillai Nagar)...');
  const addr2Payload = {
    label: 'Work',
    recipientName: 'Vinothan Office',
    phone: custAPhone,
    houseNumber: 'Plot 45',
    building: 'Tech Tower',
    street: '10th Cross East',
    landmark: 'Opp SBI',
    area: 'Thillai Nagar',
    city: 'Tiruchirappalli',
    state: 'Tamil Nadu',
    pincode: '620018',
    country: 'India',
    latitude: 10.8285,
    longitude: 78.6854,
    formattedAddress: 'Plot 45, Tech Tower, 10th Cross East, Thillai Nagar, Tiruchirappalli, Tamil Nadu 620018',
    isDefault: false,
  };

  const addRes2 = await makeRequest('POST', '/api/addresses', addr2Payload, {
    Authorization: `Bearer ${tokenA}`,
  });
  assert(addRes2.status === 201 || addRes2.status === 200, 'Customer A added address 2');
  const addr2 = addRes2.data.address;

  // Customer A lists addresses
  const listARes = await makeRequest('GET', '/api/addresses', null, {
    Authorization: `Bearer ${tokenA}`,
  });
  assert(listARes.status === 200, 'GET /api/addresses for Customer A is 200');
  assert(listARes.data.addresses.length === 2, `Customer A has exactly 2 addresses (found: ${listARes.data.addresses.length})`);

  // Customer B lists addresses (MUST BE 0 - ISOLATION VERIFICATION)
  const listBRes = await makeRequest('GET', '/api/addresses', null, {
    Authorization: `Bearer ${tokenB}`,
  });
  assert(listBRes.status === 200, 'GET /api/addresses for Customer B is 200');
  assert(listBRes.data.addresses.length === 0, `Customer B has ZERO addresses (DATA ISOLATION CONFIRMED: ${listBRes.data.addresses.length})`);

  // Customer B attempts to view, edit, or delete Customer A's address (MUST FAIL 403 or 404)
  console.log("Customer B attempts to access Customer A's address...");
  const unauthorizedGet = await makeRequest('GET', `/api/addresses/${addr1.id}`, null, {
    Authorization: `Bearer ${tokenB}`,
  });
  assert(
    unauthorizedGet.status === 403 || unauthorizedGet.status === 404,
    `Customer B blocked from GET customer A's address (Status: ${unauthorizedGet.status})`
  );

  const unauthorizedDel = await makeRequest('DELETE', `/api/addresses/${addr1.id}`, null, {
    Authorization: `Bearer ${tokenB}`,
  });
  assert(
    unauthorizedDel.status === 403 || unauthorizedDel.status === 404,
    `Customer B blocked from DELETE customer A's address (Status: ${unauthorizedDel.status})`
  );

  // Set Address 2 as Default
  console.log('Customer A sets Address 2 as default...');
  const setDefaultRes = await makeRequest('PATCH', `/api/addresses/${addr2.id}/default`, {}, {
    Authorization: `Bearer ${tokenA}`,
  });
  assert(setDefaultRes.status === 200, 'Set default address status is 200');

  const checkDefaultList = await makeRequest('GET', '/api/addresses', null, {
    Authorization: `Bearer ${tokenA}`,
  });
  const updatedAddr1 = checkDefaultList.data.addresses.find(a => a.id === addr1.id);
  const updatedAddr2 = checkDefaultList.data.addresses.find(a => a.id === addr2.id);
  assert(updatedAddr2.isDefault === true, 'Address 2 is now default');
  assert(updatedAddr1.isDefault === false, 'Address 1 is atomically unset from default');

  // 5. BOOKING CREATION WITH IMMUTABLE SERVICE ADDRESS SNAPSHOT
  console.log('\n--- TEST 5: Booking Creation with Immutable Service Address Snapshot ---');

  const bookingPayload = {
    service: 'Deep Cleaning Service',
    category: 'Cleaning',
    quantity: 1,
    date: new Date().toISOString().split('T')[0],
    time: '10:00 AM - 12:00 PM',
    slot: '10:00 AM - 12:00 PM',
    address: updatedAddr2.formattedAddress || updatedAddr2.address,
    addressDetails: updatedAddr2,
    location: {
      address: updatedAddr2.formattedAddress || updatedAddr2.address,
      houseNumber: updatedAddr2.houseNumber || updatedAddr2.house,
      street: updatedAddr2.street || updatedAddr2.line1,
      area: updatedAddr2.area,
      city: updatedAddr2.city,
      state: updatedAddr2.state,
      pincode: updatedAddr2.pincode,
      latitude: updatedAddr2.latitude,
      longitude: updatedAddr2.longitude,
      addressId: updatedAddr2.id,
    },
    latitude: updatedAddr2.latitude,
    longitude: updatedAddr2.longitude,
    paymentMethod: 'Cash on Service',
  };

  const createBookingRes = await makeRequest('POST', '/api/bookings', bookingPayload, {
    Authorization: `Bearer ${tokenA}`,
  });

  assert(createBookingRes.status === 200 || createBookingRes.status === 201, 'Booking created successfully');
  const booking = createBookingRes.data.booking;
  assert(booking && booking.id, `Booking ID: ${booking?.id}`);
  assert(
    booking.serviceAddress && typeof booking.serviceAddress === 'object',
    'Booking contains serviceAddress object'
  );
  assert(
    booking.serviceAddress.latitude === 10.8285 && booking.serviceAddress.longitude === 78.6854,
    `Booking serviceAddress has exact coordinates (${booking.serviceAddress.latitude}, ${booking.serviceAddress.longitude})`
  );
  assert(
    booking.latitude === 10.8285 && booking.longitude === 78.6854,
    `Booking root has exact coordinates (${booking.latitude}, ${booking.longitude})`
  );

  // Update Customer A's address, and verify Booking's snapshot does NOT get mutated
  console.log('Verifying snapshot immutability after updating address in address book...');
  const editAddrRes = await makeRequest('PUT', `/api/addresses/${addr2.id}`, {
    ...addr2Payload,
    houseNumber: 'MODIFIED 999',
    formattedAddress: 'MODIFIED 999, Tech Tower, 10th Cross East, Thillai Nagar, Tiruchirappalli',
  }, {
    Authorization: `Bearer ${tokenA}`,
  });
  assert(editAddrRes.status === 200, 'Address 2 updated in address book');

  const getBookingAgain = await makeRequest('GET', `/api/bookings/${booking.id}`, null, {
    Authorization: `Bearer ${tokenA}`,
  });
  const reloadedBooking = getBookingAgain.data.booking || getBookingAgain.data;
  assert(
    reloadedBooking.serviceAddress.houseNumber === 'Plot 45',
    `Booking snapshot remained immutable: houseNumber is still "${reloadedBooking.serviceAddress.houseNumber}"`
  );

  // Clean up: delete Address 1
  console.log('Customer A deletes Address 1...');
  const deleteRes = await makeRequest('DELETE', `/api/addresses/${addr1.id}`, null, {
    Authorization: `Bearer ${tokenA}`,
  });
  assert(deleteRes.status === 200, 'DELETE /api/addresses/:id returned 200');

  const finalList = await makeRequest('GET', '/api/addresses', null, {
    Authorization: `Bearer ${tokenA}`,
  });
  assert(finalList.data.addresses.length === 1, `Customer A now has 1 address remaining (deleted 1)`);

  console.log('\n================================================================');
  console.log(`🎉 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runComprehensiveLocationSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
