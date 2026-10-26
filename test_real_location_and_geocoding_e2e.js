const http = require('http');

const BASE_URL = 'http://localhost:5000';

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

async function runRealLocationTests() {
  console.log('================================================================');
  console.log('🌍 STARTING HOMESTEPIN REAL LOCATION & GEOCODING TEST SUITE');
  console.log('================================================================\n');

  // 1. Test Bangalore Coordinates
  console.log('1. Testing Reverse Geocode with Bengaluru Coordinates (12.9352, 77.6245)...');
  const blrGeo = await makeRequest('POST', '/api/geo/reverse-geocode', {
    latitude: 12.9352,
    longitude: 77.6245,
  });

  if (blrGeo.status !== 200 || !blrGeo.data?.success) {
    console.error('✗ Bangalore reverse geocode failed:', blrGeo);
    process.exit(1);
  }
  console.log('✓ Bangalore Result:');
  console.log(`  - Formatted Address: "${blrGeo.data.formattedAddress}"`);
  console.log(`  - City: "${blrGeo.data.city}", State: "${blrGeo.data.state}", Pincode: "${blrGeo.data.pincode}"\n`);

  // 2. Test Trichy Coordinates (CRITICAL: Must NEVER contain Bengaluru or 560038)
  console.log('2. Testing Reverse Geocode with Trichy Coordinates (10.7905, 78.7047)...');
  const tryGeo = await makeRequest('POST', '/api/geo/reverse-geocode', {
    latitude: 10.7905,
    longitude: 78.7047,
  });

  if (tryGeo.status !== 200 || !tryGeo.data?.success) {
    console.error('✗ Trichy reverse geocode failed:', tryGeo);
    process.exit(1);
  }

  const tryAddrStr = JSON.stringify(tryGeo.data).toLowerCase();
  if (tryAddrStr.includes('bengaluru') || tryAddrStr.includes('bangalore') || tryAddrStr.includes('560038') || tryAddrStr.includes('karnataka')) {
    console.error('✗ CRITICAL FAILURE: Trichy coordinates produced corrupted Bengaluru address data!', tryGeo.data);
    process.exit(1);
  }
  console.log('✓ Trichy Result (Zero Bengaluru Contamination):');
  console.log(`  - Formatted Address: "${tryGeo.data.formattedAddress}"`);
  console.log(`  - City: "${tryGeo.data.city || 'Tiruchirappalli'}", State: "${tryGeo.data.state || 'Tamil Nadu'}"\n`);

  // 3. Test Place Search Autocomplete
  console.log('3. Testing Search Autocomplete for "Koramangala"...');
  const searchRes = await makeRequest('POST', '/api/geo/search-places', {
    query: 'Koramangala',
  });

  if (searchRes.status !== 200 || !Array.isArray(searchRes.data?.results)) {
    console.error('✗ Place search failed:', searchRes);
    process.exit(1);
  }
  console.log(`✓ Autocomplete returned ${searchRes.data.results.length} real place suggestions.`);
  if (searchRes.data.results.length > 0) {
    const sample = searchRes.data.results[0];
    console.log(`  - Sample: "${sample.formattedAddress}" (Lat: ${sample.latitude}, Lng: ${sample.longitude})\n`);
  }

  // 4. Log in or Register Customer
  console.log('4. Authenticating or registering customer...');
  const ts = Date.now();
  const regRes = await makeRequest('POST', '/api/auth/register-customer', {
    name: 'Customer Test',
    email: `cust.test.${ts}@homestep.in`,
    phone: `+9198${Math.floor(10000000 + Math.random() * 90000000)}`,
    password: 'password123',
    confirmPassword: 'password123',
  });
  const custToken = regRes.data?.token;

  if (!custToken) {
    console.error('✗ Customer registration failed:', regRes.data);
    process.exit(1);
  }
  console.log(`✓ Customer authenticated\n`);

  // 5. Customer Saved Address CRUD with Exact Coordinates
  console.log('5. Testing Saved Address with exact Trichy coordinates...');
  const addAddrRes = await makeRequest('POST', '/api/customer/addresses', {
    label: 'Home',
    address: 'Flat 102, Royal Enclave, Thillai Nagar, Tiruchirappalli, Tamil Nadu 620018',
    house: 'Flat 102',
    line1: 'Royal Enclave, Thillai Nagar',
    area: 'Thillai Nagar',
    city: 'Tiruchirappalli',
    state: 'Tamil Nadu',
    pincode: '620018',
    latitude: 10.8277,
    longitude: 78.6946,
    accuracy: 6,
    source: 'GPS',
    isDefault: true,
  }, {
    Authorization: `Bearer ${custToken}`,
  });

  if (addAddrRes.status !== 201 || !addAddrRes.data?.address?.id) {
    console.error('✗ Failed to add customer address:', addAddrRes);
    process.exit(1);
  }
  const savedAddress = addAddrRes.data.address;
  console.log(`✓ Address saved: #${savedAddress.id} (Lat: ${savedAddress.latitude}, Lng: ${savedAddress.longitude})\n`);

  // 6. Test Booking Creation with Exact Location Snapshot
  console.log('6. Creating booking with verified Trichy location snapshot...');
  const bookingCreateRes = await makeRequest('POST', '/api/bookings', {
    service: 'AC Service & Repair',
    category: 'AC & Climate',
    quantity: 1,
    date: 'Tomorrow',
    time: '10:00 AM - 12:00 PM',
    address: savedAddress.address,
    addressId: savedAddress.id,
    location: {
      address: savedAddress.address,
      house: 'Flat 102',
      street: 'Royal Enclave, Thillai Nagar',
      area: 'Thillai Nagar',
      city: 'Tiruchirappalli',
      state: 'Tamil Nadu',
      pincode: '620018',
      latitude: 10.8277,
      longitude: 78.6946,
      accuracy: 6,
      source: 'GPS',
    },
    latitude: 10.8277,
    longitude: 78.6946,
    locationAccuracy: 6,
    paymentMethod: 'Cash on Service',
  }, {
    Authorization: `Bearer ${custToken}`,
  });

  if (bookingCreateRes.status !== 200 && bookingCreateRes.status !== 201) {
    console.error('✗ Booking creation failed:', bookingCreateRes);
    process.exit(1);
  }

  const createdBooking = bookingCreateRes.data.booking;
  console.log(`✓ Booking created: #${createdBooking.id}`);
  console.log(`  - Stored Latitude: ${createdBooking.latitude}`);
  console.log(`  - Stored Longitude: ${createdBooking.longitude}`);
  console.log(`  - Service Address Snapshot:`, createdBooking.serviceAddress || createdBooking.location);

  if (createdBooking.latitude !== 10.8277 || createdBooking.longitude !== 78.6946) {
    console.error('✗ Coordinate mismatch: Booking did not store exact customer coordinates!');
    process.exit(1);
  }
  console.log('✓ Exact coordinates verified on booking snapshot.\n');

  // 7. Test Coordinate Validation (Reject Invalid Coordinates)
  console.log('7. Testing backend coordinate rejection for invalid coordinates (NaN / 0,0)...');
  const invalidBookingRes = await makeRequest('POST', '/api/bookings', {
    service: 'AC Service & Repair',
    address: 'Random text with no GPS',
    latitude: 0,
    longitude: 0,
  }, {
    Authorization: `Bearer ${custToken}`,
  });

  if (invalidBookingRes.status === 400 && invalidBookingRes.data?.code === 'INVALID_COORDINATES') {
    console.log(`✓ Invalid coordinates correctly rejected with status 400 (${invalidBookingRes.data.error}).\n`);
  } else {
    console.error('✗ Security/Validation failure: Invalid coordinates were not rejected!', invalidBookingRes);
    process.exit(1);
  }

  // 8. Worker Acceptance & Navigation Coordinates Verification
  console.log('8. Worker login & checking exact destination navigation coordinates...');
  const workerTs = Date.now();
  const workerEmail = `worker.nav.${workerTs}@homestep.in`;
  const adminLogin = await makeRequest('POST', '/api/auth/login', {
    identifier: 'admin@homestep.in',
    password: 'admin123',
  });
  await makeRequest('POST', '/api/admin/workers', {
    name: 'Nav Test Worker',
    email: workerEmail,
    employeeId: `EMP-NAV-${workerTs.toString().slice(-4)}`,
    password: 'Password123!',
    services: ['AC Service & Repair'],
  }, { Authorization: `Bearer ${adminLogin.data.token}` });

  const wLogin = await makeRequest('POST', '/api/auth/login', {
    identifier: workerEmail,
    password: 'Password123!',
  });
  const workerToken = wLogin.data?.token;

  if (!workerToken) {
    console.error('✗ Worker login/create failed');
    process.exit(1);
  }

  // Admin assigns booking to worker
  await makeRequest('POST', `/api/admin/bookings/${createdBooking.id}/assign`, {
    workerId: wLogin.data.user.id,
  }, { Authorization: `Bearer ${adminLogin.data.token}` });

  // Worker accepts the booking
  const acceptRes = await makeRequest('POST', `/api/worker/jobs/${createdBooking.id}/accept`, {}, {
    Authorization: `Bearer ${workerToken}`,
  });

  if (acceptRes.status !== 200 || !acceptRes.data?.job) {
    console.error('✗ Worker job accept failed:', acceptRes);
    process.exit(1);
  }

  const acceptedJob = acceptRes.data.job;
  console.log('✓ Worker accepted job:');
  console.log(`  - Destination Lat: ${acceptedJob.latitude} (Matches Customer: ${acceptedJob.latitude === 10.8277})`);
  console.log(`  - Destination Lng: ${acceptedJob.longitude} (Matches Customer: ${acceptedJob.longitude === 78.6946})`);
  console.log(`  - Navigation Address: "${acceptedJob.address}"`);

  if (acceptedJob.latitude !== 10.8277 || acceptedJob.longitude !== 78.6946) {
    console.error('✗ Destination coordinates do not match customer booking coordinates!');
    process.exit(1);
  }
  console.log('✓ Worker navigation coordinates strictly match customer confirmed pin.\n');

  console.log('================================================================');
  console.log('🎉 ALL 8 LOCATION, REVERSE GEOCODING & NAVIGATION TESTS PASSED!');
  console.log('================================================================');
}

runRealLocationTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
