const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const http = require('http');
const assert = require('assert');
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

async function runDataConsistencyTests() {
  console.log('========================================================================');
  console.log('  HOMESTEPIN — PARTNER COMPLETED-JOBS DATA CONSISTENCY E2E TEST');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function testAssert(condition, testName) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  await connectDb();

  // 1. Authenticate Admin
  console.log('--- STEP 1: Admin Authentication ---');
  const adminLogin = await makeRequest('POST', '/api/auth/login', {
    identifier: 'admin@homestep.in',
    password: 'admin123',
  });
  testAssert(adminLogin.status === 200, 'Admin authenticated successfully');
  const adminToken = adminLogin.data?.token;

  // 2. Locate Partner 8888 (vino)
  console.log('\n--- STEP 2: Locate Partner 8888 (vino) in Database ---');
  const vinoWorker = await User.findOne({
    $or: [{ employeeId: '8888' }, { name: 'vino' }],
  }).lean();
  testAssert(Boolean(vinoWorker), 'Partner 8888 (vino) exists in database');

  const vinoIds = [
    vinoWorker.customId,
    vinoWorker._id.toString(),
    vinoWorker.employeeId,
  ].filter(Boolean);

  // Count persistent completed bookings directly in MongoDB
  const CANONICAL_COMPLETED = [
    'COMPLETED',
    'Completed',
    'completed',
    'WORK_FINISHED',
    'work_finished',
    'CUSTOMER_CONFIRMED',
    'customer_confirmed',
    'PAYMENT_COMPLETED',
    'payment_completed',
    'PAYMENT_SETTLED',
    'payment_settled',
    'SETTLED',
    'settled',
    'CLOSED',
    'closed',
    'DONE',
    'done',
    'Finished',
    'finished',
  ];

  const dbCompletedCount = await Booking.countDocuments({
    $or: [
      { providerId: { $in: vinoIds } },
      { worker: vinoWorker._id },
    ],
    status: { $in: CANONICAL_COMPLETED },
  });

  console.log(`Authoritative MongoDB completed jobs for Partner 8888: ${dbCompletedCount}`);
  testAssert(dbCompletedCount > 0, `Partner 8888 has ${dbCompletedCount} completed jobs in database`);

  // 3. Admin API: GET /api/admin/workers
  console.log('\n--- STEP 3: Verify GET /api/admin/workers completedJobsCount ---');
  const adminWorkersRes = await makeRequest(
    'GET',
    '/api/admin/workers',
    null,
    { Authorization: `Bearer ${adminToken}` }
  );
  testAssert(adminWorkersRes.status === 200, 'GET /api/admin/workers returned 200');

  const adminVino = adminWorkersRes.data?.workers?.find(
    w => w.employeeId === '8888' || w.id === vinoWorker.customId || w._id === vinoWorker._id.toString()
  );
  testAssert(Boolean(adminVino), 'Partner 8888 found in Admin workers list');
  console.log('Admin Workers List Partner data:', {
    name: adminVino?.name,
    employeeId: adminVino?.employeeId,
    completedJobsCount: adminVino?.completedJobsCount,
    walletBalance: adminVino?.walletBalance,
    ratingAvg: adminVino?.ratingAvg,
  });
  testAssert(adminVino?.completedJobsCount === dbCompletedCount, `Admin workers list matches DB completed count (${adminVino?.completedJobsCount} === ${dbCompletedCount})`);
  testAssert(adminVino?.completedJobsCount > 0, 'Admin workers list does NOT show 0');

  // 4. Admin API: GET /api/admin/workers/:id
  console.log('\n--- STEP 4: Verify GET /api/admin/workers/:id Detail Profile ---');
  const targetId = vinoWorker.customId || vinoWorker.employeeId || vinoWorker._id.toString();
  const adminWorkerDetailRes = await makeRequest(
    'GET',
    `/api/admin/workers/${targetId}`,
    null,
    { Authorization: `Bearer ${adminToken}` }
  );
  testAssert(adminWorkerDetailRes.status === 200, `GET /api/admin/workers/${targetId} returned 200`);
  const detailWorker = adminWorkerDetailRes.data?.worker;
  console.log('Admin Detail Profile data:', {
    name: detailWorker?.name,
    employeeId: detailWorker?.employeeId,
    completedJobsCount: detailWorker?.completedJobsCount,
    walletBalance: detailWorker?.walletBalance,
    ratingAvg: detailWorker?.ratingAvg,
    ratingCount: detailWorker?.ratingCount,
  });
  testAssert(detailWorker?.completedJobsCount === dbCompletedCount, `Admin profile detail matches DB completed count (${detailWorker?.completedJobsCount} === ${dbCompletedCount})`);
  testAssert(detailWorker?.completedJobsCount > 0, 'Admin profile detail does NOT show 0');
  testAssert(detailWorker?.walletBalance === vinoWorker.walletBalance, `Admin profile wallet balance matches DB (₹${detailWorker?.walletBalance})`);

  // 5. Test Live Booking Completion Progression
  console.log('\n--- STEP 5: Create, Progress & Complete a New Booking for Worker Beta ---');
  const ts = Date.now();
  // Create test worker
  const createWorkerRes = await makeRequest(
    'POST',
    '/api/admin/workers',
    {
      name: 'Partner Consistency Test',
      email: `partner.consist.${ts}@homestep.in`,
      employeeId: `EMP-C-${ts.toString().slice(-4)}`,
      password: 'Password123!',
      services: ['AC Service & Repair'],
    },
    { Authorization: `Bearer ${adminToken}` }
  );
  const testWorkerId = createWorkerRes.data?.worker?.customId || createWorkerRes.data?.worker?.id;

  // Login as test worker
  const testWorkerLogin = await makeRequest('POST', '/api/auth/login', {
    identifier: `partner.consist.${ts}@homestep.in`,
    password: 'Password123!',
  });
  const testWorkerToken = testWorkerLogin.data?.token;

  // Check initial worker completed count (must be 0)
  const initialAdminProfile = await makeRequest(
    'GET',
    `/api/admin/workers/${testWorkerId}`,
    null,
    { Authorization: `Bearer ${adminToken}` }
  );
  testAssert(initialAdminProfile.data?.worker?.completedJobsCount === 0, 'New worker starts with 0 completed jobs');

  // Customer creates booking
  const custRegister = await makeRequest('POST', '/api/auth/register', {
    name: 'Consistency Customer',
    email: `customer.consist.${ts}@homestep.in`,
    phone: `+9197${ts.toString().slice(-8)}`,
    password: 'Password123!',
    role: 'customer',
  });
  const custToken = custRegister.data?.token;

  const createBookingRes = await makeRequest(
    'POST',
    '/api/bookings',
    {
      service: 'AC Service & Repair',
      category: 'AC & Climate',
      date: '2026-09-08',
      slot: '10:00 AM – 12:00 PM',
      price: '₹500',
      address: 'Indiranagar, Bengaluru, 560038',
      serviceAddress: {
        houseNumber: 'Flat 101',
        street: '100ft Road',
        area: 'Indiranagar',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560038',
        latitude: 12.9784,
        longitude: 77.6408,
      },
    },
    { Authorization: `Bearer ${custToken}` }
  );
  const bookingId = createBookingRes.data?.booking?.id || createBookingRes.data?.booking?.customId;
  const dbBooking = await Booking.findOne({ customId: bookingId });
  const otp = dbBooking?.startOtp;

  // Worker accepts -> travels -> arrives -> starts with OTP -> completes
  await makeRequest('POST', `/api/worker/jobs/${bookingId}/accept`, {}, { Authorization: `Bearer ${testWorkerToken}` });
  await makeRequest('POST', `/api/worker/jobs/${bookingId}/start-journey`, {}, { Authorization: `Bearer ${testWorkerToken}` });
  await makeRequest('POST', `/api/worker/jobs/${bookingId}/arrive`, {}, { Authorization: `Bearer ${testWorkerToken}` });
  await makeRequest('POST', `/api/worker/jobs/${bookingId}/start-job`, { otp }, { Authorization: `Bearer ${testWorkerToken}` });
  const finishRes = await makeRequest('POST', `/api/worker/jobs/${bookingId}/finish-work`, {}, { Authorization: `Bearer ${testWorkerToken}` });
  testAssert(finishRes.status === 200, 'Worker completed work successfully');

  // Verify Admin Worker Profile immediately reflects 1 completed job
  const updatedAdminProfile = await makeRequest(
    'GET',
    `/api/admin/workers/${testWorkerId}`,
    null,
    { Authorization: `Bearer ${adminToken}` }
  );
  testAssert(updatedAdminProfile.data?.worker?.completedJobsCount === 1, 'Admin profile immediately updates to 1 completed job');

  // Verify Worker Dashboard API reflects 1 completed job
  const workerDashboardRes = await makeRequest(
    'GET',
    '/api/worker/dashboard',
    null,
    { Authorization: `Bearer ${testWorkerToken}` }
  );
  testAssert(workerDashboardRes.data?.profile?.completedJobsCount === 1, 'Worker dashboard immediately updates to 1 completed job');

  console.log('\n========================================================================');
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runDataConsistencyTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
