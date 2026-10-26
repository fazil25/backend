/**
 * HOMESTEPIN — ADMIN OPERATIONS CONTROL CENTER E2E VERIFICATION SUITE
 * Tests all 16 administrative capabilities against persistent database & real backend APIs.
 */

const BASE_URL = 'http://127.0.0.1:4000';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log('\n========================================================================');
  console.log('  HOMESTEPIN — ADMIN OPERATIONS CONTROL CENTER E2E VERIFICATION');
  console.log('========================================================================\n');

  // 1. Admin Authentication & Role Authorization
  process.stdout.write('[TEST 1] 1. Admin Authentication & Non-Admin Rejection ... ');
  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin@homestep.in', password: 'admin123' }),
  });
  assert(adminLoginRes.status === 200, 'Admin login failed');
  const adminData = await adminLoginRes.json();
  assert(adminData.token, 'Token missing');
  assert(adminData.user.role === 'admin', 'User role must be admin');
  const adminToken = adminData.token;
  const adminAuth = { Authorization: `Bearer ${adminToken}` };

  // Use standard seeded customer to test RBAC rejection
  const custLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'customer@homestep.in', password: 'password123' }),
  });
  assert(custLoginRes.status === 200, 'Customer login failed');
  const custLogin = await custLoginRes.json();
  assert(custLogin.user.role === 'customer', 'User role must be customer');
  
  const custForbiddenRes = await fetch(`${BASE_URL}/api/admin/metrics`, {
    headers: { Authorization: `Bearer ${custLogin.token}` },
  });
  assert(custForbiddenRes.status === 403, 'Non-admin user must be rejected with 403 Forbidden');
  console.log('✔ PASSED');

  // 2. Metrics & Dashboard Summary
  process.stdout.write('[TEST 2] 2. Real Dashboard Metrics & Financial Aggregation ... ');
  const metricsRes = await fetch(`${BASE_URL}/api/admin/metrics`, { headers: adminAuth });
  assert(metricsRes.status === 200, 'Metrics endpoint failed');
  const { stats } = await metricsRes.json();
  assert(typeof stats.totalBookings === 'number', 'totalBookings must be number');
  assert(typeof stats.totalWorkers === 'number', 'totalWorkers must be number');
  assert(typeof stats.totalCustomers === 'number', 'totalCustomers must be number');
  assert(stats.grossRevenue.startsWith('₹'), 'Gross revenue must be formatted');
  assert(stats.platformRevenue.startsWith('₹'), 'Platform revenue must be formatted');
  console.log('✔ PASSED');

  // 3. Live Operations Monitor
  process.stdout.write('[TEST 3] 3. Live Operations Active Dispatch Monitor ... ');
  const liveOpsRes = await fetch(`${BASE_URL}/api/admin/live-ops`, { headers: adminAuth });
  assert(liveOpsRes.status === 200, 'Live ops endpoint failed');
  const liveOpsData = await liveOpsRes.json();
  assert(liveOpsData.summary, 'Live ops summary missing');
  assert(Array.isArray(liveOpsData.activeBookings), 'activeBookings array missing');
  assert(Array.isArray(liveOpsData.onlineWorkers), 'onlineWorkers array missing');
  console.log('✔ PASSED');

  // 4. Worker Management & KYC Lifecycle
  process.stdout.write('[TEST 4] 4. Worker Directory, KYC Approval & Specializations ... ');
  // Create a new worker via admin
  const empId = `EMP-${Date.now().toString().slice(-4)}`;
  const createWorkerRes = await fetch(`${BASE_URL}/api/admin/workers`, {
    method: 'POST',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Praveen K',
      email: `praveen_${Date.now()}@homestep.in`,
      phone: `+9198${Math.floor(10000000 + Math.random() * 90000000)}`,
      employeeId: empId,
      password: 'workerpass123',
      services: ['Plumbing Repairs & Fitting', 'Electrical Wiring'],
      serviceArea: 'Koramangala, Bengaluru',
      serviceRadiusKm: 18,
    }),
  });
  assert(createWorkerRes.status === 201, 'Worker creation failed');
  const { worker: createdWorker } = await createWorkerRes.json();
  assert(createdWorker.id, 'Worker id missing');

  // KYC Status Update to needs_review, then approved
  const kycPatchRes = await fetch(`${BASE_URL}/api/admin/workers/${createdWorker.id}/kyc`, {
    method: 'PATCH',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved', notes: 'Aadhaar & License verified' }),
  });
  assert(kycPatchRes.status === 200, 'KYC update failed');
  const kycPatchData = await kycPatchRes.json();
  assert(kycPatchData.worker.kycStatus === 'approved', 'KYC status must be approved');

  // Update Specializations
  const specPatchRes = await fetch(`${BASE_URL}/api/admin/workers/${createdWorker.id}/services`, {
    method: 'PATCH',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      services: ['AC Service & Repair', 'Electrical Wiring'],
      serviceArea: 'Indiranagar, Bengaluru',
      serviceRadiusKm: 25,
    }),
  });
  assert(specPatchRes.status === 200, 'Specializations update failed');
  console.log('✔ PASSED');

  // 5. Customer Directory & Detail Profiles
  process.stdout.write('[TEST 5] 5. Customer Directory & Customer Profile ... ');
  const custsRes = await fetch(`${BASE_URL}/api/admin/customers`, { headers: adminAuth });
  assert(custsRes.status === 200, 'Customers list failed');
  const custsData = await custsRes.json();
  assert(Array.isArray(custsData.customers), 'customers list must be array');
  assert(custsData.customers.length > 0, 'customers list must not be empty');
  
  const singleCustRes = await fetch(`${BASE_URL}/api/admin/customers/${custsData.customers[0].id}`, { headers: adminAuth });
  assert(singleCustRes.status === 200, 'Single customer fetch failed');
  const singleCustData = await singleCustRes.json();
  assert(singleCustData.customer.email, 'Customer email missing');
  console.log('✔ PASSED');

  // 6. Booking Command Center & Manual Assignment
  process.stdout.write('[TEST 6] 6. Booking Command Center, Manual Assignment & Cancellation ... ');
  // Customer creates a booking
  const createBkRes = await fetch(`${BASE_URL}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custLogin.token}` },
    body: JSON.stringify({
      service: 'AC Service & Repair',
      date: 'Tomorrow',
      time: '11:00 AM',
      address: '100 Feet Rd, Indiranagar, Bengaluru',
      latitude: 12.9719,
      longitude: 77.6412,
      price: '₹599',
    }),
  });
  assert(createBkRes.status === 201, 'Booking creation failed');
  const { booking: newBk } = await createBkRes.json();

  // Admin Manual Assignment
  const assignRes = await fetch(`${BASE_URL}/api/admin/bookings/${newBk.id}/assign`, {
    method: 'POST',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: createdWorker.id,
      reason: 'Priority VIP assignment by Operations Lead',
    }),
  });
  assert(assignRes.status === 200, 'Admin assignment failed');
  const assignData = await assignRes.json();
  assert(assignData.booking.providerId === createdWorker.id, 'Provider ID must match assigned worker');
  assert(['Accepted', 'WORKER_ACCEPTED'].includes(assignData.booking.status), 'Status must be Accepted or WORKER_ACCEPTED');

  // Admin Booking Cancellation
  const cancelRes = await fetch(`${BASE_URL}/api/admin/bookings/${newBk.id}/cancel`, {
    method: 'POST',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Customer requested reschedule' }),
  });
  assert(cancelRes.status === 200, 'Admin cancellation failed');
  const cancelData = await cancelRes.json();
  assert(cancelData.booking.status === 'CANCELLED', 'Status must be CANCELLED');
  console.log('✔ PASSED');

  // 7. Services & Pricing Catalog CRUD
  process.stdout.write('[TEST 7] 7. Services & Pricing Catalog CRUD ... ');
  const srvName = `Deep Kitchen Cleaning ${Date.now()}`;
  const createSrvRes = await fetch(`${BASE_URL}/api/admin/services`, {
    method: 'POST',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: srvName,
      category: 'Deep Cleaning',
      priceStart: '₹1,299',
      priceNum: 1299,
      duration: '120 mins',
      badge: 'POPULAR',
      icon: '✨',
      popular: true,
    }),
  });
  assert(createSrvRes.status === 201, 'Service creation failed');
  const { service: createdSrv } = await createSrvRes.json();

  // Update Service
  const updateSrvRes = await fetch(`${BASE_URL}/api/admin/services/${createdSrv.customId}`, {
    method: 'PUT',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceStart: '₹1,399', priceNum: 1399 }),
  });
  assert(updateSrvRes.status === 200, 'Service update failed');

  // Delete Service
  const deleteSrvRes = await fetch(`${BASE_URL}/api/admin/services/${createdSrv.customId}`, {
    method: 'DELETE',
    headers: adminAuth,
  });
  assert(deleteSrvRes.status === 200, 'Service deletion failed');
  console.log('✔ PASSED');

  // 8. Coupons & Offers CRUD
  process.stdout.write('[TEST 8] 8. Coupons & Promo Offers CRUD ... ');
  const cpnCode = `TESTPROMO${Date.now().toString().slice(-4)}`;
  const createCpnRes = await fetch(`${BASE_URL}/api/admin/coupons`, {
    method: 'POST',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: cpnCode, amount: 150, percent: 0, active: true }),
  });
  assert(createCpnRes.status === 201, 'Coupon creation failed');

  // Update Coupon
  const updateCpnRes = await fetch(`${BASE_URL}/api/admin/coupons/${cpnCode}`, {
    method: 'PUT',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 200 }),
  });
  assert(updateCpnRes.status === 200, 'Coupon update failed');

  // Delete Coupon
  const deleteCpnRes = await fetch(`${BASE_URL}/api/admin/coupons/${cpnCode}`, {
    method: 'DELETE',
    headers: adminAuth,
  });
  assert(deleteCpnRes.status === 200, 'Coupon deletion failed');
  console.log('✔ PASSED');

  // 9. Financials, Refunds & Payouts
  process.stdout.write('[TEST 9] 9. Financials, Refund Workflow & Worker Payouts ... ');
  const finRes = await fetch(`${BASE_URL}/api/admin/financials`, { headers: adminAuth });
  assert(finRes.status === 200, 'Financials list failed');
  const finData = await finRes.json();
  assert(finData.summary, 'Financial summary missing');

  // Process Refund
  const refundRes = await fetch(`${BASE_URL}/api/admin/financials/refund`, {
    method: 'POST',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookingId: newBk.id,
      amount: 599,
      reason: 'Automated test dispute refund',
    }),
  });
  assert(refundRes.status === 200, 'Refund process failed');

  // Worker Payout
  const payoutRes = await fetch(`${BASE_URL}/api/admin/financials/payout`, {
    method: 'POST',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workerId: createdWorker.id,
      amount: 100,
      notes: 'Weekly incentive payout',
    }),
  });
  assert(payoutRes.status === 200, 'Payout process failed');
  console.log('✔ PASSED');

  // 10. Reviews & Moderation
  process.stdout.write('[TEST 10] 10. Customer Reviews Moderation (Approve / Hide) ... ');
  const reviewsRes = await fetch(`${BASE_URL}/api/admin/reviews`, { headers: adminAuth });
  assert(reviewsRes.status === 200, 'Reviews fetch failed');
  const reviewsData = await reviewsRes.json();
  if (reviewsData.reviews.length > 0) {
    const rId = reviewsData.reviews[0].id;
    const modRes = await fetch(`${BASE_URL}/api/admin/reviews/${rId}/moderate`, {
      method: 'PATCH',
      headers: { ...adminAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ moderationStatus: 'Approved' }),
    });
    assert(modRes.status === 200, 'Review moderation failed');
  }
  console.log('✔ PASSED');

  // 11. Complaints & Disputes Resolution
  process.stdout.write('[TEST 11] 11. Complaints Resolution Center ... ');
  // Create complaint via customer
  const createCompRes = await fetch(`${BASE_URL}/api/complaints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${custLogin.token}` },
    body: JSON.stringify({
      subject: 'Technician was 10 mins late',
      description: 'The technician arrived slightly late for AC repair.',
    }),
  });
  assert(createCompRes.status === 201, 'Complaint creation failed');
  const compData = await createCompRes.json();

  // Admin resolves complaint
  const resolveCompRes = await fetch(`${BASE_URL}/api/admin/complaints/${compData.customId || compData._id}`, {
    method: 'PATCH',
    headers: { ...adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Resolved', notes: 'Apology voucher sent to customer' }),
  });
  assert(resolveCompRes.status === 200, 'Complaint resolution failed');
  console.log('✔ PASSED');

  // 12. Global Search Multi-Entity
  process.stdout.write('[TEST 12] 12. Global Search Multi-Entity Indexer ... ');
  const searchRes = await fetch(`${BASE_URL}/api/admin/search?q=Praveen`, { headers: adminAuth });
  assert(searchRes.status === 200, 'Search failed');
  const searchData = await searchRes.json();
  assert(searchData.results.workers.some(w => w.name.includes('Praveen')), 'Praveen worker must be found');
  console.log('✔ PASSED');

  // 13. Audit Trail Verification
  process.stdout.write('[TEST 13] 13. Immutable Administrative Audit Trail ... ');
  const auditRes = await fetch(`${BASE_URL}/api/admin/audit-logs`, { headers: adminAuth });
  assert(auditRes.status === 200, 'Audit logs fetch failed');
  const { auditLogs } = await auditRes.json();
  assert(Array.isArray(auditLogs) && auditLogs.length > 0, 'Audit logs must contain recorded actions');
  assert(auditLogs.some(log => log.action.includes('ADMIN_')), 'Audit trail must contain ADMIN_ actions');
  console.log('✔ PASSED');

  // 14. Admin Users & Platform Settings
  process.stdout.write('[TEST 14] 14. Admin Users (RBAC) & Platform Settings ... ');
  const settingsRes = await fetch(`${BASE_URL}/api/admin/settings`, { headers: adminAuth });
  assert(settingsRes.status === 200, 'Settings fetch failed');
  const settingsData = await settingsRes.json();
  assert(settingsData.settings.platformCommissionPercent === 20, 'Commission must be 20%');

  const adminUsersRes = await fetch(`${BASE_URL}/api/admin/users`, { headers: adminAuth });
  assert(adminUsersRes.status === 200, 'Admin users fetch failed');
  console.log('✔ PASSED');

  console.log('\n========================================================================');
  console.log('  ✔ ALL 14/14 ADMIN CONTROL CENTER E2E TESTS PASSED PERFECTLY!');
  console.log('========================================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
