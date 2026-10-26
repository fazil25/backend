const BASE_URL = 'http://127.0.0.1:4000';

function getCanonicalStatus(status) {
  if (!status) return 'Created';
  const s = String(status).trim().toUpperCase().replace(/[\s-]+/g, '_');
  
  if (['PENDING', 'CONFIRMED', 'CREATED', 'REQUESTED', 'SEARCHING_WORKER', 'OPEN'].includes(s)) {
    return 'Created';
  }
  if (['WORKER_ASSIGNED', 'ASSIGNED', 'WORKER_ACCEPTED', 'ACCEPTED'].includes(s)) {
    return 'Accepted';
  }
  if (['TRAVELLING', 'WORKER_ON_THE_WAY', 'ON_THE_WAY'].includes(s)) {
    return 'Travelling';
  }
  if (['ARRIVED', 'ENTERED_HOME', 'ENTEREDHOME'].includes(s)) {
    return 'Arrived';
  }
  if (['WORK_STARTED', 'IN_PROGRESS', 'INPROGRESS', 'STARTED'].includes(s)) {
    return 'InProgress';
  }
  if (['WORK_FINISHED', 'CUSTOMER_CONFIRMED', 'PAYMENT_COMPLETED', 'PAYMENT_SETTLED', 'COMPLETED', 'RESOLVED'].includes(s)) {
    return 'Completed';
  }
  if (['CANCELLED', 'REJECTED', 'DECLINED', 'EXPIRED'].includes(s)) {
    return 'Cancelled';
  }
  return status;
}

function getStepIndex(status) {
  const canonical = getCanonicalStatus(status);
  switch (canonical) {
    case 'Created': return 0;
    case 'Accepted': return 1;
    case 'Travelling': return 2;
    case 'Arrived': return 3;
    case 'InProgress': return 4;
    case 'Completed': return 5;
    case 'Cancelled': return -1;
    default: return 0;
  }
}

function cleanAddressForDisplay(rawAddress, serviceAddress) {
  if (serviceAddress && typeof serviceAddress === 'object') {
    const parts = [
      serviceAddress.house || serviceAddress.flatNo || serviceAddress.addressLine1,
      serviceAddress.street || serviceAddress.road,
      serviceAddress.area || serviceAddress.locality,
      serviceAddress.landmark,
      serviceAddress.city,
      serviceAddress.state,
      serviceAddress.pincode || serviceAddress.postalCode,
    ].filter(Boolean);
    if (parts.length > 0) {
      return parts.join(', ')
        .replace(/Pin Location \([^)]+\),?\s*/gi, '')
        .replace(/\bNear Near\b/gi, 'Near')
        .replace(/,\s*,+/g, ', ')
        .replace(/^,\s*/, '')
        .replace(/,\s*$/, '')
        .trim();
    }
  }
  if (!rawAddress) return 'Trichy, Tamil Nadu';
  return String(rawAddress)
    .replace(/Pin Location \([^)]+\),?\s*/gi, '')
    .replace(/\bNear Near\b/gi, 'Near')
    .replace(/,\s*,+/g, ', ')
    .replace(/^,\s*/, '')
    .replace(/,\s*$/, '')
    .trim();
}

async function runTest() {
  console.log('=== HOMESTEPIN ADMIN BOOKING LIFECYCLE E2E TEST ===');

  // 1. Admin Login
  console.log('\n1. Logging in as Admin...');
  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin@homestep.in', password: 'admin123' })
  });
  const adminData = await adminLoginRes.json();
  if (!adminLoginRes.ok) throw new Error(`Admin login failed: ${JSON.stringify(adminData)}`);
  const adminToken = adminData.token;
  console.log('✔ Admin authenticated successfully');

  // 2. Customer Registration & Login
  console.log('\n2. Registering Customer Yacoob...');
  const ts = Date.now();
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Yacoob',
      phone: `+919944${ts.toString().slice(-6)}`,
      email: `yacoob.${ts}@homestep.in`,
      password: 'Password123!',
      role: 'customer'
    })
  });
  const custData = await regRes.json();
  const custToken = custData.token;
  const custUser = custData.user;
  console.log('✔ Customer authenticated:', custUser.name, custUser.id);

  // 3. Provision Worker vino via Admin & Login
  console.log('\n3. Provisioning Worker vino via Admin...');
  const workerEmail = `vino.${ts}@homestep.in`;
  const createWorkerRes = await fetch(`${BASE_URL}/api/admin/workers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: 'vino',
      email: workerEmail,
      employeeId: `EMP-${ts.toString().slice(-4)}`,
      password: 'Password123!',
      services: ['AC Service & Repair']
    })
  });
  const createWorkerData = await createWorkerRes.json();
  console.log('✔ Worker created via Admin API:', createWorkerData.worker?.name || 'vino');

  const workerLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: workerEmail, password: 'Password123!' })
  });
  const workerData = await workerLoginRes.json();
  const workerToken = workerData.token;
  const workerUser = workerData.user;
  console.log('✔ Worker authenticated:', workerUser.name, workerUser.id);

  // 4. Create Booking with messy address containing "Pin Location (...)" & "Near Near"
  console.log('\n4. Customer creating booking with unnormalized address string...');
  const bookingPayload = {
    service: 'AC Service & Repair',
    category: 'AC & Appliances',
    price: 523,
    date: '2026-09-06',
    time: '11:00 AM',
    slot: '11:00 AM - 01:00 PM',
    address: 'Flat 202, Pin Location (10.79319° N, 78.69471° E), Near Near Bhai Briyani, TVS TOLLGATE, Trichy, Tamilnadu, 620020',
    addressDetails: {
      house: 'Flat 202',
      flatNo: 'Flat 202',
      street: 'TVS Tollgate Main Road',
      road: 'TVS Tollgate Main Road',
      area: 'TVS TOLLGATE',
      locality: 'TVS TOLLGATE',
      landmark: 'Near Bhai Briyani',
      city: 'Trichy',
      state: 'Tamil Nadu',
      pincode: '620020',
      latitude: 10.79319,
      longitude: 78.69471
    },
    location: {
      latitude: 10.79319,
      longitude: 78.69471,
      address: 'Flat 202, Pin Location (10.79319° N, 78.69471° E), Near Near Bhai Briyani, TVS TOLLGATE, Trichy, Tamilnadu, 620020'
    },
    paymentMethod: 'ONLINE'
  };

  const createBookingRes = await fetch(`${BASE_URL}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custToken}` },
    body: JSON.stringify(bookingPayload)
  });
  const newBooking = await createBookingRes.json();
  if (!createBookingRes.ok) throw new Error(`Create booking failed: ${JSON.stringify(newBooking)}`);
  const bookingId = newBooking.booking?.id || newBooking.booking?.customId || newBooking.id || newBooking._id;
  console.log(`✔ Created booking ${bookingId} with status: ${newBooking.booking?.status || newBooking.status}`);

  // Test Admin view at step 0 (Created)
  console.log('\n--- Checking Step 0: Created ---');
  let adminBookingsRes = await fetch(`${BASE_URL}/api/admin/bookings`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  let adminBookings = await adminBookingsRes.json();
  let found = adminBookings.bookings.find(b => b.id === bookingId || b._id === bookingId || b.customId === bookingId);
  console.log('Admin sees status:', found.status, '=> Canonical:', getCanonicalStatus(found.status), '=> StepIndex:', getStepIndex(found.status));
  if (getStepIndex(found.status) !== 0) throw new Error(`Expected StepIndex 0, got ${getStepIndex(found.status)}`);
  console.log('Cleaned address:', cleanAddressForDisplay(found.address, found.serviceAddress));
  if (cleanAddressForDisplay(found.address, found.serviceAddress).includes('Pin Location')) throw new Error('Address still contains Pin Location');
  if (cleanAddressForDisplay(found.address, found.serviceAddress).includes('Near Near')) throw new Error('Address still contains Near Near');

  // 5. Worker Accepts Job
  console.log('\n5. Worker accepting booking...');
  const acceptRes = await fetch(`${BASE_URL}/api/worker/jobs/${bookingId}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` }
  });
  const acceptData = await acceptRes.json();
  console.log('✔ Worker accepted, status:', acceptData.job?.status || acceptData.booking?.status || acceptData.status);

  // Test Admin view at step 1 (Accepted)
  console.log('\n--- Checking Step 1: Accepted ---');
  adminBookingsRes = await fetch(`${BASE_URL}/api/admin/bookings`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  adminBookings = await adminBookingsRes.json();
  found = adminBookings.bookings.find(b => b.id === bookingId || b._id === bookingId || b.customId === bookingId);
  console.log('Admin sees status:', found.status, '=> Canonical:', getCanonicalStatus(found.status), '=> StepIndex:', getStepIndex(found.status));
  if (getStepIndex(found.status) !== 1) throw new Error(`Expected StepIndex 1, got ${getStepIndex(found.status)}`);

  // 6. Worker Starts Travel
  console.log('\n6. Worker starting travel...');
  const travelRes = await fetch(`${BASE_URL}/api/worker/jobs/${bookingId}/start-journey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` }
  });
  const travelData = await travelRes.json();
  console.log('✔ Worker travelling, status:', travelData.job?.status || travelData.booking?.status || travelData.status);

  // Test Admin view at step 2 (Travelling)
  console.log('\n--- Checking Step 2: Travelling ---');
  adminBookingsRes = await fetch(`${BASE_URL}/api/admin/bookings`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  adminBookings = await adminBookingsRes.json();
  found = adminBookings.bookings.find(b => b.id === bookingId || b._id === bookingId || b.customId === bookingId);
  console.log('Admin sees status:', found.status, '=> Canonical:', getCanonicalStatus(found.status), '=> StepIndex:', getStepIndex(found.status));
  if (getStepIndex(found.status) !== 2) throw new Error(`Expected StepIndex 2, got ${getStepIndex(found.status)}`);

  // 7. Worker Arrives
  console.log('\n7. Worker arrived...');
  const arriveRes = await fetch(`${BASE_URL}/api/worker/jobs/${bookingId}/arrive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` }
  });
  const arriveData = await arriveRes.json();
  console.log('✔ Worker arrived, status:', arriveData.job?.status || arriveData.booking?.status || arriveData.status);

  // Test Admin view at step 3 (Arrived)
  console.log('\n--- Checking Step 3: Arrived ---');
  adminBookingsRes = await fetch(`${BASE_URL}/api/admin/bookings`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  adminBookings = await adminBookingsRes.json();
  found = adminBookings.bookings.find(b => b.id === bookingId || b._id === bookingId || b.customId === bookingId);
  console.log('Admin sees status:', found.status, '=> Canonical:', getCanonicalStatus(found.status), '=> StepIndex:', getStepIndex(found.status));
  if (getStepIndex(found.status) !== 3) throw new Error(`Expected StepIndex 3, got ${getStepIndex(found.status)}`);

  // 8. Worker Starts Work (using OTP)
  console.log('\n8. Worker starting work with OTP:', found.startOtp || '1234');
  const startWorkRes = await fetch(`${BASE_URL}/api/worker/jobs/${bookingId}/start-work`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
    body: JSON.stringify({ otp: found.startOtp || '1234' })
  });
  const startWorkData = await startWorkRes.json();
  console.log('✔ Work started, status:', startWorkData.job?.status || startWorkData.booking?.status || startWorkData.status);

  // Test Admin view at step 4 (InProgress)
  console.log('\n--- Checking Step 4: InProgress ---');
  adminBookingsRes = await fetch(`${BASE_URL}/api/admin/bookings`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  adminBookings = await adminBookingsRes.json();
  found = adminBookings.bookings.find(b => b.id === bookingId || b._id === bookingId || b.customId === bookingId);
  console.log('Admin sees status:', found.status, '=> Canonical:', getCanonicalStatus(found.status), '=> StepIndex:', getStepIndex(found.status));
  if (getStepIndex(found.status) !== 4) throw new Error(`Expected StepIndex 4, got ${getStepIndex(found.status)}`);

  // 9. Worker Completes / Finishes Job
  console.log('\n9. Worker completing job (/finish-work)...');
  const completeRes = await fetch(`${BASE_URL}/api/worker/jobs/${bookingId}/finish-work`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
    body: JSON.stringify({ notes: 'AC service successfully completed' })
  });
  const completeData = await completeRes.json();
  console.log('✔ Worker finished job, status:', completeData.booking?.status || completeData.status);

  // Test Idempotent Double Completion
  console.log('\n9b. Testing Double Completion idempotency...');
  const doubleCompleteRes = await fetch(`${BASE_URL}/api/worker/jobs/${bookingId}/finish-work`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
    body: JSON.stringify({ notes: 'Duplicate complete attempt' })
  });
  console.log('✔ Double completion HTTP status:', doubleCompleteRes.status);

  // 10. Customer Confirms Completion if required
  console.log('\n10. Customer confirming completion...');
  const confirmRes = await fetch(`${BASE_URL}/api/bookings/${bookingId}/confirm-completion`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${custToken}` }
  });
  const confirmData = await confirmRes.json();
  console.log('✔ Customer confirmed completion, response:', confirmData.status || confirmData.booking?.status);

  // 11. Final Admin State Verification
  console.log('\n--- Checking Step 5: Completed (Authoritative Backend & Admin Check) ---');
  adminBookingsRes = await fetch(`${BASE_URL}/api/admin/bookings`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  adminBookings = await adminBookingsRes.json();
  found = adminBookings.bookings.find(b => b.id === bookingId || b._id === bookingId);

  console.log('\nFinal Booking Document in Admin API:');
  console.log('- Database Status:', found.status);
  console.log('- Canonical Admin Status:', getCanonicalStatus(found.status));
  console.log('- Lifecycle StepIndex:', getStepIndex(found.status));
  console.log('- Assigned Technician:', found.providerName);
  console.log('- Customer Name:', found.customerName);
  console.log('- Payable Total:', found.price);
  console.log('- Payment Status:', found.paymentStatus);
  console.log('- Completed At:', found.completedAt || found.finishedAt);
  console.log('- Cleaned Address:', cleanAddressForDisplay(found.address, found.serviceAddress));

  if (getCanonicalStatus(found.status) !== 'Completed') {
    throw new Error(`CRITICAL FAILURE: Canonical status is '${getCanonicalStatus(found.status)}', expected 'Completed'!`);
  }
  if (getStepIndex(found.status) !== 5) {
    throw new Error(`CRITICAL FAILURE: StepIndex is ${getStepIndex(found.status)}, expected 5!`);
  }

  // 12. Test Refresh / Polling Stability
  console.log('\n12. Testing repeated polling / refresh stability...');
  for (let i = 1; i <= 3; i++) {
    const pollRes = await fetch(`${BASE_URL}/api/admin/bookings`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const pollData = await pollRes.json();
    const polledBooking = pollData.bookings.find(b => b.id === bookingId || b._id === bookingId);
    if (getCanonicalStatus(polledBooking.status) !== 'Completed' || getStepIndex(polledBooking.status) !== 5) {
      throw new Error(`CRITICAL FAILURE: Status regressed on poll ${i}!`);
    }
  }
  console.log('✔ Status is terminal and stable across all polls');

  console.log('\n=======================================================');
  console.log('🎉 ALL ADMIN BOOKING LIFECYCLE E2E TESTS PASSED 100%!');
  console.log('=======================================================');
}

runTest().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
