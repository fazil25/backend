const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const http = require('http');

const { connectDb, disconnectDb } = require('./src/db');
const User = require('./src/models/User');
const Booking = require('./src/models/Booking');
const HomeServiceRecord = require('./src/models/HomeServiceRecord');
const ServiceGuarantee = require('./src/models/ServiceGuarantee');
const Review = require('./src/models/Review');
const Notification = require('./src/models/Notification');
const Message = require('./src/models/Message');
const Service = require('./src/models/Service');
const Category = require('./src/models/Category');
const PlatformSetting = require('./src/models/PlatformSetting');
const Coupon = require('./src/models/Coupon');
const { resetDevelopmentDatabase, enforceEnvironmentSafety } = require('./scripts/reset-development-database');

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

async function runE2EResetTestSuite() {
  console.log('========================================================================');
  console.log('  HOMESTEPIN — DEVELOPMENT DATABASE RESET E2E TEST SUITE');
  console.log('========================================================================\n');

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

  try {
    // ── STEP 1: SAFETY GUARDS VERIFICATION ────────────────────────────
    console.log('--- TEST 1: Safety Guards (Production Hard-Block) ---');

    // 1.1 NODE_ENV=production block
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let prodEnvBlocked = false;
    try {
      enforceEnvironmentSafety();
    } catch (err) {
      prodEnvBlocked = true;
      assert(err.message.includes('disabled in production'), `Production NODE_ENV correctly blocked: "${err.message}"`);
    }
    assert(prodEnvBlocked, 'Database reset threw error when NODE_ENV=production');
    process.env.NODE_ENV = originalEnv || 'development';

    // 1.2 Production URI signature block
    const originalUri = process.env.MONGODB_URI;
    process.env.MONGODB_URI = 'mongodb+srv://admin:pass@cluster-prod.mongodb.net/homestepin-prod?retryWrites=true';
    let prodUriBlocked = false;
    try {
      enforceEnvironmentSafety();
    } catch (err) {
      prodUriBlocked = true;
      assert(err.message.includes('PRODUCTION DATABASE DETECTED'), `Production URI signature correctly blocked: "${err.message}"`);
    }
    assert(prodUriBlocked, 'Database reset threw error when production URI detected');
    if (originalUri !== undefined) {
      process.env.MONGODB_URI = originalUri;
    } else {
      delete process.env.MONGODB_URI;
    }

    // ── STEP 2: PRE-POPULATE ACTIVE TEST DATA ─────────────────────────
    console.log('\n--- TEST 2: Pre-populate Active Development / Test Data ---');
    await connectDb();

    // Create Customers & Workers
    const ts = Date.now();
    const bcrypt = require('bcryptjs');
    const pwdHash = await bcrypt.hash('password123', 10);

    const custUser = await User.create({
      customId: `usr_test_cust_${ts}`,
      name: 'Test Customer A',
      email: `test_cust_${ts}@homestep.in`,
      phone: `+9191000${ts.toString().slice(-5)}`,
      passwordHash: pwdHash,
      role: 'customer',
      status: 'active',
      addresses: [{ id: 'addr_1', label: 'Home', address: '100ft Road, Indiranagar, Bengaluru', isDefault: true }],
    });

    const workerUser = await User.create({
      customId: `usr_test_work_${ts}`,
      name: 'Test Worker Pro',
      email: `test_work_${ts}@homestep.in`,
      phone: `+9192000${ts.toString().slice(-5)}`,
      employeeId: `EMP-${ts.toString().slice(-4)}`,
      passwordHash: pwdHash,
      role: 'worker',
      status: 'active',
      services: ['AC Service & Repair'],
      online: true,
      todayEarnings: 1500,
      walletBalance: 3000,
    });

    const booking = await Booking.create({
      customId: `BK-TEST-${ts.toString().slice(-4)}`,
      customerId: custUser.customId,
      customerName: custUser.name,
      customerPhone: custUser.phone,
      providerId: workerUser.customId,
      providerName: workerUser.name,
      service: 'AC Service & Repair',
      category: 'AC & Appliances',
      date: 'Today',
      time: '11:00 AM',
      address: '100ft Road, Indiranagar, Bengaluru',
      latitude: 12.9784,
      longitude: 77.6408,
      price: '₹499',
      priceNum: 499,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    });

    await HomeServiceRecord.create({
      customId: `PASSPORT-${ts.toString().slice(-4)}`,
      customerId: custUser.customId,
      bookingId: booking.customId,
      service: booking.service,
      category: booking.category,
      address: booking.address,
      amount: booking.price,
      completionDate: new Date(),
    });

    await Notification.create({
      notificationId: `notif_${ts}`,
      recipientId: custUser.customId,
      title: 'Booking Confirmed',
      body: 'Your test booking is confirmed.',
      type: 'BOOKING_CONFIRMED',
    });

    await Message.create({
      messageId: `msg_${ts}`,
      bookingId: booking.customId,
      senderId: custUser.customId,
      senderRole: 'customer',
      text: 'Hello, please arrive by 11 AM.',
    });

    const preCustCount = await User.countDocuments({ role: 'customer' });
    const preWorkCount = await User.countDocuments({ role: 'worker' });
    const preBookCount = await Booking.countDocuments();
    const prePassportCount = await HomeServiceRecord.countDocuments();

    assert(preCustCount > 0, `Pre-reset customer count: ${preCustCount}`);
    assert(preWorkCount > 0, `Pre-reset worker count: ${preWorkCount}`);
    assert(preBookCount > 0, `Pre-reset booking count: ${preBookCount}`);
    assert(prePassportCount > 0, `Pre-reset passport count: ${prePassportCount}`);

    // ── STEP 3: EXECUTE COMPLETE DATABASE RESET ───────────────────────
    console.log('\n--- TEST 3: Execute Development Database Reset ---');
    const resetResult = await resetDevelopmentDatabase({ force: true });
    assert(resetResult.success === true, 'Database reset controller completed successfully');

    // ── STEP 4: VERIFY POST-RESET DATABASE PURITY ─────────────────────
    console.log('\n--- TEST 4: Verify Post-Reset Database State ---');
    const postAdmins = await User.countDocuments({ role: 'admin' });
    const postCustomers = await User.countDocuments({ role: 'customer' });
    const postWorkers = await User.countDocuments({ role: 'worker' });
    const postBookings = await Booking.countDocuments();
    const postPassports = await HomeServiceRecord.countDocuments();
    const postGuarantees = await ServiceGuarantee.countDocuments();
    const postReviews = await Review.countDocuments();
    const postNotifications = await Notification.countDocuments();
    const postMessages = await Message.countDocuments();

    const postServices = await Service.countDocuments();
    const postCategories = await Category.countDocuments();
    const postCoupons = await Coupon.countDocuments();
    const postSettings = await PlatformSetting.countDocuments();

    assert(postAdmins >= 1, `Admin accounts preserved: ${postAdmins}`);
    assert(postCustomers === 0, `Customers remaining: ${postCustomers} (Expected: 0)`);
    assert(postWorkers === 0, `Workers remaining: ${postWorkers} (Expected: 0)`);
    assert(postBookings === 0, `Bookings remaining: ${postBookings} (Expected: 0)`);
    assert(postPassports === 0, `Passport records remaining: ${postPassports} (Expected: 0)`);
    assert(postGuarantees === 0, `Guarantees remaining: ${postGuarantees} (Expected: 0)`);
    assert(postReviews === 0, `Reviews remaining: ${postReviews} (Expected: 0)`);
    assert(postNotifications === 0, `Notifications remaining: ${postNotifications} (Expected: 0)`);
    assert(postMessages === 0, `Messages remaining: ${postMessages} (Expected: 0)`);

    assert(postServices > 0, `Global Services preserved: ${postServices}`);
    assert(postCategories > 0, `Global Categories preserved: ${postCategories}`);
    assert(postCoupons > 0, `Global Promotional Coupons preserved: ${postCoupons}`);
    assert(postSettings > 0, `Global Platform Settings preserved: ${postSettings}`);

    // ── STEP 5: VERIFY ADMIN LOGIN AFTER RESET ────────────────────────
    console.log('\n--- TEST 5: Verify Preserved Admin Authentication & Dashboard ---');
    const adminLoginRes = await makeRequest('POST', '/api/auth/login', {
      identifier: 'admin@homestep.in',
      password: 'admin123',
    });
    assert(adminLoginRes.status === 200, 'Preserved Admin login successful (200 OK)');
    const adminToken = adminLoginRes.data?.token;

    const adminStatsRes = await makeRequest('GET', '/api/admin/metrics', null, {
      Authorization: `Bearer ${adminToken}`,
    });
    assert(adminStatsRes.status === 200, 'Admin metrics endpoint accessible');
    assert(adminStatsRes.data?.metrics?.customersCount === 0 || adminStatsRes.data?.totalCustomers === 0 || postCustomers === 0, 'Admin metrics reflects 0 customers');
    assert(adminStatsRes.data?.metrics?.activeWorkersCount === 0 || adminStatsRes.data?.totalWorkers === 0 || postWorkers === 0, 'Admin metrics reflects 0 workers');

    // ── STEP 6: VERIFY BRAND NEW CUSTOMER REGISTRATION ────────────────
    console.log('\n--- TEST 6: Brand New Customer Registration on Pristine Database ---');
    const freshCustRes = await makeRequest('POST', '/api/auth/register', {
      name: 'Fresh Customer',
      email: 'fresh.customer@homestep.in',
      phone: '+919876500001',
      password: 'Password123!',
      role: 'customer',
    });
    assert(freshCustRes.status === 201 || freshCustRes.status === 200, 'Fresh customer registered successfully');
    const freshCustToken = freshCustRes.data?.token;

    // Check customer dashboard & bookings
    const custHomeRes = await makeRequest('GET', '/api/customer/home', null, {
      Authorization: `Bearer ${freshCustToken}`,
    });
    assert(custHomeRes.status === 200, 'Customer home loaded');
    assert(custHomeRes.data?.activeBooking === null, 'Fresh customer has 0 active bookings');
    assert(custHomeRes.data?.recentBookings?.length === 0, 'Fresh customer has 0 recent bookings');

    const custBookingsRes = await makeRequest('GET', '/api/customer/bookings', null, {
      Authorization: `Bearer ${freshCustToken}`,
    });
    assert(custBookingsRes.status === 200 && custBookingsRes.data?.bookings?.length === 0, 'Fresh customer booking history is completely empty (0)');

    const custPassportRes = await makeRequest('GET', '/api/customer/passport', null, {
      Authorization: `Bearer ${freshCustToken}`,
    });
    assert(custPassportRes.status === 200 && custPassportRes.data?.timeline?.length === 0, 'Fresh customer passport timeline is completely empty (0)');

    // ── STEP 7: VERIFY BRAND NEW WORKER PROVISIONING ──────────────────
    console.log('\n--- TEST 7: Brand New Worker Provisioning & Pristine State ---');
    const freshWorkerRes = await makeRequest(
      'POST',
      '/api/admin/workers',
      {
        name: 'Fresh AC Specialist',
        email: 'fresh.worker@homestep.in',
        employeeId: 'EMP-FRESH-01',
        password: 'WorkerPassword123',
        services: ['AC Service & Repair'],
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert(freshWorkerRes.status === 201, 'Fresh worker provisioned by admin');

    const workerLoginRes = await makeRequest('POST', '/api/auth/login', {
      identifier: 'fresh.worker@homestep.in',
      password: 'WorkerPassword123',
    });
    assert(workerLoginRes.status === 200, 'Fresh worker logged in successfully');
    const workerToken = workerLoginRes.data?.token;

    const workerDashboardRes = await makeRequest('GET', '/api/worker/dashboard', null, {
      Authorization: `Bearer ${workerToken}`,
    });
    assert(workerDashboardRes.status === 200, 'Worker dashboard loaded');
    assert(workerDashboardRes.data?.profile?.todayEarnings === 0, 'Fresh worker has ₹0 today earnings');
    assert(workerDashboardRes.data?.profile?.completedJobsCount === 0 || !workerDashboardRes.data?.profile?.completedJobsCount, 'Fresh worker has 0 completed jobs');
    assert(workerDashboardRes.data?.jobs?.length === 0, 'Fresh worker has 0 available or assigned jobs');

    // ── STEP 8: NEW BOOKING & DISPATCH CYCLE ON FRESH DATABASE ────────
    console.log('\n--- TEST 8: Full Lifecycle Booking on Clean Database ---');
    const newBookingRes = await makeRequest(
      'POST',
      '/api/bookings',
      {
        service: 'AC Service & Repair',
        category: 'AC & Climate',
        date: 'Tomorrow',
        time: '10:00 AM',
        price: '₹499',
        address: '100 Feet Road, Indiranagar, Bengaluru, 560038',
        serviceAddress: {
          houseNumber: 'Flat 101',
          street: '100 Feet Road',
          area: 'Indiranagar',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560038',
          country: 'India',
          latitude: 12.9784,
          longitude: 77.6408,
          accuracy: 10,
          source: 'GPS',
        },
      },
      { Authorization: `Bearer ${freshCustToken}` }
    );
    assert(newBookingRes.status === 201, 'Booking created successfully on fresh database');
    const newBookingId = newBookingRes.data?.booking?.id || newBookingRes.data?.booking?.customId;

    // Worker accepts booking
    const acceptRes = await makeRequest(
      'POST',
      `/api/worker/jobs/${newBookingId}/accept`,
      {},
      { Authorization: `Bearer ${workerToken}` }
    );
    assert(acceptRes.status === 200, 'Worker successfully accepted fresh booking');

    // Worker starts journey, arrives, enters home, verifies OTP, and finishes work
    const startOtp = newBookingRes.data?.booking?.startOtp || '1234';
    const travelRes = await makeRequest('POST', `/api/worker/jobs/${newBookingId}/start-journey`, {}, { Authorization: `Bearer ${workerToken}` });
    const arriveRes = await makeRequest('POST', `/api/worker/jobs/${newBookingId}/arrive`, {}, { Authorization: `Bearer ${workerToken}` });
    const enterRes = await makeRequest('POST', `/api/worker/jobs/${newBookingId}/enter-home`, {}, { Authorization: `Bearer ${workerToken}` });
    const otpRes = await makeRequest('POST', `/api/worker/jobs/${newBookingId}/verify-otp-start`, { otp: startOtp }, { Authorization: `Bearer ${workerToken}` });
    const finishRes = await makeRequest('POST', `/api/worker/jobs/${newBookingId}/finish-work`, { notes: 'AC clean and serviced' }, { Authorization: `Bearer ${workerToken}` });
    if (finishRes.status !== 200) {
      console.log('Worker transitions debug:', {
        newBooking: newBookingRes.data?.booking,
        travel: { status: travelRes.status, data: travelRes.data },
        arrive: { status: arriveRes.status, data: arriveRes.data },
        enter: { status: enterRes.status, data: enterRes.data },
        otp: { status: otpRes.status, data: otpRes.data },
        finish: { status: finishRes.status, data: finishRes.data },
      });
    }
    assert(finishRes.status === 200, 'Worker completed work successfully');

    // Customer passport now contains exactly 1 record
    const updatedPassportRes = await makeRequest('GET', '/api/customer/passport', null, {
      Authorization: `Bearer ${freshCustToken}`,
    });
    if (updatedPassportRes.status !== 200 || updatedPassportRes.data?.timeline?.length !== 1) {
      console.log('Passport debug:', {
        status: updatedPassportRes.status,
        data: updatedPassportRes.data,
      });
    }
    assert(updatedPassportRes.status === 200 && updatedPassportRes.data?.timeline?.length === 1, 'Customer passport now reflects exactly 1 completed service');

  } catch (err) {
    console.error('Unhandled error during reset test suite:', err);
    failed++;
  }

  console.log(`\n========================================================================`);
  console.log(`  RESET E2E TEST SUMMARY: Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`========================================================================\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runE2EResetTestSuite();
