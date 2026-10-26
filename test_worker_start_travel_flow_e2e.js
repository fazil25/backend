const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const http = require('http');
const { connectDb } = require('./src/db');
const User = require('./src/models/User');
const Booking = require('./src/models/Booking');

const BASE_URL = 'http://127.0.0.1:4000';

function makeRequest(method, pathUrl, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathUrl, BASE_URL);
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => (rawData += chunk));
        res.on('end', () => {
          try {
            const parsed = rawData ? JSON.parse(rawData) : null;
            resolve({ status: res.statusCode, data: parsed, headers: res.headers });
          } catch (e) {
            resolve({ status: res.statusCode, raw: rawData, headers: res.headers });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runWorkerTravelFlowTests() {
  console.log('========================================================================');
  console.log('  HOMESTEPIN — WORKER START TRAVEL & APP RESUME E2E TEST SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  try {
    await connectDb();

    // ── STEP 1: AUTHENTICATE ADMIN & PROVISION WORKER A AND WORKER B ──
    console.log('\n--- TEST 1: Worker Provisioning & Authentication ---');
    const adminLogin = await makeRequest('POST', '/api/auth/login', {
      identifier: 'admin@homestep.in',
      password: 'admin123',
    });
    assert(adminLogin.status === 200, 'Admin authenticated successfully');
    const adminToken = adminLogin.data?.token;

    const ts = Date.now();
    // Worker A
    await makeRequest(
      'POST',
      '/api/admin/workers',
      {
        name: 'Worker Alpha',
        email: `worker.alpha.${ts}@homestep.in`,
        employeeId: `EMP-A-${ts.toString().slice(-4)}`,
        password: 'Password123!',
        services: ['AC Service & Repair'],
      },
      { Authorization: `Bearer ${adminToken}` }
    );

    const workerALogin = await makeRequest('POST', '/api/auth/login', {
      identifier: `worker.alpha.${ts}@homestep.in`,
      password: 'Password123!',
    });
    assert(workerALogin.status === 200, 'Worker Alpha logged in successfully');
    const workerAToken = workerALogin.data?.token;

    // Worker B (Unassigned worker for authorization tests)
    await makeRequest(
      'POST',
      '/api/admin/workers',
      {
        name: 'Worker Beta',
        email: `worker.beta.${ts}@homestep.in`,
        employeeId: `EMP-B-${ts.toString().slice(-4)}`,
        password: 'Password123!',
        services: ['AC Service & Repair'],
      },
      { Authorization: `Bearer ${adminToken}` }
    );

    const workerBLogin = await makeRequest('POST', '/api/auth/login', {
      identifier: `worker.beta.${ts}@homestep.in`,
      password: 'Password123!',
    });
    assert(workerBLogin.status === 200, 'Worker Beta logged in successfully');
    const workerBToken = workerBLogin.data?.token;

    // Customer
    const custRegister = await makeRequest('POST', '/api/auth/register', {
      name: 'Travel Test Customer',
      email: `customer.travel.${ts}@homestep.in`,
      phone: `+9198${ts.toString().slice(-8)}`,
      password: 'Password123!',
      role: 'customer',
    });
    assert(custRegister.status === 201 || custRegister.status === 200, 'Customer registered successfully');
    const custToken = custRegister.data?.token;

    // ── STEP 2: CREATE BOOKING & ASSIGN TO WORKER ALPHA ───────────────
    console.log('\n--- TEST 2: Booking Creation & Acceptance ---');
    const createBookingRes = await makeRequest(
      'POST',
      '/api/bookings',
      {
        service: 'AC Service & Repair',
        category: 'AC & Climate',
        date: 'Today',
        time: '03:00 PM',
        price: '₹599',
        address: '100ft Road, Indiranagar, Bengaluru, 560038',
        serviceAddress: {
          houseNumber: 'Villa 12',
          street: '100 Feet Road',
          area: 'Indiranagar',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560038',
          country: 'India',
          latitude: 12.9784,
          longitude: 77.6408,
          accuracy: 8,
          source: 'GPS',
        },
      },
      { Authorization: `Bearer ${custToken}` }
    );
    assert(createBookingRes.status === 201, 'Booking created with exact GPS coordinates');
    const bookingId = createBookingRes.data?.booking?.id || createBookingRes.data?.booking?.customId;

    const acceptRes = await makeRequest(
      'POST',
      `/api/worker/jobs/${bookingId}/accept`,
      {},
      { Authorization: `Bearer ${workerAToken}` }
    );
    assert(acceptRes.status === 200, 'Worker Alpha successfully accepted booking');
    assert(acceptRes.data?.job?.status === 'Accepted', 'Job status is "Accepted" after acceptance');

    // ── STEP 3: WORKER AUTHORIZATION ENFORCEMENT ──────────────────────
    console.log('\n--- TEST 3: Unauthorized Worker Travel Prevention ---');
    const unauthTravelRes = await makeRequest(
      'POST',
      `/api/worker/jobs/${bookingId}/start-journey`,
      {},
      { Authorization: `Bearer ${workerBToken}` }
    );
    assert(unauthTravelRes.status === 403, 'Unassigned Worker Beta cannot start travel for Worker Alpha (403 Forbidden)');

    // ── STEP 4: BACKEND-FIRST ATOMIC STATE TRANSITION (START TRAVEL) ──
    console.log('\n--- TEST 4: Backend-First Atomic Start Travel ---');
    const startTravelRes = await makeRequest(
      'POST',
      `/api/worker/jobs/${bookingId}/start-journey`,
      {},
      { Authorization: `Bearer ${workerAToken}` }
    );
    assert(startTravelRes.status === 200, 'Start Travel API returned 200 OK');
    assert(startTravelRes.data?.job?.status === 'Travelling', 'Authoritative job status is "Travelling"');
    assert(startTravelRes.data?.job?.journeyStartedAt !== null, 'journeyStartedAt timestamp is saved');

    // Verify in database directly
    const dbBooking = await Booking.findOne({ customId: bookingId });
    assert(dbBooking && dbBooking.status === 'TRAVELLING', 'MongoDB booking status is persisted as TRAVELLING');

    // ── STEP 5: IDEMPOTENCY / DOUBLE-TAP SAFETY ──────────────────────
    console.log('\n--- TEST 5: Idempotent Start Travel Retries ---');
    const duplicateTravelRes = await makeRequest(
      'POST',
      `/api/worker/jobs/${bookingId}/start-journey`,
      {},
      { Authorization: `Bearer ${workerAToken}` }
    );
    assert(duplicateTravelRes.status === 200, 'Duplicate Start Travel request handled idempotently (200 OK)');
    assert(duplicateTravelRes.data?.job?.status === 'Travelling', 'Duplicate request returns status "Travelling" safely');

    // ── STEP 6: WORKER DASHBOARD REST RECONCILIATION ─────────────────
    console.log('\n--- TEST 6: Dashboard Reconciliation on App Resume ---');
    const dashboardRes = await makeRequest(
      'GET',
      '/api/worker/dashboard',
      null,
      { Authorization: `Bearer ${workerAToken}` }
    );
    assert(dashboardRes.status === 200, 'Worker dashboard loads successfully');
    const activeJob = dashboardRes.data?.jobs?.find((j) => j.bookingId === bookingId || j.id === bookingId);
    assert(activeJob !== undefined, 'Active job is present in worker dashboard');
    assert(activeJob?.status === 'Travelling', 'Active job status in dashboard is "Travelling" (Triggering "I\'VE ARRIVED")');
    assert(activeJob?.destination?.latitude === 12.9784, 'Exact destination latitude 12.9784 preserved for navigation');
    assert(activeJob?.destination?.longitude === 77.6408, 'Exact destination longitude 77.6408 preserved for navigation');

    // ── STEP 7: SESSION RECOVERY & APP PROCESS RESTART SIMULATION ────
    console.log('\n--- TEST 7: Session Restoration / Token Validation ---');
    const sessionValidateRes = await makeRequest(
      'GET',
      '/api/auth/me',
      null,
      { Authorization: `Bearer ${workerAToken}` }
    );
    assert(sessionValidateRes.status === 200, 'Session token validated successfully on resume');
    assert(sessionValidateRes.data?.user?.role === 'worker', 'Session role is confirmed as "worker"');

    // ── STEP 8: ADVANCE WORKER STATE TO ARRIVED & COMPLETED ──────────
    console.log('\n--- TEST 8: Arrival & Job Lifecycle Completion ---');
    const arriveRes = await makeRequest(
      'POST',
      `/api/worker/jobs/${bookingId}/arrive`,
      {},
      { Authorization: `Bearer ${workerAToken}` }
    );
    assert(arriveRes.status === 200, 'Worker marked Arrival successfully');
    assert(arriveRes.data?.job?.status === 'Arrived', 'Job status is "Arrived"');

    const startOtp = dbBooking.startOtp || '1234';
    await makeRequest('POST', `/api/worker/jobs/${bookingId}/enter-home`, {}, { Authorization: `Bearer ${workerAToken}` });
    const otpRes = await makeRequest('POST', `/api/worker/jobs/${bookingId}/verify-otp-start`, { otp: startOtp }, { Authorization: `Bearer ${workerAToken}` });
    assert(otpRes.status === 200, 'Worker started job successfully');
    assert(otpRes.data?.job?.status === 'InProgress', 'Job status is "InProgress"');

    const finishRes = await makeRequest('POST', `/api/worker/jobs/${bookingId}/finish-work`, { notes: 'Serviced perfectly' }, { Authorization: `Bearer ${workerAToken}` });
    assert(finishRes.status === 200, 'Worker completed job successfully');
    assert(finishRes.data?.job?.status === 'Completed', 'Job status is "Completed"');

  } catch (err) {
    console.error('Unhandled error during test suite:', err);
    failed++;
  }

  console.log(`\n========================================================================`);
  console.log(`  WORKER TRAVEL FLOW E2E SUMMARY: Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`========================================================================\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runWorkerTravelFlowTests();
