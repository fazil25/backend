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

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function formatDistance(distKm) {
  if (distKm === null || distKm === undefined || isNaN(distKm)) return null;
  if (distKm < 1) {
    const meters = Math.round(distKm * 1000);
    return `${meters} m`;
  }
  return `${distKm.toFixed(1)} km`;
}

function cleanLandmarkDisplay(landmark) {
  if (!landmark) return '';
  let cleaned = String(landmark).trim();
  while (/^near\s+/i.test(cleaned)) {
    cleaned = cleaned.replace(/^near\s+/i, '').trim();
  }
  return cleaned ? `Near ${cleaned}` : '';
}

async function runE2ETests() {
  console.log('========================================================================');
  console.log('  HOMESTEPIN — PARTNER APP COMPREHENSIVE E2E VERIFICATION SUITE');
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

  // 1. Distance & Landmark Unit Logic
  console.log('--- TEST 1: Distance Calculation & Landmark Normalization ---');
  const d1 = calculateDistanceKm(10.790483, 78.704672, 10.795000, 78.704672);
  const formatted1 = formatDistance(d1);
  testAssert(formatted1.endsWith(' m'), `Distance < 1km formatted in meters (${formatted1})`);

  const d2 = calculateDistanceKm(10.790483, 78.704672, 10.812000, 78.704672);
  const formatted2 = formatDistance(d2);
  testAssert(formatted2.endsWith(' km'), `Distance >= 1km formatted in km (${formatted2})`);

  testAssert(formatDistance(null) === null, 'Missing coordinates return null');

  testAssert(cleanLandmarkDisplay('Near Near Bhai Briyani') === 'Near Bhai Briyani', 'Cleans "Near Near Bhai Briyani"');
  testAssert(cleanLandmarkDisplay('Near Bhai Briyani') === 'Near Bhai Briyani', 'Preserves single "Near Bhai Briyani"');
  testAssert(cleanLandmarkDisplay('Bhai Briyani') === 'Near Bhai Briyani', 'Prefixes "Near" to raw landmark "Bhai Briyani"');
  testAssert(cleanLandmarkDisplay('near near near Opp bus stop') === 'Near Opp bus stop', 'Cleans multiple lowercase "near"');

  // 2. Live API Testing
  console.log('\n--- TEST 2: Live Authentication & Booking Lifecycle with Canonical Date/Time ---');
  await connectDb();

  const adminLogin = await makeRequest('POST', '/api/auth/login', {
    identifier: 'admin@homestep.in',
    password: 'admin123',
  });
  testAssert(adminLogin.status === 200, 'Admin logged in');
  const adminToken = adminLogin.data?.token;

  const ts = Date.now();
  // Create test worker
  await makeRequest(
    'POST',
    '/api/admin/workers',
    {
      name: 'Partner Vijay',
      email: `partner.vijay.${ts}@homestep.in`,
      employeeId: `EMP-V-${ts.toString().slice(-4)}`,
      password: 'Password123!',
      services: ['AC Service & Repair'],
    },
    { Authorization: `Bearer ${adminToken}` }
  );

  const workerLogin = await makeRequest('POST', '/api/auth/login', {
    identifier: `partner.vijay.${ts}@homestep.in`,
    password: 'Password123!',
  });
  testAssert(workerLogin.status === 200, 'Worker authenticated successfully');
  const workerToken = workerLogin.data?.token;

  // Create test customer
  const custRegister = await makeRequest('POST', '/api/auth/register', {
    name: 'Yacoob Customer',
    email: `customer.yacoob.${ts}@homestep.in`,
    phone: `+9198${ts.toString().slice(-8)}`,
    password: 'Password123!',
    role: 'customer',
  });
  testAssert(custRegister.status === 201 || custRegister.status === 200, 'Customer registered');
  const custToken = custRegister.data?.token;

  // Create booking with canonical date and slot
  const createBookingRes = await makeRequest(
    'POST',
    '/api/bookings',
    {
      service: 'AC Service & Repair',
      category: 'AC & Climate',
      date: '2026-09-08',
      slot: '08:00 AM – 10:00 AM',
      price: '₹458',
      address: 'Flat 202, Pudukottai Main Road, Illupur, Tiruchirappalli, Tamil Nadu 620020',
      serviceAddress: {
        houseNumber: 'Flat 202',
        street: 'Pudukottai Main Road',
        area: 'Illupur',
        city: 'Tiruchirappalli',
        state: 'Tamil Nadu',
        pincode: '620020',
        landmark: 'Near Near Bhai Briyani',
        latitude: 10.790483,
        longitude: 78.704672,
        source: 'GPS',
      },
    },
    { Authorization: `Bearer ${custToken}` }
  );
  testAssert(createBookingRes.status === 201, 'Booking created with canonical appointment');
  const bookingId = createBookingRes.data?.booking?.id || createBookingRes.data?.booking?.customId;
  const dbBooking = await Booking.findOne({ customId: bookingId });
  const otp = dbBooking?.startOtp || createBookingRes.data?.booking?.startOtp;
  testAssert(Boolean(otp && otp.length === 4), `Generated valid 4-digit OTP: ${otp}`);

  // Partner accepts booking
  const acceptRes = await makeRequest(
    'POST',
    `/api/worker/jobs/${bookingId}/accept`,
    {},
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(acceptRes.status === 200, 'Partner accepted booking');
  testAssert(acceptRes.data?.job?.date === '2026-09-08', 'Job appointment date is canonical: 2026-09-08');
  testAssert(acceptRes.data?.job?.slot === '08:00 AM – 10:00 AM', 'Job appointment slot is canonical: 08:00 AM – 10:00 AM');

  // Start Journey
  const startJourneyRes = await makeRequest(
    'POST',
    `/api/worker/jobs/${bookingId}/start-journey`,
    {},
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(startJourneyRes.status === 200, 'Partner started journey (status: Travelling)');

  // Arrive at Location
  const arriveRes = await makeRequest(
    'POST',
    `/api/worker/jobs/${bookingId}/arrive`,
    {},
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(arriveRes.status === 200, 'Partner arrived at doorstep (status: Arrived)');

  // 3. Mandatory OTP Enforcement
  console.log('\n--- TEST 3: Backend Mandatory OTP Enforcement ---');

  // Case A: Missing OTP -> Must Return 400
  const missingOtpRes = await makeRequest(
    'POST',
    `/api/worker/jobs/${bookingId}/start-job`,
    {},
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(missingOtpRes.status === 400, 'START_JOB with missing OTP is blocked by backend (HTTP 400)');
  testAssert(missingOtpRes.data?.code === 'OTP_REQUIRED', 'Returns code OTP_REQUIRED');

  // Case B: Incorrect OTP -> Must Return 400
  const wrongOtpRes = await makeRequest(
    'POST',
    `/api/worker/jobs/${bookingId}/start-job`,
    { otp: '0000' },
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(wrongOtpRes.status === 400, 'START_JOB with wrong OTP is blocked by backend (HTTP 400)');
  testAssert(wrongOtpRes.data?.code === 'INVALID_OTP', 'Returns code INVALID_OTP');

  // Case C: Correct OTP -> Must Return 200 and start work
  const correctOtpRes = await makeRequest(
    'POST',
    `/api/worker/jobs/${bookingId}/start-job`,
    { otp },
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(correctOtpRes.status === 200, 'START_JOB with correct OTP is accepted (HTTP 200)');
  testAssert(
    correctOtpRes.data?.job?.status === 'InProgress' ||
    correctOtpRes.data?.job?.status === 'In Progress' ||
    correctOtpRes.data?.job?.status === 'WORK_STARTED',
    `Job transitioned to in-progress (${correctOtpRes.data?.job?.status})`
  );

  // 4. Worker Jobs Formatter Validation
  console.log('\n--- TEST 4: Formatted Worker Job Structure & Distance Check ---');
  const jobsRes = await makeRequest(
    'GET',
    '/api/worker/jobs',
    null,
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(jobsRes.status === 200, 'Worker jobs fetched successfully');
  const activeJob = jobsRes.data?.jobs?.find(j => j.id === bookingId || j.bookingId === bookingId);
  testAssert(Boolean(activeJob), 'Active job found in worker jobs list');
  if (activeJob) {
    testAssert(activeJob.date === '2026-09-08', `Canonical date intact: ${activeJob.date}`);
    testAssert(activeJob.slot === '08:00 AM – 10:00 AM', `Canonical slot intact: ${activeJob.slot}`);
    testAssert(activeJob.time === '2026-09-08 • 08:00 AM – 10:00 AM', `Canonical formatted time: ${activeJob.time}`);
    testAssert(!activeJob.address.includes('Near Near'), `No "Near Near" in formatted address: ${activeJob.address}`);
  }

  console.log('\n========================================================================');
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runE2ETests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
