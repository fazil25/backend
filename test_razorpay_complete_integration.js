/**
 * HOMESTEPIN — COMPREHENSIVE RAZORPAY PAYMENT INTEGRATION TEST SUITE
 * 
 * Verifies all 20 required scenarios:
 * 1. Authenticated customer creates a valid order.
 * 2. Unauthenticated requests are rejected.
 * 3. Customer cannot pay for another customer's booking.
 * 4. Invalid booking is rejected.
 * 5. Server-side amount calculation is correct (anti-tampering).
 * 6. Missing Razorpay credentials are handled safely (clear 503 error).
 * 7. Invalid signature is rejected (timing-safe HMAC comparison).
 * 8. Valid signature is accepted.
 * 9. Incorrect amount or currency is rejected.
 * 10. Duplicate verification does not duplicate payment records (idempotent).
 * 11. Duplicate webhook events are safe (event ID deduplication).
 * 12. Payment failure does not mark the booking paid.
 * 13. Checkout cancellation does not mark the booking paid.
 * 14. Pending payment remains pending.
 * 15. Successful capture updates the correct payment and booking.
 * 16. Refund requests require authorisation.
 * 17. Duplicate refunds are prevented.
 * 18. Worker cannot change payment status manually.
 * 19. Customer cannot access another customer's payment.
 * 20. Existing authentication and booking tests still pass.
 */

const http = require('http');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { app, server, startServer } = require('./server');
const { connectDb, disconnectDb } = require('./src/db');
const { seedDatabase } = require('./src/seed');
const config = require('./src/config');
const razorpayService = require('./src/services/razorpayService');
const bcrypt = require('bcryptjs');
const User = require('./src/models/User');
const Payment = require('./src/models/Payment');
const Booking = require('./src/models/Booking');
const IdempotencyKey = require('./src/models/IdempotencyKey');

const TEST_PORT = 4099;
const TEST_KEY_ID = 'rzp_test_homestepin_suite';
const TEST_KEY_SECRET = 'secret_test_homestepin_123';
const TEST_WEBHOOK_SECRET = 'whsec_test_homestepin_456';

let serverHandle = null;
let customerToken = null;
let customerId = null;
let otherCustomerToken = null;
let otherCustomerId = null;
let workerToken = null;
let adminToken = null;

function makeRequest(method, path, body = null, token = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const rawBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (rawBody) {
      headers['Content-Length'] = Buffer.byteLength(rawBody);
    }

    const req = http.request(
      `http://127.0.0.1:${TEST_PORT}${path}`,
      { method, headers },
      res => {
        let rawData = '';
        res.on('data', chunk => (rawData += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(rawData);
            resolve({ status: res.statusCode, data: parsed, headers: res.headers });
          } catch (e) {
            resolve({ status: res.statusCode, raw: rawData, headers: res.headers });
          }
        });
      }
    );

    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`\n❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

async function runAllTests() {
  console.log('\n========================================================================');
  console.log('  HOMESTEPIN — RAZORPAY PAYMENT END-TO-END TEST SUITE (20 CASES)');
  console.log('========================================================================\n');

  let passedCount = 0;
  const originalKeyId = config.razorpayKeyId;
  const originalKeySecret = config.razorpayKeySecret;
  const originalWebhookSecret = config.razorpayWebhookSecret;

  // Set test credentials
  config.razorpayKeyId = TEST_KEY_ID;
  config.razorpayKeySecret = TEST_KEY_SECRET;
  config.razorpayWebhookSecret = TEST_WEBHOOK_SECRET;

  // Connect database and seed demo data
  await connectDb();
  await seedDatabase();

  // Start dedicated test server on TEST_PORT
  await new Promise(resolve => {
    serverHandle = app.listen(TEST_PORT, '127.0.0.1', resolve);
  });
  console.log(`[TEST RUNNER] Test server listening on http://127.0.0.1:${TEST_PORT}`);

  // Setup Mock for razorpayService createOrder, fetchPayment, refundPayment
  const originalCreateOrder = razorpayService.createOrder;
  const originalFetchPayment = razorpayService.fetchPayment;
  const originalRefundPayment = razorpayService.refundPayment;

  razorpayService.createOrder = async ({ amount, currency = 'INR', receipt, notes }) => {
    return {
      orderId: `order_mock_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`,
      amount: Number(amount),
      amountInPaise: Math.round(Number(amount) * 100),
      currency,
      receipt,
      status: 'created',
      rawOrder: { id: `order_mock_${Date.now()}` },
    };
  };

  razorpayService.fetchPayment = async paymentId => {
    const paymentRecord = (await Payment.findOne({
      $or: [{ razorpayPaymentId: paymentId }, { paymentId }, { customId: paymentId }],
    })) || (await Payment.findOne().sort({ createdAt: -1 }));

    return {
      id: paymentId,
      order_id: paymentRecord?.razorpayOrderId || paymentRecord?.orderId,
      amount: Math.round((paymentRecord?.amount || 499) * 100),
      currency: paymentRecord?.currency || 'INR',
      status: 'captured',
      method: 'upi',
    };
  };

  razorpayService.refundPayment = async ({ paymentId, amount }) => {
    return {
      refundId: `rfnd_mock_${Date.now()}`,
      paymentId,
      amount: amount || 499,
      currency: 'INR',
      status: 'processed',
    };
  };

  try {
    // 0. Setup Test Users
    console.log('[SETUP] Logging in customer, other customer, worker, and admin...');
    const cust1 = await makeRequest('POST', '/api/auth/login', {
      identifier: 'customer@homestep.in',
      password: 'password123',
      bypass2fa: true,
    });
    assert(cust1.status === 200, 'Customer 1 login succeeded');
    customerToken = cust1.data.token;
    customerId = cust1.data.user.id;

    const passwordHash = await bcrypt.hash('password123', 10);
    const otherUser = await User.create({
      name: 'Another Customer',
      email: `other_${Date.now()}@test.com`,
      phone: `+919999${Math.floor(100000 + Math.random() * 900000)}`,
      passwordHash,
      role: 'customer',
      emailVerified: true,
      phoneVerified: true,
      isActive: true,
    });
    otherCustomerId = otherUser._id.toString();

    const cust2Login = await makeRequest('POST', '/api/auth/login', {
      identifier: otherUser.email,
      password: 'password123',
      bypass2fa: true,
    });
    assert(cust2Login.status === 200, 'Customer 2 login succeeded');
    otherCustomerToken = cust2Login.data.token;

    const workerLogin = await makeRequest('POST', '/api/auth/login', {
      identifier: 'worker@homestep.in',
      password: 'password123',
      bypass2fa: true,
    });
    assert(workerLogin.status === 200, 'Worker login succeeded');
    workerToken = workerLogin.data.token;

    const adminLogin = await makeRequest('POST', '/api/auth/login', {
      identifier: 'admin@homestep.in',
      password: 'admin123',
      bypass2fa: true,
    });
    assert(adminLogin.status === 200, 'Admin login succeeded');
    adminToken = adminLogin.data.token;
    console.log('✔ SETUP COMPLETE\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 1] Authenticated customer creates a valid order
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 1] Authenticated customer creates a valid order ... ');
    const order1 = await makeRequest('POST', '/api/payments/create-order', {
      serviceName: 'Deep Cleaning',
      amount: 899,
    }, customerToken);
    assert(order1.status === 200, `Expected 200, got ${order1.status}`);
    assert(order1.data.orderId && order1.data.orderId.startsWith('order_mock_'), 'Order ID returned');
    assert(order1.data.amount > 0 && order1.data.amountInPaise === Math.round(order1.data.amount * 100), 'Order amount matches');
    assert(order1.data.keyId === TEST_KEY_ID, 'Public Key ID returned');
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 2] Unauthenticated requests are rejected
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 2] Unauthenticated order creation and verification are rejected ... ');
    const unauthOrder = await makeRequest('POST', '/api/payments/create-order', {
      serviceName: 'Electrician Services',
      amount: 499,
    }, null); // No token
    assert(unauthOrder.status === 401, `Expected 401 for unauthenticated order creation, got ${unauthOrder.status}`);

    const unauthVerify = await makeRequest('POST', '/api/payments/verify', {
      orderId: 'order_fake_123',
      paymentId: 'pay_fake_123',
      signature: 'sig_fake',
    }, null);
    assert(unauthVerify.status === 401, `Expected 401 for unauthenticated verify, got ${unauthVerify.status}`);
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 3] Customer cannot pay for another customer's booking
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 3] Customer cannot pay for another customer\'s booking ... ');
    // Create booking owned by Customer 1
    const bkCust1 = await makeRequest('POST', '/api/customer/bookings', {
      service: 'Plumbing Works',
      category: 'Home Repairs',
      quantity: 1,
      date: '2026-11-01',
      time: '10:00 AM - 12:00 PM',
      address: 'Flat 101, Indiranagar, Bengaluru',
      latitude: 12.9719,
      longitude: 77.6412,
      paymentMethod: 'Pay Online',
    }, customerToken);
    assert(bkCust1.status === 201, 'Customer 1 booking created');
    const cust1BookingId = bkCust1.data.booking.id;

    // Customer 2 attempts to create payment order for Customer 1's booking
    const stolenOrderAttempt = await makeRequest('POST', '/api/payments/create-order', {
      bookingId: cust1BookingId,
    }, otherCustomerToken);
    assert(stolenOrderAttempt.status === 403, `Expected 403 for unauthorized booking payment, got ${stolenOrderAttempt.status}`);
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 4] Invalid booking is rejected
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 4] Invalid booking is rejected ... ');
    const invalidBkAttempt = await makeRequest('POST', '/api/payments/create-order', {
      bookingId: 'BK-NONEXISTENT-99999',
    }, customerToken);
    assert(invalidBkAttempt.status === 404, `Expected 404 for nonexistent booking, got ${invalidBkAttempt.status}`);
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 5] Server-side amount calculation is correct (anti-tampering)
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 5] Server-side price calculation enforced (tampered amount ignored) ... ');
    // Customer 1 attempts to create order with tampered client amount '₹1' for booking priced at authoritative total
    const legitimateOrder = await makeRequest('POST', '/api/payments/create-order', {
      bookingId: cust1BookingId,
      amount: 1, // Tampered price attempt
    }, customerToken);
    assert(legitimateOrder.status === 200, 'Legitimate order call successful');
    assert(legitimateOrder.data.amount === bkCust1.data.booking.priceNum, `Price matches authoritative total (₹${bkCust1.data.booking.priceNum}), tampered ₹1 ignored`);
    console.log(`✔ PASSED (Authoritative ₹${legitimateOrder.data.amount} enforced)`);
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 6] Missing Razorpay credentials are handled safely
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 6] Missing Razorpay credentials handled safely (503 response) ... ');
    // Temporarily clear config credentials
    config.razorpayKeyId = '';
    config.razorpayKeySecret = '';
    const missingCredsOrder = await makeRequest('POST', '/api/payments/create-order', {
      bookingId: cust1BookingId,
    }, customerToken);
    assert(missingCredsOrder.status === 503, `Expected 503 for missing credentials, got ${missingCredsOrder.status}`);
    assert(missingCredsOrder.data.code === 'RAZORPAY_NOT_CONFIGURED', 'Error code RAZORPAY_NOT_CONFIGURED returned');

    // Restore test credentials
    config.razorpayKeyId = TEST_KEY_ID;
    config.razorpayKeySecret = TEST_KEY_SECRET;
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 7] Invalid signature is rejected
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 7] Invalid signature is rejected ... ');
    const testOrderId = legitimateOrder.data.orderId;
    const testPaymentId = `pay_test_${Date.now()}`;
    const invalidSignature = 'invalid_tampered_signature_hex_0000000000000000000000000000000000000000000000000000000000000000';

    const invalidVerifyRes = await makeRequest('POST', '/api/payments/verify', {
      orderId: testOrderId,
      paymentId: testPaymentId,
      signature: invalidSignature,
      bookingId: cust1BookingId,
    }, customerToken);
    assert(invalidVerifyRes.status === 400, `Expected 400 for invalid signature, got ${invalidVerifyRes.status}`);
    assert(invalidVerifyRes.data.code === 'INVALID_SIGNATURE', 'Error code INVALID_SIGNATURE returned');
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 8] Valid signature is accepted
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 8] Valid cryptographic signature is accepted ... ');
    const validSignature = crypto
      .createHmac('sha256', TEST_KEY_SECRET)
      .update(`${testOrderId}|${testPaymentId}`)
      .digest('hex');

    const validVerifyRes = await makeRequest('POST', '/api/payments/verify', {
      orderId: testOrderId,
      paymentId: testPaymentId,
      signature: validSignature,
      bookingId: cust1BookingId,
    }, customerToken);
    assert(validVerifyRes.status === 200, `Expected 200 for valid signature, got ${validVerifyRes.status}`);
    assert(validVerifyRes.data.verified === true, 'Verification true');
    assert(validVerifyRes.data.status === 'PAID', 'Status is PAID');
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 9] Incorrect amount or currency is rejected
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 9] Incorrect amount or currency is rejected ... ');
    const mismatchOrder = await makeRequest('POST', '/api/payments/create-order', {
      serviceName: 'Full Deep Cleaning',
    }, customerToken);
    assert(mismatchOrder.status === 200, 'Order created for mismatch test');
    const mismatchOrderId = mismatchOrder.data.orderId;
    const mismatchPaymentId = `pay_mismatch_${Date.now()}`;
    const mismatchSig = crypto
      .createHmac('sha256', TEST_KEY_SECRET)
      .update(`${mismatchOrderId}|${mismatchPaymentId}`)
      .digest('hex');

    const prevFetch = razorpayService.fetchPayment;
    razorpayService.fetchPayment = async () => ({
      id: mismatchPaymentId,
      order_id: mismatchOrderId,
      amount: 9999999, // Mismatched amount
      currency: 'INR',
      status: 'captured',
    });

    const mismatchRes = await makeRequest('POST', '/api/payments/verify', {
      orderId: mismatchOrderId,
      paymentId: mismatchPaymentId,
      signature: mismatchSig,
    }, customerToken);
    assert(mismatchRes.status === 400, `Expected 400 for amount mismatch, got ${mismatchRes.status}`);
    assert(mismatchRes.data.code === 'AMOUNT_MISMATCH', 'Error code AMOUNT_MISMATCH returned');

    razorpayService.fetchPayment = prevFetch;
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 10] Duplicate verification does not duplicate payment records (Idempotent)
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 10] Duplicate verification is idempotent and safe ... ');
    const initialPaymentCount = await Payment.countDocuments({ razorpayOrderId: testOrderId });
    const duplicateVerifyRes = await makeRequest('POST', '/api/payments/verify', {
      orderId: testOrderId,
      paymentId: testPaymentId,
      signature: validSignature,
      bookingId: cust1BookingId,
    }, customerToken);
    assert(duplicateVerifyRes.status === 200 && duplicateVerifyRes.data.verified === true, 'Duplicate call returned 200 success');
    const finalPaymentCount = await Payment.countDocuments({ razorpayOrderId: testOrderId });
    assert(initialPaymentCount === finalPaymentCount, 'No duplicate Payment document created');
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 11] Duplicate webhook events are safe (event ID deduplication)
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 11] Webhook signature verification and event deduplication ... ');
    const webhookEventId = `evt_test_${Date.now()}`;
    const webhookPayload = JSON.stringify({
      entity: 'event',
      account_id: 'acc_test',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: testPaymentId,
            entity: 'payment',
            amount: 54900,
            currency: 'INR',
            status: 'captured',
            order_id: testOrderId,
            method: 'upi',
          },
        },
      },
    });

    const webhookSignature = crypto
      .createHmac('sha256', TEST_WEBHOOK_SECRET)
      .update(webhookPayload)
      .digest('hex');

    // First delivery of webhook
    const wh1 = await makeRequest('POST', '/api/payments/webhook', webhookPayload, null, {
      'x-razorpay-signature': webhookSignature,
      'x-razorpay-event-id': webhookEventId,
    });
    assert(wh1.status === 200, `Expected 200 for webhook, got ${wh1.status}`);

    // Duplicate delivery of identical webhook event
    const wh2 = await makeRequest('POST', '/api/payments/webhook', webhookPayload, null, {
      'x-razorpay-signature': webhookSignature,
      'x-razorpay-event-id': webhookEventId,
    });
    assert(wh2.status === 200, `Expected 200 for duplicate webhook, got ${wh2.status}`);
    assert(wh2.data.message === 'Event already processed', 'Deduplication caught event');
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 12] Payment failure does not mark the booking paid
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 12] Payment failure webhook does not mark booking paid ... ');
    const failedBk = await makeRequest('POST', '/api/customer/bookings', {
      service: 'Carpentry & Woodwork',
      category: 'Home Repairs',
      quantity: 1,
      date: '2026-11-02',
      time: '02:00 PM - 04:00 PM',
      address: 'Flat 202, Koramangala, Bengaluru',
      latitude: 12.9352,
      longitude: 77.6245,
      paymentMethod: 'Pay Online',
    }, customerToken);
    const failedBookingId = failedBk.data.booking.id;

    const failedOrder = await makeRequest('POST', '/api/payments/create-order', {
      bookingId: failedBookingId,
    }, customerToken);
    const failedOrderId = failedOrder.data.orderId;

    const failEventId = `evt_fail_${Date.now()}`;
    const failPayload = JSON.stringify({
      entity: 'event',
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: `pay_fail_${Date.now()}`,
            order_id: failedOrderId,
            amount: 49900,
            currency: 'INR',
            status: 'failed',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Payment was declined by customer bank.',
          },
        },
      },
    });
    const failSig = crypto.createHmac('sha256', TEST_WEBHOOK_SECRET).update(failPayload).digest('hex');

    await makeRequest('POST', '/api/payments/webhook', failPayload, null, {
      'x-razorpay-signature': failSig,
      'x-razorpay-event-id': failEventId,
    });

    const failedBkCheck = await Booking.findOne({ customId: failedBookingId });
    assert(failedBkCheck.paymentStatus !== 'PAID', `Booking must not be marked PAID (actual: ${failedBkCheck.paymentStatus})`);
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 13] Checkout cancellation does not mark the booking paid
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 13] Checkout cancellation leaves booking unpaid ... ');
    const cancelBk = await makeRequest('POST', '/api/customer/bookings', {
      service: 'Painting Works',
      category: 'Home Decor',
      quantity: 1,
      date: '2026-11-03',
      time: '11:00 AM - 01:00 PM',
      address: 'House 55, HSR Layout, Bengaluru',
      latitude: 12.9121,
      longitude: 77.6446,
      paymentMethod: 'Pay Online',
    }, customerToken);
    const cancelBookingId = cancelBk.data.booking.id;

    // Simulate order created, then customer cancelled modal (never verified)
    await makeRequest('POST', '/api/payments/create-order', {
      bookingId: cancelBookingId,
    }, customerToken);

    const cancelBkCheck = await Booking.findOne({ customId: cancelBookingId });
    assert(cancelBkCheck.paymentStatus === 'PENDING', `Payment status remains PENDING on dismissal (actual: ${cancelBkCheck.paymentStatus})`);
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 14] Pending payment remains pending
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 14] Pending payment status is inspectable and stays PENDING ... ');
    const pendingPaymentRec = await Payment.findOne({ bookingId: cancelBookingId });
    assert(pendingPaymentRec && pendingPaymentRec.status === 'CREATED', 'Payment status is CREATED/PENDING');

    const statusCheck = await makeRequest('GET', `/api/payments/${pendingPaymentRec.customId}/status`, null, customerToken);
    assert(statusCheck.status === 200, 'Status endpoint 200 OK');
    assert(statusCheck.data.status === 'CREATED', 'Status returned is CREATED');
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 15] Successful capture updates the correct payment and booking
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 15] Successful capture updates booking and payment state ... ');
    const targetBooking = await Booking.findOne({ customId: cust1BookingId });
    const targetPayment = await Payment.findOne({ razorpayOrderId: testOrderId });
    assert(targetBooking.paymentStatus === 'PAID', 'Booking paymentStatus is PAID');
    assert(targetPayment.status === 'PAID', 'Payment record status is PAID');
    assert(targetPayment.paidAt != null, 'paidAt timestamp recorded');
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 16] Refund requests require authorisation
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 16] Refund requests require authorisation ... ');
    const unauthorizedRefund = await makeRequest('POST', '/api/payments/refund', {
      bookingId: cust1BookingId,
    }, otherCustomerToken); // Customer 2 tries to refund Customer 1's payment
    assert(unauthorizedRefund.status === 403, `Expected 403 for unauthorized refund, got ${unauthorizedRefund.status}`);
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 17] Duplicate refunds are prevented
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 17] Duplicate refunds are prevented ... ');
    // Admin processes first refund
    const refund1 = await makeRequest('POST', '/api/admin/financials/refund', {
      bookingId: cust1BookingId,
      reason: 'Quality issue verified',
    }, adminToken);
    assert(refund1.status === 200, `Expected 200 for initial refund, got ${refund1.status}`);

    // Admin attempts to refund the exact same already-refunded payment
    const duplicateRefund = await makeRequest('POST', '/api/admin/financials/refund', {
      bookingId: cust1BookingId,
      reason: 'Accidental second refund attempt',
    }, adminToken);
    assert(duplicateRefund.status === 400, `Expected 400 for duplicate refund, got ${duplicateRefund.status}`);
    assert(duplicateRefund.data.code === 'ALREADY_REFUNDED', 'Error code ALREADY_REFUNDED returned');
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 18] Worker cannot change payment status manually
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 18] Worker cannot manually change payment status ... ');
    const workerTamperAttempt = await makeRequest('POST', '/api/payments/verify', {
      orderId: 'order_worker_hack',
      paymentId: 'pay_worker_hack',
      signature: 'sig_worker_hack',
    }, workerToken); // Workers do not have 'customer' or 'admin' role
    assert(workerTamperAttempt.status === 403, `Expected 403 for worker role, got ${workerTamperAttempt.status}`);
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 19] Customer cannot access another customer's payment status
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 19] Customer cannot access another customer\'s payment status ... ');
    const privacyCheck = await makeRequest('GET', `/api/payments/${targetPayment.customId}/status`, null, otherCustomerToken);
    assert(privacyCheck.status === 403, `Expected 403 for other customer viewing payment, got ${privacyCheck.status}`);
    console.log('✔ PASSED');
    passedCount++;

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 20] Existing authentication and booking tests still pass
    // ──────────────────────────────────────────────────────────────────────────
    process.stdout.write('[TEST 20] Existing authentication and booking endpoints function properly ... ');
    const meRes = await makeRequest('GET', '/api/auth/me', null, customerToken);
    assert(meRes.status === 200 && meRes.data.user.id === customerId, 'Auth /me works');

    const bkListRes = await makeRequest('GET', '/api/customer/bookings', null, customerToken);
    assert(bkListRes.status === 200 && Array.isArray(bkListRes.data.bookings), 'Customer bookings list works');
    console.log('✔ PASSED');
    passedCount++;

    console.log('\n========================================================================');
    console.log(`  ALL 20 RAZORPAY INTEGRATION TESTS PASSED! (${passedCount}/20)`);
    console.log('========================================================================\n');
  } finally {
    // Restore original config
    config.razorpayKeyId = originalKeyId;
    config.razorpayKeySecret = originalKeySecret;
    config.razorpayWebhookSecret = originalWebhookSecret;
    razorpayService.createOrder = originalCreateOrder;
    razorpayService.fetchPayment = originalFetchPayment;
    razorpayService.refundPayment = originalRefundPayment;

    if (serverHandle) {
      serverHandle.close();
    }
  }
}

if (require.main === module) {
  runAllTests()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('\n❌ TEST RUNNER ERROR:', err);
      process.exit(1);
    });
}

module.exports = { runAllTests };
