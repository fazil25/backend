const http = require('http');
const assert = require('assert');

const BASE_URL = 'http://127.0.0.1:4000';

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
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

async function runTests() {
  console.log('================================================================');
  console.log('HOMESTEPIN — GPS → REAL ADDRESS AUTO-FILL E2E VERIFICATION SUITE');
  console.log('================================================================\n');

  // TEST 1: Trichy Coordinates Reverse Geocode
  console.log('▶ [TEST 1] Reverse Geocoding Exact Trichy Coordinates (10.79319, 78.69471)...');
  const trichyGeoRes = await request('POST', '/api/geo/reverse-geocode', {
    latitude: 10.79319,
    longitude: 78.69471,
  });

  assert.strictEqual(trichyGeoRes.status, 200, 'Trichy reverse-geocode returns 200');
  const trichyData = trichyGeoRes.data;
  console.log('  Trichy Geocode Output:', JSON.stringify(trichyData, null, 2));

  assert(trichyData.city.toLowerCase().includes('tiruchirappalli') || trichyData.city.toLowerCase().includes('trichy') || trichyData.state.toLowerCase().includes('tamil nadu'), 'Resolved city or state is in Tamil Nadu');
  assert.strictEqual(trichyData.state, 'Tamil Nadu', 'Resolved state is Tamil Nadu');
  assert.strictEqual(trichyData.pincode, '620020', 'Resolved pincode is 620020');
  assert(!trichyData.street.includes('Pin Location'), 'Street must NEVER contain "Pin Location"');
  assert(!trichyData.street.includes('10.79319'), 'Street must NEVER contain coordinates text');
  assert(!JSON.stringify(trichyData).toLowerCase().includes('bengaluru'), 'Trichy result contains zero Bengaluru contamination');
  assert(!JSON.stringify(trichyData).toLowerCase().includes('560038'), 'Trichy result contains zero 560038 contamination');
  console.log('  ✓ TEST 1 PASSED: Real Trichy coordinates resolved to genuine Tamil Nadu address without contamination.\n');

  // TEST 2: Bengaluru Coordinates Reverse Geocode
  console.log('▶ [TEST 2] Reverse Geocoding Bengaluru Coordinates (12.9784, 77.6408)...');
  const blrGeoRes = await request('POST', '/api/geo/reverse-geocode', {
    latitude: 12.9784,
    longitude: 77.6408,
  });

  assert.strictEqual(blrGeoRes.status, 200, 'Bengaluru reverse-geocode returns 200');
  const blrData = blrGeoRes.data;
  console.log('  Bengaluru Geocode Output:', JSON.stringify(blrData, null, 2));
  assert(blrData.city.toLowerCase().includes('bengaluru') || blrData.city.toLowerCase().includes('bangalore'), 'Resolved city is Bengaluru');
  assert.strictEqual(blrData.state, 'Karnataka', 'Resolved state is Karnataka');
  assert.strictEqual(blrData.pincode, '560038', 'Resolved pincode is 560038');
  assert(!blrData.street.includes('Pin Location'), 'Street must NEVER contain "Pin Location"');
  console.log('  ✓ TEST 2 PASSED: Bengaluru coordinates resolved correctly.\n');

  // TEST 3: User Registration & Address Schema Persistence
  console.log('▶ [TEST 3] Customer Registration & Address Schema Persistence...');
  const tsCust = Date.now();
  const testPhone = `+9198${Math.floor(10000000 + Math.random() * 90000000)}`;
  const regRes = await request('POST', '/api/auth/register-customer', {
    name: 'Trichy Home Customer',
    email: `cust.trichy.${tsCust}@example.com`,
    phone: testPhone,
    password: 'Password123!',
    confirmPassword: 'Password123!',
    role: 'customer',
  });
  assert.strictEqual(regRes.status, 201, 'Customer registered successfully');
  const token = regRes.data.token;
  assert(token, 'Auth token received');

  // Save Trichy address
  const saveAddrRes = await request('POST', '/api/user/addresses', {
    label: 'Home',
    house: 'Door No 42, 2nd Floor',
    houseNumber: 'Door No 42',
    street: trichyData.street || 'Trichy - Pudukkottai Road',
    line1: 'Door No 42, 2nd Floor, ' + (trichyData.street || 'Trichy - Pudukkottai Road'),
    area: trichyData.area || 'Trichy Zone II',
    city: trichyData.city || 'Tiruchirappalli',
    state: trichyData.state || 'Tamil Nadu',
    pincode: trichyData.pincode || '620020',
    landmark: 'Near Airport Junction',
    latitude: 10.79319,
    longitude: 78.69471,
    accuracy: 12,
    source: 'GPS',
    isDefault: true,
  }, token);

  assert.strictEqual(saveAddrRes.status, 201, 'Address saved with status 201');
  const savedAddress = saveAddrRes.data.address;
  console.log('  Saved Address Record:', JSON.stringify(savedAddress, null, 2));

  assert.strictEqual(savedAddress.latitude, 10.79319, 'Latitude preserved in MongoDB');
  assert.strictEqual(savedAddress.longitude, 78.69471, 'Longitude preserved in MongoDB');
  assert.strictEqual(savedAddress.state, 'Tamil Nadu', 'State preserved');
  assert.strictEqual(savedAddress.pincode, '620020', 'Pincode preserved');
  assert(!savedAddress.street.includes('Pin Location'), 'Street does not contain "Pin Location"');

  // Fetch addresses via API
  const getAddrsRes = await request('GET', '/api/user/addresses', null, token);
  assert.strictEqual(getAddrsRes.status, 200, 'GET addresses returns 200');
  const fetchedAddr = getAddrsRes.data.addresses.find(a => a.id === savedAddress.id);
  assert(fetchedAddr, 'Fetched saved address from database');
  assert.strictEqual(fetchedAddr.latitude, 10.79319, 'Fetched latitude matches');
  assert.strictEqual(fetchedAddr.longitude, 78.69471, 'Fetched longitude matches');
  console.log('  ✓ TEST 3 PASSED: Full address schema persisted and retrieved identically.\n');

  // TEST 4: Create Booking with Confirmed Location
  console.log('▶ [TEST 4] Create Booking with Confirmed Trichy Coordinates...');
  const bookingRes = await request('POST', '/api/bookings', {
    service: 'AC Master Service',
    category: 'Air Conditioner',
    quantity: 1,
    date: '2026-09-10',
    time: '10:00 AM - 12:00 PM',
    slot: '10:00 AM - 12:00 PM',
    address: savedAddress.address,
    addressDetails: savedAddress,
    latitude: 10.79319,
    longitude: 78.69471,
    locationAccuracy: 12,
    locationSource: 'GPS',
    addressId: savedAddress.id,
    paymentMethod: 'Cash on Service',
  }, token);

  assert.strictEqual(bookingRes.status, 201, 'Booking created with status 201');
  const booking = bookingRes.data.booking;
  console.log('  Created Booking Location Data:', {
    id: booking.id,
    latitude: booking.latitude,
    longitude: booking.longitude,
    serviceAddress: booking.serviceAddress,
  });

  assert.strictEqual(booking.latitude, 10.79319, 'Booking has confirmed latitude');
  assert.strictEqual(booking.longitude, 78.69471, 'Booking has confirmed longitude');
  assert.strictEqual(booking.serviceAddress.pincode, '620020', 'Booking snapshot has 620020 pincode');
  assert.strictEqual(booking.serviceAddress.state, 'Tamil Nadu', 'Booking snapshot has Tamil Nadu');
  assert(!booking.serviceAddress.street.includes('Pin Location'), 'Booking snapshot street does not contain "Pin Location"');
  console.log('  ✓ TEST 4 PASSED: Booking contains confirmed coordinates and unpolluted address snapshot.\n');

  // TEST 5: Customer Privacy Check (No Live Worker GPS exposed to customer)
  console.log('▶ [TEST 5] Customer Privacy Verification (Customer cannot see Worker live GPS)...');
  const custBookingDetails = await request('GET', `/api/bookings/${booking.id}`, null, token);
  assert.strictEqual(custBookingDetails.status, 200, 'Customer fetched booking details');
  const details = custBookingDetails.data.booking || custBookingDetails.data;
  assert.strictEqual(details.workerLatitude, undefined, 'Worker live latitude hidden from customer');
  assert.strictEqual(details.workerLongitude, undefined, 'Worker live longitude hidden from customer');
  console.log('  ✓ TEST 5 PASSED: Worker live location strictly hidden from customer view.\n');

  // TEST 6: Worker Navigation Coordinates Check
  console.log('▶ [TEST 6] Worker Navigation Coordinates Verification...');
  // Authenticate Admin
  const adminLogin = await request('POST', '/api/auth/login', {
    identifier: 'admin@homestep.in',
    password: 'admin123',
  });
  assert.strictEqual(adminLogin.status, 200, 'Admin authenticated');
  const adminToken = adminLogin.data.token;

  const ts = Date.now();
  const workerEmail = `worker.trichy.${ts}@homestep.in`;
  await request('POST', '/api/admin/workers', {
    name: 'Trichy Specialist',
    email: workerEmail,
    employeeId: `EMP-TR-${ts.toString().slice(-4)}`,
    password: 'Password123!',
    services: ['AC Master Service'],
  }, adminToken);

  const workerLogin = await request('POST', '/api/auth/login', {
    identifier: workerEmail,
    password: 'Password123!',
  });
  assert.strictEqual(workerLogin.status, 200, 'Worker logged in');
  const workerToken = workerLogin.data.token;

  // Admin assigns worker to booking
  await request('POST', `/api/admin/bookings/${booking.id}/assign`, {
    workerId: workerLogin.data.user.id,
  }, adminToken);

  // Worker views job
  const jobRes = await request('GET', `/api/worker/jobs/${booking.id}`, null, workerToken);
  assert.strictEqual(jobRes.status, 200, 'Worker fetched job details');
  const jobData = jobRes.data.job || jobRes.data;
  console.log('  Worker Job Assigned Details:', {
    jobId: jobData.id,
    latitude: jobData.latitude,
    longitude: jobData.longitude,
    address: jobData.address,
  });

  assert.strictEqual(jobData.latitude, 10.79319, 'Worker sees exact customer latitude for navigation');
  assert.strictEqual(jobData.longitude, 78.69471, 'Worker sees exact customer longitude for navigation');
  console.log('  ✓ TEST 6 PASSED: Worker Navigation has exact confirmed customer coordinates.\n');

  console.log('================================================================');
  console.log('🎉 ALL 6 GPS → REAL ADDRESS AUTO-FILL E2E TESTS PASSED WITH 100% SUCCESS!');
  console.log('================================================================');
}

runTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
