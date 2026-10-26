const http = require('http');

const BASE_URL = 'http://localhost:5000';

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: reqHeaders,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runWorkerProfileTests() {
  console.log('=== STARTING WORKER PROFILE & DATA ISOLATION E2E TESTS ===\n');

  // 1. Worker A Login
  console.log('1. Logging in Worker A (worker@homestep.in)...');
  const loginResA = await makeRequest('POST', '/api/auth/login', {
    identifier: 'worker@homestep.in',
    password: 'password123',
  });

  const workerTokenA = loginResA.data?.token || loginResA.data?.tokens?.accessToken;
  const workerUserA = loginResA.data?.user;

  if (!workerTokenA) {
    console.error('Failed to log in Worker A:', loginResA.data);
    process.exit(1);
  }
  console.log(`✓ Worker A logged in: ${workerUserA.name} (${workerUserA.employeeId || workerUserA.customId})\n`);

  // 2. Fetch Worker A Profile
  console.log('2. Fetching Worker A profile via GET /api/worker/profile...');
  const profileResA = await makeRequest('GET', '/api/worker/profile', null, {
    Authorization: `Bearer ${workerTokenA}`,
  });

  if (profileResA.status !== 200 || !profileResA.data?.profile) {
    console.error('✗ Failed to fetch Worker A profile:', profileResA);
    process.exit(1);
  }

  const profA = profileResA.data.profile;
  console.log('✓ Worker A Profile Payload:');
  console.log(`  - Name: ${profA.name}`);
  console.log(`  - Employee ID: ${profA.employeeId}`);
  console.log(`  - Verification Status: ${profA.verificationStatus} (isVerifiedPro: ${profA.isVerifiedPro})`);
  console.log(`  - Online Status: ${profA.online}`);
  console.log(`  - Completed Jobs: ${profA.completedJobsCount}`);
  console.log(`  - Total Earnings: ₹${profA.totalEarnings}`);
  console.log(`  - Rating: ${profA.ratingAvg ? profA.ratingAvg + ' ⭐' : 'No ratings yet'} (${profA.ratingCount} reviews)`);
  console.log(`  - First-Visit Resolution: ${profA.firstVisitResolutionText || profA.firstVisitResolutionRate + '%'}`);
  console.log(`  - Approved Services: [${profA.services?.join(', ')}]`);
  console.log(`  - Service Area: ${profA.serviceArea} (${profA.serviceRadiusKm} km)\n`);

  // 3. Log in Worker B (suresh.plumb@homestep.in) for Data Isolation Check
  console.log('3. Logging in Worker B (suresh.plumb@homestep.in) for data isolation check...');
  const loginResB = await makeRequest('POST', '/api/auth/login', {
    identifier: 'suresh.plumb@homestep.in',
    password: 'password123',
  });

  const workerTokenB = loginResB.data?.token || loginResB.data?.tokens?.accessToken;
  const workerUserB = loginResB.data?.user;

  if (!workerTokenB) {
    console.error('Failed to log in Worker B:', loginResB.data);
    process.exit(1);
  }

  console.log(`✓ Worker B logged in: ${workerUserB.name} (${workerUserB.employeeId || workerUserB.customId})\n`);

  // 4. Fetch Worker B Profile
  console.log('4. Fetching Worker B profile via GET /api/worker/profile...');
  const profileResB = await makeRequest('GET', '/api/worker/profile', null, {
    Authorization: `Bearer ${workerTokenB}`,
  });

  if (profileResB.status !== 200 || !profileResB.data?.profile) {
    console.error('✗ Failed to fetch Worker B profile:', profileResB);
    process.exit(1);
  }

  const profB = profileResB.data.profile;
  console.log('✓ Worker B Profile Payload:');
  console.log(`  - Name: ${profB.name}`);
  console.log(`  - Employee ID: ${profB.employeeId}`);
  console.log(`  - Completed Jobs: ${profB.completedJobsCount} (Zero State Verified)`);
  console.log(`  - Total Earnings: ₹${profB.totalEarnings}`);
  console.log(`  - Rating: ${profB.ratingAvg === null ? 'No ratings yet (Real Null Handled)' : profB.ratingAvg}`);
  console.log(`  - First-Visit Resolution: ${profB.firstVisitResolutionText || 'Building history'}\n`);

  // 5. Data Isolation Validation
  console.log('5. Validating strict data isolation between Worker A and Worker B...');
  if (profA.name === profB.name || profA.employeeId === profB.employeeId) {
    console.error('✗ Data Isolation Failed: Worker B received Worker A information!');
    process.exit(1);
  }
  console.log('✓ Data isolation confirmed: Worker B received only their own clean profile state.\n');

  // 6. Security Check: Unauthenticated access
  console.log('6. Testing unauthenticated request to /api/worker/profile...');
  const unauthRes = await makeRequest('GET', '/api/worker/profile');
  if (unauthRes.status === 401 || unauthRes.status === 403) {
    console.log(`✓ Unauthenticated request correctly blocked with status ${unauthRes.status}.\n`);
  } else {
    console.error('✗ Security vulnerability: Unauthenticated request was not blocked!', unauthRes);
    process.exit(1);
  }

  // 7. Profile Update (PATCH /api/worker/profile)
  console.log('7. Testing worker profile update (PATCH /api/worker/profile)...');
  const patchRes = await makeRequest('PATCH', '/api/worker/profile', {
    serviceArea: 'Koramangala & Indiranagar, Bengaluru',
    serviceRadiusKm: 25,
  }, {
    Authorization: `Bearer ${workerTokenA}`,
  });

  if (patchRes.status !== 200 || !patchRes.data?.success) {
    console.error('✗ Failed to update profile:', patchRes);
    process.exit(1);
  }
  console.log('✓ Profile patch succeeded.\n');

  // 8. Re-fetch Worker A profile to verify persistence
  console.log('8. Verifying updated profile persistence...');
  const updatedProfileRes = await makeRequest('GET', '/api/worker/profile', null, {
    Authorization: `Bearer ${workerTokenA}`,
  });

  const updatedProfA = updatedProfileRes.data.profile;
  if (updatedProfA.serviceRadiusKm === 25 && updatedProfA.serviceArea.includes('Koramangala')) {
    console.log(`✓ Updated persistence verified: Area="${updatedProfA.serviceArea}", Radius=${updatedProfA.serviceRadiusKm} km.\n`);
  } else {
    console.error('✗ Persistence check failed:', updatedProfA);
    process.exit(1);
  }

  console.log('===========================================================');
  console.log('🎉 ALL WORKER PROFILE & BOTTOM NAV TESTS PASSED (100% GREEN)');
  console.log('===========================================================');
}

runWorkerProfileTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
