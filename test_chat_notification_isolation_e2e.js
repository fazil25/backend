/**
 * HomeStepIn — Chat Notification Isolation & Recipient Verification Test Suite
 *
 * Verifies:
 * 1. Customer -> Worker: Worker receives notification, Customer receives NO notification.
 * 2. Worker -> Customer: Customer receives notification, Worker receives NO notification.
 * 3. Notification recipient is strictly receiverId, NEVER senderId.
 * 4. WebSocket delivery occurs for chat UI without triggering sender notifications.
 * 5. Multiple messages do not create rogue or self notifications.
 */

const assert = require('assert');
const http = require('http');
const { WebSocket } = require('ws');

const BASE_URL = 'http://127.0.0.1:4000';
const WS_URL = 'ws://127.0.0.1:4000/ws';

async function request(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json };
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    const messages = [];

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      setTimeout(() => resolve({ ws, messages }), 200);
    });

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        messages.push(parsed);
      } catch (e) {}
    });

    ws.on('error', reject);
  });
}

async function runTests() {
  console.log('🧪 ===================================================');
  console.log('🧪 HOMESTEPIN CHAT NOTIFICATION VERIFICATION SUITE');
  console.log('🧪 ===================================================\n');

  const ts = Date.now();

  // 1. Admin login
  console.log('▶ [1] Setting up Admin, Partner, and Customer...');
  const adminLogin = await request('POST', '/api/auth/login', {
    identifier: 'admin@homestep.in',
    password: 'admin123',
  });
  assert(adminLogin.status === 200, 'Admin login must succeed');
  const adminToken = adminLogin.data.token;

  // Create Worker
  const workerRes = await request('POST', '/api/admin/workers', {
    name: 'Rajesh Worker',
    email: `rajesh.${ts}@homestep.in`,
    employeeId: `EMP-${ts.toString().slice(-4)}`,
    password: 'Password123!',
    services: ['AC Service & Repair'],
  }, adminToken);
  assert(workerRes.status === 201, 'Worker creation must succeed');

  const workerLogin = await request('POST', '/api/auth/login', {
    identifier: `rajesh.${ts}@homestep.in`,
    password: 'Password123!',
  });
  assert(workerLogin.status === 200, 'Worker login must succeed');
  const workerToken = workerLogin.data.token;
  const workerUser = workerLogin.data.user;
  console.log(`  ✓ Worker logged in: ${workerUser.name} (${workerUser.id || workerUser._id})`);

  // Create Customer Vino
  const custRegister = await request('POST', '/api/auth/register', {
    name: 'Vino',
    email: `vino.${ts}@homestep.in`,
    phone: `+9198${ts.toString().slice(-8)}`,
    password: 'Password123!',
    role: 'customer',
  });
  assert(custRegister.status === 201 || custRegister.status === 200, 'Customer registration must succeed');
  const custToken = custRegister.data.token;
  const custUser = custRegister.data.user;
  console.log(`  ✓ Customer logged in: ${custUser.name} (${custUser.id || custUser._id})`);

  // 2. Create and Assign Booking
  console.log('\n▶ [2] Creating Booking for Vino & Assigning Rajesh...');
  const bookingCreateRes = await request('POST', '/api/bookings', {
    service: 'AC Service & Repair',
    category: 'AC & Climate',
    address: '12, Main Street, Chennai, Tamil Nadu, 600001',
    house: '12',
    street: 'Main Street',
    area: 'T Nagar',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600001',
    latitude: 13.0827,
    longitude: 80.2707,
    price: '₹499',
    priceNum: 499,
    scheduledDate: 'Tomorrow',
    scheduledTime: '10:00 AM - 11:00 AM',
    date: '2026-10-04',
    slot: '10:00 AM - 11:00 AM',
  }, custToken);
  assert(bookingCreateRes.status === 201 || bookingCreateRes.status === 200, `Booking must be created: ${JSON.stringify(bookingCreateRes.data)}`);
  const bookingId = bookingCreateRes.data.booking.customId || bookingCreateRes.data.booking.id;

  // Admin assigns worker
  const assignRes = await request('POST', `/api/admin/bookings/${bookingId}/assign`, {
    workerId: workerUser.id || workerUser._id || workerUser.sub,
  }, adminToken);
  assert(assignRes.status === 200, `Admin must assign worker: ${JSON.stringify(assignRes.data)}`);
  console.log(`  ✓ Booking created & assigned: ${bookingId}`);

  // 3. Connect both users to WebSocket
  console.log('\n▶ [3] Connecting Vino & Rajesh to WebSocket...');
  const custWs = await connectWs(custToken);
  const workerWs = await connectWs(workerToken);

  custWs.ws.send(JSON.stringify({ type: 'join_room', bookingId, token: custToken }));
  workerWs.ws.send(JSON.stringify({ type: 'join_room', bookingId, token: workerToken }));
  await new Promise(r => setTimeout(r, 400));
  console.log('  ✓ Both sockets connected and joined room');

  // Clear initial frames
  custWs.messages.length = 0;
  workerWs.messages.length = 0;

  // 4. TEST 1: Customer (Vino) sends message -> Worker receives notification, Vino gets NO notification
  console.log('\n▶ [4] TEST 1: Vino (Customer/Sender) sends "hi"...');
  const msg1Res = await request('POST', `/api/bookings/${bookingId}/chat/messages`, {
    text: 'hi',
  }, custToken);
  assert(msg1Res.status === 201, 'Vino message must be created');
  await new Promise(r => setTimeout(r, 500));

  // Verify WebSocket chat message delivery to both
  const custGotNewMsg = custWs.messages.some(m => m.type === 'new_message' && m.message.text === 'hi');
  const workerGotNewMsg = workerWs.messages.some(m => m.type === 'new_message' && m.message.text === 'hi');
  assert(custGotNewMsg, 'Vino WebSocket MUST receive new_message for in-chat UI display');
  assert(workerGotNewMsg, 'Worker WebSocket MUST receive new_message');
  console.log('  ✓ Real-time message delivered to both chat screens');

  // Verify Notification frames (ONLY receiver should get new_notification)
  const custGotNotif = custWs.messages.some(m => m.type === 'new_notification' && m.notification && m.notification.body.includes('hi'));
  const workerGotNotif = workerWs.messages.some(m => m.type === 'new_notification' && m.notification && m.notification.body.includes('hi'));

  assert(!custGotNotif, '❌ BUG: Vino (SENDER) received a popup notification for their own message!');
  assert(workerGotNotif, 'Worker (RECEIVER) must receive the popup notification');
  console.log('  ✓ SENDER (Vino) received NO popup notification ❌');
  console.log('  ✓ RECEIVER (Worker) received popup notification: "Vino: hi" ✅');

  // 5. TEST 2: Worker sends "Your technician will arrive soon" -> Vino receives notification, Worker gets NO notification
  console.log('\n▶ [5] TEST 2: Worker (Sender) sends "Your technician will arrive soon"...');
  custWs.messages.length = 0;
  workerWs.messages.length = 0;

  const msg2Res = await request('POST', `/api/bookings/${bookingId}/chat/messages`, {
    text: 'Your technician will arrive soon',
  }, workerToken);
  assert(msg2Res.status === 201, 'Worker message must be created');
  await new Promise(r => setTimeout(r, 500));

  const custGotMsg2Notif = custWs.messages.some(m => m.type === 'new_notification' && m.notification && m.notification.body.includes('arrive soon'));
  const workerGotMsg2Notif = workerWs.messages.some(m => m.type === 'new_notification' && m.notification && m.notification.body.includes('arrive soon'));

  assert(!workerGotMsg2Notif, '❌ BUG: Worker (SENDER) received a popup notification for their own message!');
  assert(custGotMsg2Notif, 'Vino (RECEIVER) must receive the popup notification');
  console.log('  ✓ SENDER (Worker) received NO popup notification ❌');
  console.log('  ✓ RECEIVER (Vino) received popup notification: "Rajesh Worker: Your technician will arrive soon" ✅');

  // 6. TEST 3: WebSocket chat_message sending (Realtime Socket Channel)
  console.log('\n▶ [6] TEST 3: Vino sends message via WebSocket frame...');
  custWs.messages.length = 0;
  workerWs.messages.length = 0;

  custWs.ws.send(JSON.stringify({
    type: 'chat_message',
    bookingId,
    text: 'I will keep the gate unlocked',
    token: custToken,
  }));
  await new Promise(r => setTimeout(r, 500));

  const custGotWsNotif = custWs.messages.some(m => m.type === 'new_notification' && m.notification && m.notification.body.includes('gate unlocked'));
  const workerGotWsNotif = workerWs.messages.some(m => m.type === 'new_notification' && m.notification && m.notification.body.includes('gate unlocked'));

  assert(!custGotWsNotif, '❌ BUG: Sender received notification on WebSocket message send!');
  assert(workerGotWsNotif, 'Receiver must receive notification on WebSocket message send');
  console.log('  ✓ SENDER (Vino) received NO popup notification on WebSocket send ❌');
  console.log('  ✓ RECEIVER (Worker) received popup notification on WebSocket send ✅');

  // 7. TEST 4: Multiple consecutive messages from Vino
  console.log('\n▶ [7] TEST 4: Vino sends 3 consecutive messages...');
  custWs.messages.length = 0;
  workerWs.messages.length = 0;

  for (let i = 1; i <= 3; i++) {
    await request('POST', `/api/bookings/${bookingId}/chat/messages`, {
      text: `Message #${i}`,
    }, custToken);
  }
  await new Promise(r => setTimeout(r, 600));

  const custNotifsCount = custWs.messages.filter(m => m.type === 'new_notification' && m.notification?.body?.startsWith('Message #')).length;
  const workerNotifsCount = workerWs.messages.filter(m => m.type === 'new_notification' && m.notification?.body?.startsWith('Message #')).length;

  assert(custNotifsCount === 0, `Sender received ${custNotifsCount} self notifications (Expected: 0)`);
  assert(workerNotifsCount === 3, `Receiver received ${workerNotifsCount} notifications (Expected: 3)`);
  console.log(`  ✓ SENDER received ${custNotifsCount} notifications (Target: 0) ❌`);
  console.log(`  ✓ RECEIVER received exactly ${workerNotifsCount} notifications (Target: 3) ✅`);

  // Close sockets
  custWs.ws.close();
  workerWs.ws.close();

  console.log('\n🎉 ALL CHAT NOTIFICATION ISOLATION TESTS PASSED PERFECTLY (100%)!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
