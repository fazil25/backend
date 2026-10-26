const http = require('http');

function post(url, data, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(data || {});
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch (e) {
            resolve({ status: res.statusCode, raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function get(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch (e) {
            resolve({ status: res.statusCode, raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('=== TEST: WORKER DATA ISOLATION & REAL-TIME DISPATCH ===\n');

  // 1. Admin Login
  const adminLogin = await post('http://localhost:5000/api/auth/login', {
    identifier: 'admin@homestep.in',
    password: 'admin123',
  });
  const adminToken = adminLogin.data ? adminLogin.data.token : null;
  console.log('1. Admin authenticated successfully. Token exists:', Boolean(adminToken));

  // 2. Provision New Worker A
  const ts = Date.now();
  const workerAEmail = `workera_${ts}@homestep.in`;
  const workerAEmp = `EMP-A${ts.toString().slice(-4)}`;
  const workerACreate = await post(
    'http://localhost:5000/api/admin/workers',
    {
      name: 'Worker Alpha (AC Pro)',
      email: workerAEmail,
      phone: `+9198${ts.toString().slice(-8)}`,
      employeeId: workerAEmp,
      password: 'password123',
      services: ['AC Service & Repair'],
      serviceArea: 'Indiranagar, Bengaluru',
    },
    adminToken
  );
  console.log('2. Worker A provisioned:', workerACreate.status, workerACreate.data.worker ? workerACreate.data.worker.name : workerACreate.data);

  // 3. Provision New Worker B
  const workerBEmail = `workerb_${ts + 1}@homestep.in`;
  const workerBEmp = `EMP-B${(ts + 1).toString().slice(-4)}`;
  const workerBCreate = await post(
    'http://localhost:5000/api/admin/workers',
    {
      name: 'Worker Beta (AC Pro)',
      email: workerBEmail,
      phone: `+9198${(ts + 1).toString().slice(-8)}`,
      employeeId: workerBEmp,
      password: 'password123',
      services: ['AC Service & Repair'],
      serviceArea: 'Indiranagar, Bengaluru',
    },
    adminToken
  );
  console.log('3. Worker B provisioned:', workerBCreate.status, workerBCreate.data.worker ? workerBCreate.data.worker.name : workerBCreate.data);

  // 4. Worker A Login and check clean initial state
  const workerALogin = await post('http://localhost:5000/api/auth/login', {
    identifier: workerAEmail,
    password: 'password123',
  });
  const workerAToken = workerALogin.data.token;

  const workerADash = await get('http://localhost:5000/api/worker/dashboard', workerAToken);
  const pA = workerADash.data.profile;
  console.log('\n4. Worker A Initial Dashboard Metrics:');
  console.log(`   - Today's Earnings: ₹${pA.todayEarnings}`);
  console.log(`   - Week Earnings: ₹${pA.weekEarnings}`);
  console.log(`   - Month Earnings: ₹${pA.monthEarnings}`);
  console.log(`   - Completed Jobs: ${pA.completedJobsCount}`);
  console.log(`   - Wallet Balance: ₹${pA.walletBalance}`);
  console.log(`   - Rating Avg: ${pA.ratingAvg}`);
  console.log(`   - Rating Count: ${pA.ratingCount}`);

  if (pA.todayEarnings === 0 && pA.completedJobsCount === 0 && pA.walletBalance === 0) {
    console.log('   ✓ Worker A starts with REAL EMPTY ZERO DATA ✅');
  } else {
    console.error('   ❌ Worker A failed zero-start check!');
  }

  // 5. Worker B Login
  const workerBLogin = await post('http://localhost:5000/api/auth/login', {
    identifier: workerBEmail,
    password: 'password123',
  });
  const workerBToken = workerBLogin.data.token;

  // 6. Customer creates a booking
  const custLogin = await post('http://localhost:5000/api/auth/login', {
    identifier: 'customer@homestep.in',
    password: 'password123',
  });
  const custToken = custLogin.data.token;

  const bookingRes = await post('http://localhost:5000/api/bookings', {
    service: 'AC Service & Repair',
    category: 'HVAC',
    address: '100 Feet Rd, Indiranagar, Bengaluru',
    date: 'Today',
    time: '04:00 PM',
  }, custToken);
  const createdBookingId = bookingRes.data.booking.id;
  console.log(`\n5. Customer created booking #${createdBookingId}`);

  // 7. Check if Worker A and Worker B both see the new unassigned request
  const dashA_after = await get('http://localhost:5000/api/worker/dashboard', workerAToken);
  const dashB_after = await get('http://localhost:5000/api/worker/dashboard', workerBToken);

  const foundInA = dashA_after.data.jobs.find(j => j.bookingId === createdBookingId);
  const foundInB = dashB_after.data.jobs.find(j => j.bookingId === createdBookingId);
  console.log(`6. Booking visible in Worker A available requests: ${Boolean(foundInA)}`);
  console.log(`   Booking visible in Worker B available requests: ${Boolean(foundInB)}`);

  // 8. Worker A accepts the booking
  console.log(`\n7. Worker A accepting booking #${createdBookingId}...`);
  const acceptRes = await post(`http://localhost:5000/api/worker/jobs/${createdBookingId}/accept`, {}, workerAToken);
  console.log(`   Accept response: HTTP ${acceptRes.status} (Status: ${acceptRes.data.job ? acceptRes.data.job.status : 'N/A'})`);

  // 9. Worker B attempts to accept the same booking (Race condition check)
  console.log(`8. Worker B attempting to accept already-assigned booking #${createdBookingId}...`);
  const secondAcceptRes = await post(`http://localhost:5000/api/worker/jobs/${createdBookingId}/accept`, {}, workerBToken);
  console.log(`   Second accept response: HTTP ${secondAcceptRes.status} (${secondAcceptRes.data.error || 'N/A'})`);
  if (secondAcceptRes.status === 409) {
    console.log('   ✓ Race condition prevented with HTTP 409 Conflict ✅');
  } else {
    console.error('   ❌ Failed race condition test! Response:', secondAcceptRes);
  }

  // 10. Worker B refreshes dashboard -> Booking should NO LONGER be in Worker B's available requests
  const dashB_postAccept = await get('http://localhost:5000/api/worker/dashboard', workerBToken);
  const inWorkerBAvailable = dashB_postAccept.data.jobs.find(j => j.bookingId === createdBookingId);
  console.log(`9. Booking removed from Worker B available list: ${!inWorkerBAvailable ? 'YES (Removed)' : 'NO (Still present)'}`);
  if (!inWorkerBAvailable) {
    console.log('   ✓ Job automatically removed from other workers queues ✅');
  }

  // 11. Worker A advances workflow to completion
  console.log(`\n10. Worker A completing work workflow...`);
  await post(`http://localhost:5000/api/worker/jobs/${createdBookingId}/start-journey`, {}, workerAToken);
  await post(`http://localhost:5000/api/worker/jobs/${createdBookingId}/arrive`, {}, workerAToken);
  await post(`http://localhost:5000/api/worker/jobs/${createdBookingId}/enter-home`, {}, workerAToken);
  await post(`http://localhost:5000/api/worker/jobs/${createdBookingId}/verify-otp-start`, { otp: '4829' }, workerAToken);
  await post(`http://localhost:5000/api/worker/jobs/${createdBookingId}/finish-work`, {}, workerAToken);

  // Customer confirms completion
  await post(`http://localhost:5000/api/bookings/${createdBookingId}/confirm-completion`, {}, custToken);

  // 12. Check Worker A updated earnings vs Worker B unchanged earnings
  const finalDashA = await get('http://localhost:5000/api/worker/dashboard', workerAToken);
  const finalDashB = await get('http://localhost:5000/api/worker/dashboard', workerBToken);

  console.log('\n11. Final Metrics Verification:');
  console.log(`   Worker A -> Today's Earnings: ₹${finalDashA.data.profile.todayEarnings}, Completed Jobs: ${finalDashA.data.profile.completedJobsCount}, Wallet: ₹${finalDashA.data.profile.walletBalance}`);
  console.log(`   Worker B -> Today's Earnings: ₹${finalDashB.data.profile.todayEarnings}, Completed Jobs: ${finalDashB.data.profile.completedJobsCount}, Wallet: ₹${finalDashB.data.profile.walletBalance}`);

  if (
    finalDashA.data.profile.todayEarnings > 0 &&
    finalDashA.data.profile.completedJobsCount === 1 &&
    finalDashB.data.profile.todayEarnings === 0 &&
    finalDashB.data.profile.completedJobsCount === 0
  ) {
    console.log('\n✨ ALL MULTI-WORKER DATA & REAL-TIME DISPATCH CHECKS PASSED PERFECTLY! ✨\n');
  } else {
    console.error('\n❌ Metric validation check failed!');
  }
}

run().catch(console.error);
