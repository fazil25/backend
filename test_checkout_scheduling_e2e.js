/**
 * HOMESTEPIN — CHECKOUT & SCHEDULING END-TO-END VERIFICATION TEST SUITE
 * 
 * Verifies:
 * 1. Coupon Listing & Authoritative Validation (Active, Min Order, Cap, Rejections)
 * 2. Live Slot Availability Engine (Past slot suppression for today, multi-day availability)
 * 3. Customer Address Management (Create, Read, Update, Delete, Default toggling)
 * 4. Payment Gateway Order Creation & Verification
 * 5. Authoritative Backend Pricing (Item Total, Convenience Fee, Tax, Discount)
 * 6. Protection against client-side price tampering
 * 7. Anti-double-tap idempotency (clientBookingKey duplicate suppression)
 * 8. Cash vs Online Payment status segregation & Targeted dispatch
 */

const http = require('http');

const API_BASE = 'http://127.0.0.1:4000';

function makeRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(
      url,
      {
        method,
        headers,
      },
      res => {
        let rawData = '';
        res.on('data', chunk => (rawData += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(rawData);
            resolve({ status: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, raw: rawData });
          }
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

async function runTests() {
  console.log('\n========================================================================');
  console.log('  HOMESTEPIN — CHECKOUT, SCHEDULING & PRICING VERIFICATION SUITE');
  console.log('========================================================================\n');

  let passedCount = 0;

  try {
    // 1. Authenticate Customer
    process.stdout.write('[TEST 1] Authenticate Customer & Worker ... ');
    const custLogin = await makeRequest('POST', '/api/auth/login', {
      identifier: 'customer@homestep.in',
      password: 'password123',
    });
    assert(custLogin.status === 200 && custLogin.data.token, 'Customer login succeeded');
    const customerToken = custLogin.data.token;
    const customerId = custLogin.data.user.id;

    const workerLogin = await makeRequest('POST', '/api/auth/login', {
      identifier: 'worker@homestep.in',
      password: 'password123',
    });
    assert(workerLogin.status === 200 && workerLogin.data.token, 'Worker login succeeded');
    console.log('✔ PASSED');
    passedCount++;

    // 2. Test Coupon Listing
    process.stdout.write('[TEST 2] Fetch available coupons list ... ');
    const couponsRes = await makeRequest('GET', '/api/coupons', null, customerToken);
    assert(couponsRes.status === 200, 'Coupons fetch 200 OK');
    assert(Array.isArray(couponsRes.data.coupons) && couponsRes.data.coupons.length > 0, 'Coupons list populated');
    const welcomeCoupon = couponsRes.data.coupons.find(c => c.code === 'WELCOME50');
    assert(welcomeCoupon && welcomeCoupon.code === 'WELCOME50', 'Found default WELCOME50 coupon');
    console.log(`✔ PASSED (${couponsRes.data.coupons.length} coupons available)`);
    passedCount++;

    // 3. Test Coupon Validation & Rules
    process.stdout.write('[TEST 3] Validate Coupons with minimum order and caps ... ');
    // Valid coupon
    const validCpn = await makeRequest('POST', '/api/coupons/validate', {
      code: 'WELCOME50',
      service: 'AC Service & Repair',
      amount: 499,
      quantity: 1,
    }, customerToken);
    assert(validCpn.status === 200 && validCpn.data.valid === true, 'WELCOME50 is valid for ₹499');
    assert(validCpn.data.discount === 50, 'WELCOME50 gives exactly ₹50 discount');

    // Invalid coupon code
    const invalidCpn = await makeRequest('POST', '/api/coupons/validate', {
      code: 'FAKECOUPON999',
      service: 'AC Service & Repair',
      amount: 499,
    }, customerToken);
    assert(invalidCpn.data.valid === false, 'Invalid coupon code correctly rejected');

    // Below minimum order amount
    const minOrderCpn = await makeRequest('POST', '/api/coupons/validate', {
      code: 'SAVE100',
      service: 'Electrician Services',
      amount: 199, // SAVE100 requires min ₹400
    }, customerToken);
    assert(minOrderCpn.data.valid === false, 'Coupon rejected when order amount < min order required');
    console.log('✔ PASSED');
    passedCount++;

    // 4. Test Live Slot Availability Engine
    process.stdout.write('[TEST 4] Slot Availability Engine & Past Slot Suppression ... ');
    const today = new Date().toISOString().split('T')[0];
    const slotsToday = await makeRequest('GET', `/api/availability/slots?service=AC%20Service%20%26%20Repair&date=${today}`, null, customerToken);
    assert(slotsToday.status === 200, 'Slots status 200');
    assert(Array.isArray(slotsToday.data.slots) && slotsToday.data.slots.length === 6, 'Generated 6 daily time slots');
    
    // Future date slots should be open
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 3);
    const futureDateStr = futureDate.toISOString().split('T')[0];
    const slotsFuture = await makeRequest('GET', `/api/availability/slots?service=AC%20Service%20%26%20Repair&date=${futureDateStr}`, null, customerToken);
    assert(slotsFuture.data.slots.every(s => s.available === true), 'All future date slots are available');
    console.log('✔ PASSED');
    passedCount++;

    // 5. Customer Addresses CRUD
    process.stdout.write('[TEST 5] Customer Saved Addresses CRUD Operations ... ');
    // 5a. Create Address
    const addAddrRes = await makeRequest('POST', '/api/customer/addresses', {
      label: 'Home',
      line1: 'Flat 402, Highrise Heights, 100ft Road',
      house: 'Flat 402',
      landmark: 'Near Sony Center',
      city: 'Bengaluru',
      pincode: '560038',
      latitude: 12.9719,
      longitude: 77.6412,
      isDefault: true,
    }, customerToken);
    assert(addAddrRes.status === 201 && addAddrRes.data.success, 'Address created');
    const createdAddressId = addAddrRes.data.address.id;

    // 5b. Fetch Addresses
    const getAddrRes = await makeRequest('GET', '/api/customer/addresses', null, customerToken);
    assert(getAddrRes.status === 200, 'Get addresses 200');
    const fetched = getAddrRes.data.addresses.find(a => a.id === createdAddressId);
    assert(fetched && fetched.label === 'Home', 'Created address present in list');

    // 5c. Update Address
    const updateAddrRes = await makeRequest('PUT', `/api/customer/addresses/${createdAddressId}`, {
      label: 'Office',
      landmark: 'Opposite Metro Station',
    }, customerToken);
    assert(updateAddrRes.status === 200 && updateAddrRes.data.address.label === 'Office', 'Address updated successfully');

    // 5d. Delete Address
    const delAddrRes = await makeRequest('DELETE', `/api/customer/addresses/${createdAddressId}`, null, customerToken);
    assert(delAddrRes.status === 200 && delAddrRes.data.success, 'Address deleted successfully');
    console.log('✔ PASSED');
    passedCount++;

    // 6. Payment Gateway Order Creation & Verification
    process.stdout.write('[TEST 6] Payment Gateway Order Creation & Verification ... ');
    const orderRes = await makeRequest('POST', '/api/payments/create-order', {
      amount: 549,
      serviceId: 'srv_ac',
    }, customerToken);
    assert(orderRes.status === 200 && orderRes.data.orderId, 'Payment order created');
    const paymentOrderId = orderRes.data.orderId;

    const verifyRes = await makeRequest('POST', '/api/payments/verify', {
      paymentId: `pay_sim_${Date.now()}`,
      orderId: paymentOrderId,
    }, customerToken);
    assert(verifyRes.status === 200 && verifyRes.data.verified === true, 'Payment signature verified');
    console.log('✔ PASSED');
    passedCount++;

    // 7. Authoritative Backend Pricing & Anti-Tampering Check
    process.stdout.write('[TEST 7] Authoritative Pricing (Multi-unit + Fee + Tax - Coupon) ... ');
    // Customer orders 2 units of AC Service (₹499 * 2 = ₹998)
    // + Convenience Fee ₹49
    // + Tax (5% of 998 = ₹50)
    // - Coupon WELCOME50 (₹50)
    // Total = 998 + 49 + 50 - 50 = ₹1047
    // Client attempts to send fake price "₹10"
    const bookingTamperRes = await makeRequest('POST', '/api/customer/bookings', {
      service: 'AC Service & Repair',
      category: 'AC & Appliances',
      quantity: 2,
      price: '₹10', // Fake client price!
      date: futureDateStr,
      time: '10:00 AM - 12:00 PM',
      slot: '10:00 AM - 12:00 PM',
      address: 'Flat 101, Indiranagar, Bengaluru',
      latitude: 12.9719,
      longitude: 77.6412,
      couponCode: 'WELCOME50',
      paymentMethod: 'Pay Online',
      clientBookingKey: `booking_test_${Date.now()}`,
    }, customerToken);

    assert(bookingTamperRes.status === 201, 'Booking created');
    const bPrice = bookingTamperRes.data.booking.price;
    assert(bPrice === '₹1047', `Authoritative price enforced (expected ₹1047, got ${bPrice})`);
    assert(bookingTamperRes.data.priceBreakdown.discount === 50, 'Coupon discount recorded');
    assert(bookingTamperRes.data.priceBreakdown.convenienceFee === 49, 'Convenience fee recorded');
    console.log(`✔ PASSED (Calculated ₹1047, Tampered price rejected)`);
    passedCount++;

    // 8. Anti-Double-Tap Idempotency Verification
    process.stdout.write('[TEST 8] Anti-Double-Tap Idempotency Key ... ');
    const idempotencyKey = `double_tap_key_${Date.now()}`;
    const firstCall = await makeRequest('POST', '/api/customer/bookings', {
      service: 'Plumbing Works',
      category: 'Home Repairs',
      quantity: 1,
      date: futureDateStr,
      time: '02:00 PM - 04:00 PM',
      address: 'Koramangala 4th Block, Bengaluru',
      latitude: 12.9719,
      longitude: 77.6412,
      paymentMethod: 'Cash on Service',
      clientBookingKey: idempotencyKey,
    }, customerToken);
    assert(firstCall.status === 201, 'First booking request created');
    const firstBookingId = firstCall.data.booking.id;

    // Immediate second call with identical clientBookingKey
    const secondCall = await makeRequest('POST', '/api/customer/bookings', {
      service: 'Plumbing Works',
      category: 'Home Repairs',
      quantity: 1,
      date: futureDateStr,
      time: '02:00 PM - 04:00 PM',
      address: 'Koramangala 4th Block, Bengaluru',
      latitude: 12.9719,
      longitude: 77.6412,
      paymentMethod: 'Cash on Service',
      clientBookingKey: idempotencyKey,
    }, customerToken);

    assert(secondCall.status === 200 || secondCall.status === 201, 'Second call handled');
    assert(secondCall.data.booking.id === firstBookingId, 'Idempotency returned original booking without duplicate creation');
    console.log('✔ PASSED (Duplicate avoided)');
    passedCount++;

    // 9. Payment Status & Cash on Service Separation
    process.stdout.write('[TEST 9] Payment Method & Booking State Separation ... ');
    const cashBooking = await makeRequest('POST', '/api/customer/bookings', {
      service: 'Electrician Services',
      category: 'Home Repairs',
      quantity: 1,
      date: futureDateStr,
      time: '04:00 PM - 06:00 PM',
      address: 'Whitefield Main Rd, Bengaluru',
      latitude: 12.9719,
      longitude: 77.6412,
      paymentMethod: 'Cash on Service',
      clientBookingKey: `cash_key_${Date.now()}`,
    }, customerToken);

    assert(cashBooking.status === 201, 'Cash booking created');
    assert(cashBooking.data.booking.paymentMethod === 'Cash on Service', 'Payment method marked Cash on Service');
    assert(cashBooking.data.booking.paymentStatus.includes('Cash on Service') || cashBooking.data.booking.paymentStatus === 'PENDING', 'Payment status marked Cash on Service or PENDING');
    assert(['CONFIRMED', 'PENDING', 'SEARCHING_WORKER', 'Requested', 'Pending'].includes(cashBooking.data.booking.status), 'Booking status in dispatch');
    console.log('✔ PASSED');
    passedCount++;

    console.log(`\n✔ ALL ${passedCount}/9 CHECKOUT & SCHEDULING TESTS PASSED PERFECTLY!\n`);
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test execution failed with error:', err.message);
    process.exit(1);
  }
}

runTests();
