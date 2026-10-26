/**
 * HOMESTEPIN - End-to-End Customer Address Consistency & Admin Truth Test
 * 
 * Verifies:
 * 1. Customer registration without address never defaults to Bengaluru.
 * 2. GPS confirmation (Trichy: 10.79319, 78.69471) saves authoritative address to MongoDB.
 * 3. GET /api/customer/addresses returns exact coordinates and formatted Trichy address.
 * 4. GET /api/auth/me returns identical primaryAddress and coordinates.
 * 5. GET /api/admin/customers displays the exact Trichy address in directory.
 * 6. GET /api/admin/customers/:id returns identical primaryAddress & coordinates.
 * 7. Booking service address retains snapshot integrity when customer updates default address.
 */

const assert = require('assert');

const BASE_URL = process.env.TEST_API_URL || 'http://127.0.0.1:4000';

async function makeRequest(method, endpoint, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function runTest() {
  console.log('================================================================');
  console.log('HOMESTEPIN: CUSTOMER ADDRESS CONSISTENCY & ADMIN TRUTH E2E TEST');
  console.log('================================================================\n');

  const timestamp = Date.now();
  const customerEmail = `yacoob_${timestamp}@test.com`;
  const customerPhone = `98765${Math.floor(10000 + Math.random() * 90000)}`;

  // 1. REGISTER CUSTOMER (NO INITIAL ADDRESS)
  console.log('▶ [TEST 1] Register Customer (Yacoob)...');
  const regRes = await makeRequest('POST', '/api/auth/register', {
    name: 'Yacoob',
    email: customerEmail,
    phone: customerPhone,
    password: 'Password@123',
    confirmPassword: 'Password@123',
  });

  assert.strictEqual(regRes.status, 201, `Registration should succeed (201). Got ${regRes.status}: ${JSON.stringify(regRes.data)}`);
  const customerToken = regRes.data.token;
  const customerId = regRes.data.user.id;
  console.log(`  ✓ Customer Registered: ID = ${customerId}`);

  // 2. CHECK INITIAL PROFILE ADDRESS
  console.log('\n▶ [TEST 2] Verify Initial Profile has no fake Bengaluru defaults...');
  const meRes = await makeRequest('GET', '/api/auth/me', null, customerToken);
  assert.strictEqual(meRes.status, 200);
  assert.strictEqual(meRes.data.user.address, null, 'Unspecified address must be null, never Indiranagar/Bengaluru');
  assert.strictEqual(meRes.data.user.primaryAddress, null, 'primaryAddress must be null');
  console.log('  ✓ Verified: No fake Bengaluru fallback in customer profile');

  // 3. CONFIRM GPS ADDRESS (TRICHY: 10.79319, 78.69471)
  console.log('\n▶ [TEST 3] Add & Save Authoritative GPS Address (TVS Tollgate, Trichy)...');
  const trichyCoords = { lat: 10.79319, lng: 78.69471 };
  const addAddrRes = await makeRequest('POST', '/api/customer/addresses', {
    label: 'Home',
    house: 'Flat 202',
    houseNumber: 'Flat 202',
    street: 'TVS Tollgate Road',
    area: 'TVS Tollgate',
    landmark: 'Near Bhai Briyani',
    city: 'Trichy',
    state: 'Tamil Nadu',
    pincode: '620020',
    latitude: trichyCoords.lat,
    longitude: trichyCoords.lng,
    accuracy: 8,
    isDefault: true,
  }, customerToken);

  assert.strictEqual(addAddrRes.status, 201, `Address creation should succeed (201). Got: ${JSON.stringify(addAddrRes.data)}`);
  const savedAddressId = addAddrRes.data.address.id;
  const savedFormatted = addAddrRes.data.address.formattedAddress;
  console.log(`  ✓ Address Saved to MongoDB: ID = ${savedAddressId}`);
  console.log(`  ✓ Formatted: ${savedFormatted}`);
  console.log(`  ✓ Coordinates: (${addAddrRes.data.address.latitude}, ${addAddrRes.data.address.longitude})`);

  assert(savedFormatted.includes('Trichy'), 'Formatted address must include Trichy');
  assert(savedFormatted.includes('TVS Tollgate'), 'Formatted address must include TVS Tollgate');
  assert.strictEqual(Number(addAddrRes.data.address.latitude), trichyCoords.lat);
  assert.strictEqual(Number(addAddrRes.data.address.longitude), trichyCoords.lng);

  // 4. VERIFY /api/customer/addresses AND /api/auth/me
  console.log('\n▶ [TEST 4] Verify Customer Address API consistency...');
  const getAddrRes = await makeRequest('GET', '/api/customer/addresses', null, customerToken);
  assert.strictEqual(getAddrRes.status, 200);
  assert.strictEqual(getAddrRes.data.addresses.length, 1);
  assert.strictEqual(getAddrRes.data.primaryAddress.id, savedAddressId);
  assert.strictEqual(getAddrRes.data.primaryAddress.city, 'Trichy');
  assert.strictEqual(Number(getAddrRes.data.primaryAddress.latitude), trichyCoords.lat);

  const meAfterRes = await makeRequest('GET', '/api/auth/me', null, customerToken);
  assert.strictEqual(meAfterRes.data.user.primaryAddress.id, savedAddressId);
  assert.strictEqual(meAfterRes.data.user.primaryAddress.city, 'Trichy');
  console.log('  ✓ Verified: Customer Address API and Auth Profile return identical default address');

  // 5. ADMIN LOGIN & CUSTOMER DIRECTORY VERIFICATION
  console.log('\n▶ [TEST 5] Admin Customer Directory Truth Verification...');
  const adminLoginRes = await makeRequest('POST', '/api/auth/login', {
    identifier: 'admin@homestep.in',
    password: 'admin123',
  });
  assert.strictEqual(adminLoginRes.status, 200, `Admin login must succeed: ${JSON.stringify(adminLoginRes.data)}`);
  const adminToken = adminLoginRes.data.token;

  const adminCustsRes = await makeRequest('GET', `/api/admin/customers?search=${customerPhone}`, null, adminToken);
  assert.strictEqual(adminCustsRes.status, 200);
  const foundAdminCust = adminCustsRes.data.customers.find(c => c.id === customerId || c.email === customerEmail);
  assert(foundAdminCust, 'Admin directory must find customer Yacoob');

  console.log(`  ✓ Admin Directory Customer ID: ${foundAdminCust.id}`);
  console.log(`  ✓ Admin Directory Address: "${foundAdminCust.address}"`);
  console.log(`  ✓ Admin Primary Address ID: ${foundAdminCust.primaryAddress?.id}`);

  assert.strictEqual(foundAdminCust.primaryAddress.id, savedAddressId, 'Admin directory must use exact default address ID');
  assert(foundAdminCust.address.includes('Trichy'), 'Admin directory address must contain Trichy');
  assert(!foundAdminCust.address.includes('Bengaluru'), 'Admin directory address must NOT contain Bengaluru');
  assert(!foundAdminCust.address.includes('Near Near'), 'Admin directory address must NOT contain "Near Near"');

  // 6. ADMIN CUSTOMER PROFILE DRAWER VERIFICATION
  console.log('\n▶ [TEST 6] Admin Customer Single Profile Details Verification...');
  const adminSingleCustRes = await makeRequest('GET', `/api/admin/customers/${customerId}`, null, adminToken);
  assert.strictEqual(adminSingleCustRes.status, 200);
  const singleCust = adminSingleCustRes.data.customer;

  assert.strictEqual(singleCust.primaryAddress.id, savedAddressId);
  assert.strictEqual(Number(singleCust.primaryAddress.latitude), trichyCoords.lat);
  assert.strictEqual(Number(singleCust.primaryAddress.longitude), trichyCoords.lng);
  assert.strictEqual(singleCust.primaryAddress.city, 'Trichy');
  assert(!singleCust.address.includes('Bengaluru'), 'Single customer profile must NOT contain Bengaluru');
  assert(!singleCust.address.includes('Near Near'), 'Single customer profile must NOT contain "Near Near"');
  console.log('  ✓ Verified: Admin Customer Detail Drawer returns exact Trichy coordinates & address');

  // 7. BOOKING HISTORICAL SNAPSHOT INTEGRITY
  console.log('\n▶ [TEST 7] Booking Historical Snapshot Address Verification...');
  const bookingCreateRes = await makeRequest('POST', '/api/bookings', {
    service: 'AC Service & Repair',
    address: savedFormatted,
    house: 'Flat 202',
    street: 'TVS Tollgate Road',
    area: 'TVS Tollgate',
    city: 'Trichy',
    state: 'Tamil Nadu',
    pincode: '620020',
    latitude: trichyCoords.lat,
    longitude: trichyCoords.lng,
    price: '₹523',
    priceNum: 523,
    scheduledDate: 'Tomorrow',
    scheduledTime: '10:00 AM',
  }, customerToken);

  assert.strictEqual(bookingCreateRes.status, 201, `Booking creation should succeed: ${JSON.stringify(bookingCreateRes.data)}`);
  const createdBooking = bookingCreateRes.data.booking;
  console.log(`  ✓ Booking created with snapshot address: #${createdBooking.id} at (${createdBooking.latitude}, ${createdBooking.longitude})`);

  // Now customer updates their profile address to a different location in Trichy (Cantonment)
  const newTrichyCoords = { lat: 10.8055, lng: 78.6856 };
  const updateAddrRes = await makeRequest('POST', '/api/customer/addresses', {
    label: 'Office',
    house: 'Suite 101',
    street: 'Cantonment Main Rd',
    area: 'Cantonment',
    city: 'Trichy',
    state: 'Tamil Nadu',
    pincode: '620001',
    latitude: newTrichyCoords.lat,
    longitude: newTrichyCoords.lng,
    isDefault: true,
  }, customerToken);
  assert.strictEqual(updateAddrRes.status, 201);

  // Fetch admin booking command center
  const adminBookingsRes = await makeRequest('GET', `/api/admin/bookings?search=${createdBooking.id}`, null, adminToken);
  assert.strictEqual(adminBookingsRes.status, 200);
  const foundBooking = adminBookingsRes.data.bookings.find(b => b.id === createdBooking.id);
  assert(foundBooking, 'Admin must find the created booking');

  assert.strictEqual(Number(foundBooking.latitude), trichyCoords.lat, 'Booking snapshot latitude must remain original');
  assert.strictEqual(Number(foundBooking.longitude), trichyCoords.lng, 'Booking snapshot longitude must remain original');
  assert(foundBooking.address.includes('TVS Tollgate'), 'Booking historical snapshot address must remain TVS Tollgate');
  console.log('  ✓ Verified: Booking historical snapshot is preserved independently of customer profile changes');

  console.log('\n================================================================');
  console.log('🎉 ALL CUSTOMER ADDRESS CONSISTENCY & TRUTH CHECKS PASSED 100%');
  console.log('================================================================\n');
}

runTest().catch(err => {
  console.error('\n❌ Address consistency test failed:', err);
  process.exit(1);
});
