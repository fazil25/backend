const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const http = require('http');
const WebSocket = require('ws');
const assert = require('assert');

const BASE_URL = 'http://127.0.0.1:4000';
const WS_URL = 'ws://127.0.0.1:4000/ws';

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

function createAuthenticatedWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const messages = [];
    let authenticated = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    ws.on('message', (msgStr) => {
      try {
        const parsed = JSON.parse(msgStr);
        messages.push(parsed);
        if (parsed.type === 'auth_success') {
          authenticated = true;
          resolve({ ws, messages });
        }
      } catch (e) {}
    });

    ws.on('error', (err) => {
      if (!authenticated) reject(err);
    });

    setTimeout(() => {
      if (!authenticated) {
        resolve({ ws, messages });
      }
    }, 2000);
  });
}

async function run() {
  console.log('========================================================================');
  console.log('  HOMESTEPIN — CALL SUBSYSTEM BIDIRECTIONAL VERIFICATION TEST');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function testAssert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${testName} ${details ? '(' + details + ')' : ''}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName} ${details ? '(' + details + ')' : ''}`);
      failed++;
    }
  }

  // 1. Auth Setup
  console.log('--- STEP 1: Setting up Admin, Partner and Customer ---');
  const adminLogin = await makeRequest('POST', '/api/auth/login', {
    identifier: 'admin@homestep.in',
    password: 'admin123',
  });
  testAssert(adminLogin.status === 200, 'Admin logged in');
  const adminToken = adminLogin.data?.token;

  const ts = Date.now();
  // Create partner
  const workerRes = await makeRequest(
    'POST',
    '/api/admin/workers',
    {
      name: 'Rajesh Kumar',
      email: `rajesh.kumar.${ts}@homestep.in`,
      employeeId: `EMP-${ts.toString().slice(-4)}`,
      password: 'Password123!',
      services: ['AC Service & Repair'],
    },
    { Authorization: `Bearer ${adminToken}` }
  );
  testAssert(workerRes.status === 201, 'Created Partner Rajesh Kumar');

  const workerLogin = await makeRequest('POST', '/api/auth/login', {
    identifier: `rajesh.kumar.${ts}@homestep.in`,
    password: 'Password123!',
  });
  testAssert(workerLogin.status === 200, 'Partner authenticated');
  const workerToken = workerLogin.data?.token;
  const workerUser = workerLogin.data?.user;

  // Create customer Yacoob
  const custRegister = await makeRequest('POST', '/api/auth/register', {
    name: 'Yacoob',
    email: `yacoob.${ts}@homestep.in`,
    phone: `+9198${ts.toString().slice(-8)}`,
    password: 'Password123!',
    role: 'customer',
  });
  testAssert(custRegister.status === 201 || custRegister.status === 200, 'Customer Yacoob registered');
  const custToken = custRegister.data?.token;
  const custUser = custRegister.data?.user;

  // Create booking for Yacoob
  const bookingRes = await makeRequest(
    'POST',
    '/api/bookings',
    {
      service: 'AC Service & Repair',
      category: 'AC & Climate',
      address: '12, Mosque Street, Tiruchirappalli, Tamil Nadu, 620020',
      house: '12',
      street: 'Mosque Street',
      area: 'Palakkarai',
      city: 'Tiruchirappalli',
      state: 'Tamil Nadu',
      pincode: '620020',
      latitude: 10.790483,
      longitude: 78.704672,
      price: '₹499',
      priceNum: 499,
      scheduledDate: 'Tomorrow',
      scheduledTime: '10:00 AM - 11:00 AM',
      date: '2026-09-12',
      slot: '10:00 AM - 11:00 AM',
    },
    { Authorization: `Bearer ${custToken}` }
  );
  testAssert(bookingRes.status === 201, 'Booking created for Yacoob', JSON.stringify(bookingRes.data || bookingRes.raw));
  const booking = bookingRes.data?.booking;
  const bookingId = booking?.customId || booking?.id;

  // Assign Partner Rajesh Kumar to this booking
  const assignRes = await makeRequest(
    'POST',
    `/api/admin/bookings/${bookingId}/assign`,
    { workerId: workerUser.id || workerUser._id || workerUser.sub },
    { Authorization: `Bearer ${adminToken}` }
  );
  testAssert(assignRes.status === 200, 'Assigned Partner Rajesh to booking');

  // Connect WebSockets
  console.log('\n--- STEP 2: Establishing Authenticated WebSockets ---');
  const custSocketObj = await createAuthenticatedWs(custToken);
  const workerSocketObj = await createAuthenticatedWs(workerToken);
  testAssert(custSocketObj.ws.readyState === WebSocket.OPEN, 'Customer WebSocket connected');
  testAssert(workerSocketObj.ws.readyState === WebSocket.OPEN, 'Partner WebSocket connected');

  // ========================================================================
  // TEST 1: PARTNER -> CUSTOMER CALL
  // ========================================================================
  console.log('\n--- TEST 1: Partner (Rajesh) Calls Customer (Yacoob) ---');
  custSocketObj.messages.length = 0;
  workerSocketObj.messages.length = 0;

  const partnerCallRes = await makeRequest(
    'POST',
    `/api/bookings/${bookingId}/call/initiate`,
    {},
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(partnerCallRes.status === 200, 'Partner initiate call HTTP response 200');
  const session1 = partnerCallRes.data?.callSession;
  testAssert(session1?.status === 'CALL_RINGING', 'CallSession created with CALL_RINGING');
  testAssert(session1?.callee === 'Yacoob', 'Call callee correctly set to Customer (Yacoob)', session1?.callee);
  testAssert(session1?.caller === 'Rajesh Kumar', 'Call caller correctly set to Partner (Rajesh Kumar)', session1?.caller);

  // Wait for Customer WebSocket to receive incoming_call
  await new Promise((r) => setTimeout(r, 600));

  const custIncomingCall = custSocketObj.messages.find((m) => m.type === 'incoming_call');
  testAssert(Boolean(custIncomingCall), 'Customer WebSocket received "incoming_call" event');
  testAssert(custIncomingCall?.callSession?.callerName === 'Rajesh Kumar', 'Incoming call callerName is "Rajesh Kumar"');
  testAssert(custIncomingCall?.callSession?.callerRole === 'worker', 'Incoming call callerRole is "worker"');

  // Customer accepts call
  console.log('\n--- Customer Accepts Call ---');
  const acceptRes = await makeRequest(
    'POST',
    `/api/bookings/${bookingId}/call/${session1.callSessionId}/accept`,
    {},
    { Authorization: `Bearer ${custToken}` }
  );
  testAssert(acceptRes.status === 200 && acceptRes.data?.status === 'CALL_CONNECTED', 'Customer accept returned CALL_CONNECTED');
  testAssert(Boolean(acceptRes.data?.connectedAt), 'ConnectedAt timestamp recorded');

  // Wait for call_connected broadcast
  await new Promise((r) => setTimeout(r, 400));
  const workerConnectedMsg = workerSocketObj.messages.find((m) => m.type === 'call_connected');
  const custConnectedMsg = custSocketObj.messages.find((m) => m.type === 'call_connected');
  testAssert(Boolean(workerConnectedMsg), 'Partner received "call_connected" broadcast');
  testAssert(Boolean(custConnectedMsg), 'Customer received "call_connected" broadcast');

  // Partner ends call
  console.log('\n--- Partner Ends Call ---');
  const endRes = await makeRequest(
    'POST',
    `/api/bookings/${bookingId}/call/${session1.callSessionId}/end`,
    { reason: 'user_ended' },
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(endRes.status === 200 && endRes.data?.status === 'CALL_ENDED', 'Partner end call returned CALL_ENDED');

  await new Promise((r) => setTimeout(r, 400));
  const workerEndedMsg = workerSocketObj.messages.find((m) => m.type === 'call_ended');
  const custEndedMsg = custSocketObj.messages.find((m) => m.type === 'call_ended');
  testAssert(Boolean(workerEndedMsg), 'Partner received "call_ended" broadcast');
  testAssert(Boolean(custEndedMsg), 'Customer received "call_ended" broadcast');

  // ========================================================================
  // TEST 2: CUSTOMER -> PARTNER REGRESSION CHECK
  // ========================================================================
  console.log('\n--- TEST 2: Customer (Yacoob) Calls Partner (Rajesh) [Regression Check] ---');
  custSocketObj.messages.length = 0;
  workerSocketObj.messages.length = 0;

  const custCallRes = await makeRequest(
    'POST',
    `/api/bookings/${bookingId}/call/initiate`,
    {},
    { Authorization: `Bearer ${custToken}` }
  );
  testAssert(custCallRes.status === 200, 'Customer initiate call HTTP response 200');
  const session2 = custCallRes.data?.callSession;
  testAssert(session2?.status === 'CALL_RINGING', 'CallSession created with CALL_RINGING');
  testAssert(session2?.callee === 'Rajesh Kumar', 'Call callee correctly set to Partner (Rajesh Kumar)', session2?.callee);
  testAssert(session2?.caller === 'Yacoob', 'Call caller correctly set to Customer (Yacoob)', session2?.caller);

  await new Promise((r) => setTimeout(r, 600));
  const workerIncomingCall = workerSocketObj.messages.find((m) => m.type === 'incoming_call');
  testAssert(Boolean(workerIncomingCall), 'Partner received "incoming_call" event');
  testAssert(workerIncomingCall?.callSession?.callerName === 'Yacoob', 'Incoming call callerName is "Yacoob"');
  testAssert(workerIncomingCall?.callSession?.callerRole === 'customer', 'Incoming call callerRole is "customer"');

  // Partner accepts
  const workerAcceptRes = await makeRequest(
    'POST',
    `/api/bookings/${bookingId}/call/${session2.callSessionId}/accept`,
    {},
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(workerAcceptRes.status === 200 && workerAcceptRes.data?.status === 'CALL_CONNECTED', 'Partner accept returned CALL_CONNECTED');

  // Customer ends
  const custEndRes = await makeRequest(
    'POST',
    `/api/bookings/${bookingId}/call/${session2.callSessionId}/end`,
    { reason: 'normal' },
    { Authorization: `Bearer ${custToken}` }
  );
  testAssert(custEndRes.status === 200 && custEndRes.data?.status === 'CALL_ENDED', 'Customer end call returned CALL_ENDED');

  // ========================================================================
  // TEST 3: REJECT FLOW (NO TIMER, CALL_REJECTED)
  // ========================================================================
  console.log('\n--- TEST 3: Reject Flow (Partner Calls Customer, Customer Rejects) ---');
  custSocketObj.messages.length = 0;
  workerSocketObj.messages.length = 0;

  const partnerCall3 = await makeRequest(
    'POST',
    `/api/bookings/${bookingId}/call/initiate`,
    {},
    { Authorization: `Bearer ${workerToken}` }
  );
  testAssert(partnerCall3.status === 200, 'Partner initiate call 3');
  const session3 = partnerCall3.data?.callSession;

  await new Promise((r) => setTimeout(r, 600));
  const rejectRes = await makeRequest(
    'POST',
    `/api/bookings/${bookingId}/call/${session3.callSessionId}/end`,
    { reason: 'declined' },
    { Authorization: `Bearer ${custToken}` }
  );
  testAssert(rejectRes.status === 200, 'Customer reject call returned 200');
  testAssert(rejectRes.data?.status === 'CALL_REJECTED', 'Status correctly set to CALL_REJECTED');
  testAssert(rejectRes.data?.durationSeconds === 0, 'Duration is 0 (timer never ran for rejected call)');

  await new Promise((r) => setTimeout(r, 400));
  const partnerEndedReject = workerSocketObj.messages.find((m) => m.type === 'call_ended');
  testAssert(partnerEndedReject?.reason === 'declined', 'Partner received call_ended with reason "declined"');

  // ========================================================================
  // TEST 4: SECURITY & PERMISSIONS
  // ========================================================================
  console.log('\n--- TEST 4: Security & Participant Permissions ---');
  // Create unrelated 3rd party user
  const strangerRegister = await makeRequest('POST', '/api/auth/register', {
    name: 'Stranger Danger',
    email: `stranger.${ts}@homestep.in`,
    phone: `+9197${ts.toString().slice(-8)}`,
    password: 'Password123!',
    role: 'customer',
  });
  const strangerToken = strangerRegister.data?.token;

  const unauthorizedCall = await makeRequest(
    'POST',
    `/api/bookings/${bookingId}/call/initiate`,
    {},
    { Authorization: `Bearer ${strangerToken}` }
  );
  testAssert(unauthorizedCall.status === 403, 'Unauthorized stranger blocked with 403');

  // Clean up WebSockets
  custSocketObj.ws.close();
  workerSocketObj.ws.close();

  console.log('\n========================================================================');
  console.log(`  VERIFICATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
