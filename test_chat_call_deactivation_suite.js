const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

// Ensure test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '4005';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/homestepin_test';
const { app, server, startServer, handleGracefulShutdown } = require('./server');
const config = require('./src/config');
const Booking = require('./src/models/Booking');
const User = require('./src/models/User');
const Message = require('./src/models/Message');
const CallSession = require('./src/models/CallSession');

const JWT_SECRET = config.jwtAccessSecret;

function makeRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 4005,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (e) {
            data = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTestSuite() {
  console.log('\n======================================================');
  console.log('  HOMESTEPIN SERVICE CHAT & CALL DEACTIVATION SUITE');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`• ${name} ... `);
    try {
      await fn();
      console.log('PASSED ✓');
      passed++;
    } catch (err) {
      console.log('FAILED ✗');
      console.error(err);
      failed++;
    }
  }

  // 1. Start test server
  await startServer();

  // Test identities
  const custMongoId = new mongoose.Types.ObjectId();
  const workMongoId = new mongoose.Types.ObjectId();

  const custUser = {
    sub: custMongoId.toString(),
    id: custMongoId.toString(),
    customId: 'USR-CUST-DEACT-01',
    name: 'Customer Deact',
    phone: '+919999000001',
    role: 'customer',
  };

  const workUser = {
    sub: workMongoId.toString(),
    id: workMongoId.toString(),
    customId: 'USR-WORK-DEACT-02',
    name: 'Worker Deact',
    phone: '+919999000002',
    role: 'worker',
  };

  const custToken = jwt.sign(custUser, JWT_SECRET, { expiresIn: '1h' });
  const workToken = jwt.sign(workUser, JWT_SECRET, { expiresIn: '1h' });

  // Clean and seed test users
  await User.deleteMany({ _id: { $in: [custMongoId, workMongoId] } });
  await User.create([
    {
      _id: custMongoId,
      customId: custUser.customId,
      name: custUser.name,
      phone: custUser.phone,
      passwordHash: '$2a$10$testpasswordhashfore2etestingcust01',
      role: 'customer',
      status: 'active',
    },
    {
      _id: workMongoId,
      customId: workUser.customId,
      name: workUser.name,
      phone: workUser.phone,
      passwordHash: '$2a$10$testpasswordhashfore2etestingwork02',
      role: 'worker',
      status: 'active',
      walletBalance: 0,
      todayEarnings: 0,
    },
  ]);

  // Clean test fixtures
  await Booking.deleteMany({ customerId: custUser.id });
  await Message.deleteMany({ senderId: { $in: [custUser.id, workUser.id] } });
  await CallSession.deleteMany({ callerId: { $in: [custUser.id, workUser.id] } });

  // Seed two distinct bookings between same customer and worker
  const activeBooking = await Booking.create({
    customId: 'BK-TEST-ACTIVE-101',
    customerId: custUser.id,
    customer: custMongoId,
    customerName: custUser.name,
    customerPhone: custUser.phone,
    providerId: workUser.id,
    worker: workMongoId,
    providerName: workUser.name,
    providerPhone: workUser.phone,
    service: 'AC Jet Deep Service',
    category: 'AC Cleaning',
    address: '123 Test Residency, Bellandur, Bengaluru',
    latitude: 12.9352,
    longitude: 77.6245,
    price: '₹499',
    priceNum: 499,
    status: 'WORK_STARTED',
    chatLocked: false,
  });

  const completeTargetBooking = await Booking.create({
    customId: 'BK-TEST-COMPLETE-202',
    customerId: custUser.id,
    customer: custMongoId,
    customerName: custUser.name,
    customerPhone: custUser.phone,
    providerId: workUser.id,
    worker: workMongoId,
    providerName: workUser.name,
    providerPhone: workUser.phone,
    service: 'Ceiling Fan Repair',
    category: 'Electrical',
    address: '123 Test Residency, Bellandur, Bengaluru',
    latitude: 12.9352,
    longitude: 77.6245,
    price: '₹299',
    priceNum: 299,
    status: 'WORK_STARTED',
    chatLocked: false,
  });

  // ----------------------------------------------------
  // TEST CASES
  // ----------------------------------------------------

  await test('1. Active booking allows sending messages', async () => {
    const res = await makeRequest(
      'POST',
      `/api/bookings/${completeTargetBooking.customId}/chat/messages`,
      { text: 'Hello, please bring an extra capacitor.' },
      custToken
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.message.text, 'Hello, please bring an extra capacitor.');
  });

  await test('2. Active booking returns active conversation status in GET chat', async () => {
    const res = await makeRequest(
      'GET',
      `/api/bookings/${completeTargetBooking.customId}/chat`,
      null,
      custToken
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.conversation.status, 'active');
    assert.strictEqual(res.data.isLocked, false);
    assert(res.data.conversation.messages.length >= 1);
  });

  let activeCallSessionId = null;
  await test('3. Active booking allows initiating an in-app call', async () => {
    const res = await makeRequest(
      'POST',
      `/api/bookings/${completeTargetBooking.customId}/call/initiate`,
      {},
      custToken
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.callSession.status, 'CALL_RINGING');
    activeCallSessionId = res.data.callSession.callSessionId;
    assert(activeCallSessionId);
  });

  await test('4. Transitioning booking to COMPLETED locks chat and closes active calls', async () => {
    // Transition through worker finish-work
    const finishRes = await makeRequest(
      'POST',
      `/api/worker/jobs/${completeTargetBooking.customId}/finish-work`,
      {},
      workToken
    );
    assert.strictEqual(finishRes.status, 200);

    const freshBooking = await Booking.findOne({ customId: completeTargetBooking.customId });
    assert.strictEqual(freshBooking.chatLocked, true);

    // Call session must now be terminated with endReason booking_completed
    const callSession = await CallSession.findOne({ callSessionId: activeCallSessionId });
    assert.strictEqual(callSession.status, 'CALL_ENDED');
    assert.strictEqual(callSession.endReason, 'booking_completed');
  });

  await test('5. COMPLETED booking rejects new message sends with 403 COMMUNICATION_DEACTIVATED', async () => {
    const res = await makeRequest(
      'POST',
      `/api/bookings/${completeTargetBooking.customId}/chat/messages`,
      { text: 'Are you still around?' },
      custToken
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.code, 'COMMUNICATION_DEACTIVATED');
  });

  await test('6. COMPLETED booking rejects new call initiation with 403 COMMUNICATION_DEACTIVATED', async () => {
    const res = await makeRequest(
      'POST',
      `/api/bookings/${completeTargetBooking.customId}/call/initiate`,
      {},
      custToken
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.code, 'COMMUNICATION_DEACTIVATED');
  });

  await test('7. COMPLETED booking GET chat returns inactive and isLocked=true while preserving messages', async () => {
    const res = await makeRequest(
      'GET',
      `/api/bookings/${completeTargetBooking.customId}/chat`,
      null,
      custToken
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.conversation.status, 'inactive');
    assert.strictEqual(res.data.isLocked, true);
    assert.strictEqual(res.data.conversation.isLocked, true);
    // Messages must NOT be permanently erased (preserves historical audit/dispute trail)
    assert(res.data.conversation.messages.length >= 1);
  });

  await test('8. COMPLETED booking preserves Invoice and Rating functionality', async () => {
    const receiptRes = await makeRequest(
      'GET',
      `/api/bookings/${completeTargetBooking.customId}/receipt`,
      null,
      custToken
    );
    assert.strictEqual(receiptRes.status, 200);
    assert.strictEqual(receiptRes.data.receipt.bookingId, completeTargetBooking.customId);

    const rateRes = await makeRequest(
      'POST',
      `/api/bookings/${completeTargetBooking.customId}/rate`,
      { rating: 5, review: 'Fantastic work on the ceiling fan!' },
      custToken
    );
    assert.strictEqual(rateRes.status, 200);
    assert.strictEqual(rateRes.data.success, true);
  });

  await test('9. ISOLATION: Other active booking between same customer & worker remains fully active', async () => {
    // The active booking must still allow chat and calling
    const msgRes = await makeRequest(
      'POST',
      `/api/bookings/${activeBooking.customId}/chat/messages`,
      { text: 'Active AC booking is running smoothly.' },
      custToken
    );
    assert.strictEqual(msgRes.status, 201);

    const chatRes = await makeRequest(
      'GET',
      `/api/bookings/${activeBooking.customId}/chat`,
      null,
      custToken
    );
    assert.strictEqual(chatRes.status, 200);
    assert.strictEqual(chatRes.data.conversation.status, 'active');
    assert.strictEqual(chatRes.data.isLocked, false);

    const callRes = await makeRequest(
      'POST',
      `/api/bookings/${activeBooking.customId}/call/initiate`,
      {},
      custToken
    );
    assert.strictEqual(callRes.status, 200);
    assert.strictEqual(callRes.data.callSession.status, 'CALL_RINGING');
  });

  // Cleanup
  await Booking.deleteMany({ customerId: custUser.id });
  await Message.deleteMany({ senderId: { $in: [custUser.id, workUser.id] } });
  await CallSession.deleteMany({ callerId: { $in: [custUser.id, workUser.id] } });
  await User.deleteMany({ _id: { $in: [custMongoId, workMongoId] } });

  console.log('\n======================================================');
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (server) {
    server.close();
  }
  await mongoose.disconnect();

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTestSuite().catch((e) => {
  console.error('Fatal Test Runner Error:', e);
  process.exit(1);
});
