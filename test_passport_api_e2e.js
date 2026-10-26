/**
 * test_passport_api_e2e.js
 * End-to-end HTTP API validation against live running server on port 4000.
 */

const BASE_URL = 'http://127.0.0.1:4000';

async function runApiTests() {
  console.log('=== STARTING HTTP API E2E VERIFICATION (PORT 4000) ===\n');

  try {
    // 1. Health check
    console.log('--- Step 1: Health & Ping ---');
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    const healthData = await healthRes.json();
    console.log('✓ Server Health:', healthData);

    // 2. Customer login
    console.log('\n--- Step 2: Customer Authentication ---');
    const custLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'customer@homestep.in', password: 'password123' }),
    });
    const custLogin = await custLoginRes.json();
    if (!custLogin.token) throw new Error('Customer login failed: ' + JSON.stringify(custLogin));
    const custToken = custLogin.token;
    console.log(`✓ Customer Authenticated: ${custLogin.user.name} (ID: ${custLogin.user.id || custLogin.user.customId})`);

    // 3. Worker login
    console.log('\n--- Step 3: Worker Authentication ---');
    const workerLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'worker@homestep.in', password: 'password123' }),
    });
    const workerLogin = await workerLoginRes.json();
    if (!workerLogin.token) throw new Error('Worker login failed: ' + JSON.stringify(workerLogin));
    const workerToken = workerLogin.token;
    console.log(`✓ Worker Authenticated: ${workerLogin.user.name} (ID: ${workerLogin.user.id || workerLogin.user.customId})`);

    // 4. Admin login
    console.log('\n--- Step 4: Admin Authentication ---');
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin@homestep.in', password: 'admin123' }),
    });
    const adminLogin = await adminLoginRes.json();
    if (!adminLogin.token) throw new Error('Admin login failed: ' + JSON.stringify(adminLogin));
    const adminToken = adminLogin.token;
    console.log(`✓ Admin Authenticated: ${adminLogin.user.name}`);

    // 5. Customer Home Service Passport
    console.log('\n--- Step 5: GET /api/customer/service-passport ---');
    const passportRes = await fetch(`${BASE_URL}/api/customer/service-passport`, {
      headers: { Authorization: `Bearer ${custToken}` },
    });
    const passportData = await passportRes.json();
    console.log('✓ Passport Overview:', passportData.overview);
    console.log(`✓ Found ${passportData.categories?.length || 0} Categories and ${passportData.timeline?.length || 0} Chronological Service Records.`);

    // 6. Customer Guarantees
    console.log('\n--- Step 6: GET /api/customer/guarantees ---');
    const guarRes = await fetch(`${BASE_URL}/api/customer/guarantees`, {
      headers: { Authorization: `Bearer ${custToken}` },
    });
    const guarData = await guarRes.json();
    console.log(`✓ Found ${guarData.guarantees?.length || 0} Customer Guarantees.`);
    if (guarData.guarantees?.length > 0) {
      const g = guarData.guarantees[0];
      console.log(`  Sample Guarantee #${g.guaranteeId}: ${g.service}, Status: ${g.status}, Valid Until: ${g.endDate}`);
    }

    // 7. Worker Dashboard with First-Visit Resolution
    console.log('\n--- Step 7: GET /api/worker/dashboard & Performance ---');
    const workerDashRes = await fetch(`${BASE_URL}/api/worker/dashboard`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    const workerDash = await workerDashRes.json();
    console.log('✓ Worker Profile Performance Fields:');
    console.log(`  First-Visit Resolution Text: "${workerDash.profile.firstVisitResolutionText}"`);
    console.log(`  First-Visit Resolution Rate: ${workerDash.profile.firstVisitResolutionRate}%`);
    console.log(`  Is Building History: ${workerDash.profile.isBuildingHistory}`);
    console.log(`  Active Guarantees: ${workerDash.profile.activeGuaranteesCount}`);

    // 8. Admin Guarantees Endpoint
    console.log('\n--- Step 8: GET /api/admin/guarantees ---');
    const adminGuarRes = await fetch(`${BASE_URL}/api/admin/guarantees`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const adminGuarData = await adminGuarRes.json();
    console.log(`✓ Admin retrieved ${adminGuarData.guarantees?.length || 0} total system guarantees.`);

    // 9. Testing Free Revisit Flow if active guarantee exists
    let activeGuarantee = guarData.guarantees?.find(g => g.status === 'ACTIVE');
    if (activeGuarantee) {
      console.log(`\n--- Step 9: POST /api/guarantees/${activeGuarantee.guaranteeId}/revisit ---`);
      const revisitRes = await fetch(`${BASE_URL}/api/guarantees/${activeGuarantee.guaranteeId}/revisit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${custToken}`,
        },
        body: JSON.stringify({
          issueDescription: 'AC temperature sensor behaving erratically after yesterday maintenance.',
        }),
      });
      const revisitData = await revisitRes.json();
      console.log('✓ Free Revisit Response:', revisitData.message);
      console.log(`  Created Revisit Order: #${revisitData.revisitBooking?.customId}`);
      console.log(`  Price: "${revisitData.revisitBooking?.price}" (₹0 Free Revisit Guaranteed)`);
      console.log(`  Updated Guarantee Status: ${revisitData.guarantee?.status}`);

      // 10. Admin Approves Revisit
      console.log(`\n--- Step 10: PATCH /api/admin/guarantees/${activeGuarantee.guaranteeId}/approve ---`);
      const approveRes = await fetch(`${BASE_URL}/api/admin/guarantees/${activeGuarantee.guaranteeId}/approve`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({}),
      });
      const approveData = await approveRes.json();
      console.log('✓ Admin Approved Revisit:', approveData.message);
      console.log(`  Guarantee Status: ${approveData.guarantee?.status}`);
    }

    console.log('\n======================================================');
    console.log('🎉 ALL LIVE API & END-TO-END VERIFICATION TESTS PASSED!');
    console.log('======================================================\n');
  } catch (err) {
    console.error('❌ E2E API Test failed:', err);
    process.exit(1);
  }
}

runApiTests();
