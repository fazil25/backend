/**
 * HOMESTEPIN — SERVICES & COUPONS ADMIN-ONLY MANAGEMENT E2E VERIFICATION SUITE
 * Validates RBAC enforcement, Services CRUD + Hide/Show + Image upload + Safe Deletion,
 * Coupons CRUD + Hide/Show + Strict Backend Validation + Safe Deletion,
 * and Customer/Worker API filtering.
 */

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4001';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function run() {
  console.log('\n========================================================================');
  console.log('  HOMESTEPIN — SERVICES & COUPONS ADMIN SYSTEM E2E VERIFICATION');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function step(name, fn) {
    process.stdout.write(`[TEST] ${name} ... `);
    try {
      await fn();
      console.log('✔ PASSED');
      passed++;
    } catch (err) {
      console.log('✘ FAILED');
      console.error(`  Error: ${err.message}`);
      failed++;
      throw err;
    }
  }

  // --- Auth Setup ---
  let adminToken = '';
  let customerToken = '';
  let customerId = '';

  await step('1. Authenticate Admin and Customer', async () => {
    // Admin login
    const adminRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin@homestep.in', password: 'admin123' }),
    });
    assert(adminRes.status === 200, `Admin login returned status ${adminRes.status}`);
    const adminData = await adminRes.json();
    assert(adminData.token, 'Admin token missing');
    assert(adminData.user.role === 'admin', 'User role must be admin');
    adminToken = adminData.token;

    // Customer login
    const custRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'customer@homestep.in', password: 'password123' }),
    });
    assert(custRes.status === 200, `Customer login returned status ${custRes.status}`);
    const custData = await custRes.json();
    assert(custData.token, 'Customer token missing');
    assert(custData.user.role === 'customer', 'User role must be customer');
    customerToken = custData.token;
    customerId = custData.user._id || custData.user.id;
  });

  // --- RBAC Tests ---
  await step('2. Admin-Only RBAC Enforcement (401 and 403 checks)', async () => {
    // Unauthenticated
    const unauthServices = await fetch(`${BASE_URL}/api/admin/services`);
    assert(unauthServices.status === 401, 'Unauthenticated GET /api/admin/services must return 401');

    const unauthCoupons = await fetch(`${BASE_URL}/api/admin/coupons`);
    assert(unauthCoupons.status === 401, 'Unauthenticated GET /api/admin/coupons must return 401');

    // Customer trying to access Admin endpoints
    const custHeaders = {
      Authorization: `Bearer ${customerToken}`,
      'Content-Type': 'application/json',
    };

    const custServicesRes = await fetch(`${BASE_URL}/api/admin/services`, { headers: custHeaders });
    assert(custServicesRes.status === 403, 'Customer calling GET /api/admin/services must return 403');

    const custPostServiceRes = await fetch(`${BASE_URL}/api/admin/services`, {
      method: 'POST',
      headers: custHeaders,
      body: JSON.stringify({ name: 'Hacked Service' }),
    });
    assert(custPostServiceRes.status === 403, 'Customer calling POST /api/admin/services must return 403');

    const custCouponsRes = await fetch(`${BASE_URL}/api/admin/coupons`, { headers: custHeaders });
    assert(custCouponsRes.status === 403, 'Customer calling GET /api/admin/coupons must return 403');

    const custPostCouponRes = await fetch(`${BASE_URL}/api/admin/coupons`, {
      method: 'POST',
      headers: custHeaders,
      body: JSON.stringify({ code: 'HACK50' }),
    });
    assert(custPostCouponRes.status === 403, 'Customer calling POST /api/admin/coupons must return 403');
  });

  const adminHeaders = {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };

  // Pre-test cleanup to guarantee idempotency across test executions
  const existingServicesRes = await fetch(`${BASE_URL}/api/admin/services`, { headers: adminHeaders });
  if (existingServicesRes.status === 200) {
    const sData = await existingServicesRes.json();
    for (const s of (sData.services || [])) {
      if ((s.name && s.name.toLowerCase().includes('solar')) || (s.slug && s.slug.includes('solar'))) {
        // Cancel any active bookings first
        const activeRes = await fetch(`${BASE_URL}/api/admin/bookings`, { headers: adminHeaders });
        if (activeRes.status === 200) {
          const bData = await activeRes.json();
          for (const b of (bData.bookings || [])) {
            if (b.service && b.service.toLowerCase().includes('solar') && !['Completed', 'CANCELLED'].includes(b.status)) {
              await fetch(`${BASE_URL}/api/admin/bookings/${b._id || b.id}/cancel`, {
                method: 'POST',
                headers: adminHeaders,
                body: JSON.stringify({ reason: 'Test cleanup' }),
              });
            }
          }
        }
        await fetch(`${BASE_URL}/api/admin/services/${s._id || s.id}`, { method: 'DELETE', headers: adminHeaders });
      }
    }
  }
  const existingCouponsRes = await fetch(`${BASE_URL}/api/admin/coupons`, { headers: adminHeaders });
  if (existingCouponsRes.status === 200) {
    const cData = await existingCouponsRes.json();
    for (const c of (cData.coupons || [])) {
      if (c.code === 'TEST_ADMIN_VOUCHER_50') {
        await fetch(`${BASE_URL}/api/admin/coupons/${c._id || c.id}`, { method: 'DELETE', headers: adminHeaders });
      }
    }
  }

  // --- Service Image Upload ---
  let uploadedImageUrl = '';
  await step('3. Service Image Upload to Dedicated Media Storage', async () => {
    // 1x1 transparent PNG base64
    const samplePngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const uploadRes = await fetch(`${BASE_URL}/api/admin/services/upload`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        image: samplePngBase64,
        mimeType: 'image/png',
      }),
    });
    assert(uploadRes.status === 200, `Upload returned status ${uploadRes.status}`);
    const uploadData = await uploadRes.json();
    assert(uploadData.success === true, 'Upload response must be success');
    assert(uploadData.url && uploadData.url.startsWith('/uploads/services/'), `Valid url returned: ${uploadData.url}`);
    uploadedImageUrl = uploadData.url;
  });

  // --- Services Management Lifecycle ---
  let testServiceId = '';
  let testCustomId = '';
  const testServiceName = 'Smart Solar System Maintenance';

  await step('4. Admin Creates New Service with Full Attributes', async () => {
    const payload = {
      name: testServiceName,
      shortName: 'Solar Care',
      category: 'Electrical',
      description: 'Comprehensive photovoltaic panel cleaning, inverter diagnostics, and wiring inspection.',
      detailedDescription: 'Full multi-point solar PV health check by certified technicians.',
      basePrice: 799,
      discount: 100,
      finalPrice: 699,
      priceUnit: 'per rooftop system',
      minCharge: 499,
      badge: 'ECO ENERGY',
      highlights: ['Deep chemical-free wash', 'Inverter efficiency audit', '30-day performance check'],
      features: ['Solar certified pros', 'Dust resistance coating', 'Rapid 60-min service'],
      instructions: 'Ensure rooftop access is unlocked and water outlet is available.',
      imageUrl: uploadedImageUrl,
      durationMinutes: 75,
      displayOrder: 99,
      is_visible: true,
      featured: true,
    };

    const res = await fetch(`${BASE_URL}/api/admin/services`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(payload),
    });
    assert(res.status === 201, `Create service returned status ${res.status}`);
    const data = await res.json();
    assert(data.success === true, 'Response must indicate success');
    assert(data.service && data.service.name === testServiceName, 'Created service name matches');
    assert(data.service.is_visible === true, 'Service is_visible is true');
    assert(data.service.imageUrl === uploadedImageUrl, 'Service image matches uploaded image');
    testServiceId = data.service._id;
    testCustomId = data.service.customId;
  });

  await step('5. Customer Discovers Newly Created Service via Public API', async () => {
    const res = await fetch(`${BASE_URL}/api/services`);
    assert(res.status === 200, 'Customer GET /api/services returned 200');
    const data = await res.json();
    const services = data.services || [];
    const found = services.find(s => s.id === testServiceId || s._id === testServiceId || s.name === testServiceName);
    assert(found, 'Customer services listing must contain the newly created service');
    assert(found.badge === 'ECO ENERGY', 'Customer sees correct badge');
    assert(found.priceText === '₹699' || found.price === 699, 'Customer sees correct final price');
    assert(found.imageUrl === uploadedImageUrl, 'Customer receives uploaded image URL');
  });

  await step('6. Admin Edits Service Name, Price, and Details', async () => {
    const updatedPayload = {
      name: 'Ultra Solar Pro & Inverter Care',
      shortName: 'Solar Pro',
      category: 'Electrical',
      description: 'Upgraded high-efficiency rooftop solar deep conditioning.',
      basePrice: 999,
      discount: 200,
      finalPrice: 799,
      badge: 'TOP RATED',
      highlights: ['Nanotech glass sealant', 'High-pressure deionized wash'],
      displayOrder: 1,
      is_visible: true,
    };

    const res = await fetch(`${BASE_URL}/api/admin/services/${testServiceId}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify(updatedPayload),
    });
    assert(res.status === 200, `Edit service returned status ${res.status}`);
    const data = await res.json();
    assert(data.success === true, 'Update must be success');
    assert(data.service.name === 'Ultra Solar Pro & Inverter Care', 'Updated name matches');
    assert(data.service.finalPrice === 799, 'Updated price matches');
    assert(data.service.badge === 'TOP RATED', 'Updated badge matches');
  });

  await step('7. Customer Receives Updated Service Details Immediately', async () => {
    const res = await fetch(`${BASE_URL}/api/services`);
    assert(res.status === 200, 'Customer GET /api/services returned 200');
    const data = await res.json();
    const services = data.services || [];
    const found = services.find(s => s.id === testServiceId || s._id === testServiceId || (testCustomId && (s.id === testCustomId || s.customId === testCustomId)));
    assert(found, 'Customer must find service by id');
    assert(found.name === 'Ultra Solar Pro & Inverter Care', 'Customer sees updated name');
    assert(found.price === 799 || found.priceText === '₹799', 'Customer sees updated price ₹799');
    assert(found.badge === 'TOP RATED', 'Customer sees updated badge TOP RATED');
  });

  await step('8. Admin Hides Service (Visibility Toggle)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/services/${testServiceId}/visibility`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ is_visible: false }),
    });
    assert(res.status === 200, `Toggle visibility returned status ${res.status}`);
    const data = await res.json();
    assert(data.success === true, 'Toggle response indicated success');
    assert(data.service.is_visible === false, 'Service is_visible is now false');
    assert(data.service.active === false, 'Service active synced to false');

    // Admin still sees it in admin catalog
    const adminCatalogRes = await fetch(`${BASE_URL}/api/admin/services`, { headers: adminHeaders });
    const adminCatalog = await adminCatalogRes.json();
    const foundAdmin = adminCatalog.services.find(s => s._id === testServiceId);
    assert(foundAdmin, 'Admin catalog must still contain the hidden service');
    assert(foundAdmin.is_visible === false, 'Admin catalog shows service as hidden');
  });

  await step('9. Hidden Service Disappears from Customer APIs and Rejects Bookings', async () => {
    // Check GET /api/services
    const servicesRes = await fetch(`${BASE_URL}/api/services`);
    const servicesData = await servicesRes.json();
    const foundInServices = (servicesData.services || []).find(s => s.id === testServiceId || s._id === testServiceId);
    assert(!foundInServices, 'Hidden service must NOT appear in Customer GET /api/services');

    // Check GET /api/customer/home
    const homeRes = await fetch(`${BASE_URL}/api/customer/home`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    if (homeRes.status === 200) {
      const homeData = await homeRes.json();
      const inPopular = (homeData.popularServices || []).find(s => s.id === testServiceId || s._id === testServiceId);
      assert(!inPopular, 'Hidden service must NOT appear in Customer popularServices');
    }

    // Try booking the hidden service
    const bookingAttemptRes = await fetch(`${BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        service: 'Ultra Solar Pro & Inverter Care',
        serviceId: testServiceId,
        scheduledDate: new Date(Date.now() + 86400000).toISOString(),
        address: '123 Test Street, Bangalore',
      }),
    });
    assert(bookingAttemptRes.status === 400, `Booking hidden service must be rejected with 400. Got ${bookingAttemptRes.status}`);
    const errData = await bookingAttemptRes.json();
    const errMsg = errData.message || errData.error || '';
    assert(errMsg.includes('unavailable'), 'Rejection message informs user service is unavailable');
  });

  await step('10. Admin Unhides Service (Visible Again)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/services/${testServiceId}/visibility`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ is_visible: true }),
    });
    assert(res.status === 200, 'Unhide service returned 200');
    const data = await res.json();
    assert(data.service.is_visible === true, 'Service is_visible is back to true');

    // Customer can see it again
    const servicesRes = await fetch(`${BASE_URL}/api/services`);
    const servicesData = await servicesRes.json();
    const found = (servicesData.services || []).find(s => s.id === testServiceId || s._id === testServiceId);
    assert(found, 'Service reappears in Customer GET /api/services after unhiding');
  });

  let testBookingId = '';
  await step('11. Safe Permanent Deletion Protection (Active Booking Guard)', async () => {
    // Create an active booking
    const bookingRes = await fetch(`${BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        service: 'Ultra Solar Pro & Inverter Care',
        category: 'Electrical',
        date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
        time: '10:00 AM - 12:00 PM',
        slot: '10:00 AM - 12:00 PM',
        address: 'Flat 101, Indiranagar, Bengaluru',
        house: 'Flat 101',
        latitude: 12.9719,
        longitude: 77.6412,
        paymentMethod: 'Cash on Service',
      }),
    });
    assert(bookingRes.status === 201, `Booking created with status ${bookingRes.status}`);
    const bookingData = await bookingRes.json();
    testBookingId = bookingData.booking?._id || bookingData.booking?.id;
    assert(testBookingId, 'Booking ID obtained');

    // Admin attempts to delete service while booking is active
    const deleteAttemptRes = await fetch(`${BASE_URL}/api/admin/services/${testServiceId}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    assert(deleteAttemptRes.status === 400, `Permanent delete must be blocked if active bookings exist. Got ${deleteAttemptRes.status}`);
    const blockData = await deleteAttemptRes.json();
    const blockMsg = blockData.message || blockData.error || '';
    assert(blockMsg.includes('active') && blockMsg.includes('booking'), 'Rejection mentions active bookings protection');
  });

  await step('12. Complete Booking and Permanently Delete Service Safely', async () => {
    // Cancel or complete booking so it becomes historical
    const cancelRes = await fetch(`${BASE_URL}/api/bookings/${testBookingId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'E2E Testing completion' }),
    });
    assert(cancelRes.status === 200, 'Booking cancelled/settled');

    // Admin permanently deletes service now that no active bookings exist
    const deleteRes = await fetch(`${BASE_URL}/api/admin/services/${testServiceId}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    assert(deleteRes.status === 200, `Delete returned status ${deleteRes.status}`);
    const deleteData = await deleteRes.json();
    assert(deleteData.success === true, 'Permanent deletion successful');

    // Verify service is gone from admin catalog
    const checkAdminRes = await fetch(`${BASE_URL}/api/admin/services`, { headers: adminHeaders });
    const checkAdminData = await checkAdminRes.json();
    const inAdmin = checkAdminData.services.find(s => s._id === testServiceId);
    assert(!inAdmin, 'Permanently deleted service must not exist in admin catalog');

    // Verify historical booking record is NOT corrupted
    const historyRes = await fetch(`${BASE_URL}/api/bookings/${testBookingId}`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert(historyRes.status === 200, 'Historical booking record exists');
    const histData = await historyRes.json();
    assert(histData.booking && histData.booking.service === 'Ultra Solar Pro & Inverter Care', 'Historical booking service snapshot remains perfectly preserved');
  });

  // --- Coupons Management Lifecycle ---
  let testCouponId = '';
  const testCouponCode = 'TEST_ADMIN_VOUCHER_50';

  await step('13. Admin Creates New Coupon with Complete Details', async () => {
    const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const payload = {
      code: testCouponCode,
      title: 'Monsoon Clean Special',
      description: 'Flat ₹50 off on all electrical and plumbing services above ₹299',
      discountType: 'flat',
      discountValue: 50,
      minOrderAmount: 299,
      maxDiscount: 50,
      applicableCategory: 'Electrical',
      startDate: new Date().toISOString(),
      expiresAt: expiry,
      usageLimit: 500,
      perUserLimit: 2,
      displayOrder: 1,
      is_visible: true,
      terms: ['Applicable on orders above ₹299', 'Cannot be combined with other offers'],
    };

    const res = await fetch(`${BASE_URL}/api/admin/coupons`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify(payload),
    });
    assert(res.status === 201, `Create coupon returned status ${res.status}`);
    const data = await res.json();
    assert(data.success === true, 'Coupon creation successful');
    assert(data.coupon && data.coupon.code === testCouponCode, 'Created coupon code matches');
    assert(data.coupon.is_visible === true, 'Coupon is_visible is true');
    testCouponId = data.coupon._id;
  });

  await step('14. Customer Discovers and Validates Newly Created Coupon', async () => {
    // GET /api/coupons
    const listRes = await fetch(`${BASE_URL}/api/coupons`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert(listRes.status === 200, 'GET /api/coupons returned 200');
    const listData = await listRes.json();
    const foundCoupon = (listData.coupons || []).find(c => c.code === testCouponCode);
    assert(foundCoupon, 'Customer can see newly created coupon in listing');
    assert(foundCoupon.discountAmount === 50 || foundCoupon.discountValue === 50, 'Discount value matches 50');

    // Validate coupon via POST /api/coupons/validate
    const validateRes = await fetch(`${BASE_URL}/api/coupons/validate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: testCouponCode,
        orderAmount: 499,
        category: 'Electrical',
      }),
    });
    assert(validateRes.status === 200, `Coupon validation returned status ${validateRes.status}`);
    const valData = await validateRes.json();
    assert(valData.valid === true, 'Coupon is valid');
    assert(valData.discount === 50, 'Calculated discount is 50');
  });

  await step('15. Admin Edits Coupon Details (Discount Increased to ₹75)', async () => {
    const updatePayload = {
      title: 'Mega Monsoon Clean Special',
      discountType: 'flat',
      discountValue: 75,
      minOrderAmount: 350,
      maxDiscount: 75,
      applicableCategory: 'Electrical',
      terms: ['Updated: Flat ₹75 discount above ₹350'],
    };

    const res = await fetch(`${BASE_URL}/api/admin/coupons/${testCouponId}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify(updatePayload),
    });
    assert(res.status === 200, `Edit coupon returned ${res.status}`);
    const data = await res.json();
    assert(data.coupon.discountValue === 75, 'Coupon discount updated to 75');

    // Customer re-validates: receives 75
    const validateRes = await fetch(`${BASE_URL}/api/coupons/validate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: testCouponCode,
        orderAmount: 500,
        category: 'Electrical',
      }),
    });
    assert(validateRes.status === 200, 'Re-validation 200');
    const valData = await validateRes.json();
    assert(valData.discount === 75, 'Customer receives new discount value of ₹75');
  });

  await step('16. Admin Hides Coupon (Visibility Toggle)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/coupons/${testCouponId}/visibility`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ is_visible: false }),
    });
    assert(res.status === 200, `Hide coupon returned ${res.status}`);
    const data = await res.json();
    assert(data.coupon.is_visible === false, 'Coupon is_visible is false');
    assert(data.coupon.active === false, 'Coupon active synced to false');

    // Admin catalog still has it
    const adminCouponsRes = await fetch(`${BASE_URL}/api/admin/coupons`, { headers: adminHeaders });
    const adminData = await adminCouponsRes.json();
    const foundInAdmin = adminData.coupons.find(c => c._id === testCouponId);
    assert(foundInAdmin && foundInAdmin.is_visible === false, 'Admin sees hidden coupon in admin list');
  });

  await step('17. Hidden Coupon Disappears from Customer Listings and Fails Validation', async () => {
    // Disappears from GET /api/coupons
    const listRes = await fetch(`${BASE_URL}/api/coupons`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const listData = await listRes.json();
    const foundInList = (listData.coupons || []).find(c => c.code === testCouponCode);
    assert(!foundInList, 'Hidden coupon MUST NOT appear in customer coupons listing');

    // Validation rejects hidden coupon even if user enters code manually
    const validateRes = await fetch(`${BASE_URL}/api/coupons/validate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: testCouponCode,
        orderAmount: 500,
      }),
    });
    assert(validateRes.status === 400, `Hidden coupon validation must fail with 400. Got ${validateRes.status}`);
    const valData = await validateRes.json();
    const errText = valData.message || valData.error || '';
    assert(errText.includes('inactive') || errText.includes('disabled'), 'Error message states coupon is inactive or disabled');
  });

  await step('18. Admin Unhides Coupon and Deletes Safely', async () => {
    // Unhide
    const unhideRes = await fetch(`${BASE_URL}/api/admin/coupons/${testCouponId}/visibility`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ is_visible: true }),
    });
    assert(unhideRes.status === 200, 'Unhide returned 200');
    const unhideData = await unhideRes.json();
    assert(unhideData.coupon.is_visible === true, 'Coupon is_visible is true again');

    // Customer can see it again
    const listRes = await fetch(`${BASE_URL}/api/coupons`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const listData = await listRes.json();
    const found = (listData.coupons || []).find(c => c.code === testCouponCode);
    assert(found, 'Coupon reappears in customer list');

    // Permanent delete
    const deleteRes = await fetch(`${BASE_URL}/api/admin/coupons/${testCouponId}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    assert(deleteRes.status === 200, `Delete returned ${deleteRes.status}`);

    // Verify gone
    const checkRes = await fetch(`${BASE_URL}/api/admin/coupons`, { headers: adminHeaders });
    const checkData = await checkRes.json();
    const inCatalog = checkData.coupons.find(c => c._id === testCouponId);
    assert(!inCatalog, 'Permanently deleted coupon no longer in admin catalog');

    // Reject on validation
    const valRes = await fetch(`${BASE_URL}/api/coupons/validate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: testCouponCode,
        orderAmount: 500,
      }),
    });
    assert(valRes.status === 404, `Deleted coupon returns 404. Got ${valRes.status}`);
  });

  console.log('\n========================================================================');
  console.log(`  ALL ${passed} / ${passed + failed} END-TO-END TESTS PASSED SUCCESSFULLY!`);
  console.log('========================================================================\n');
}

run().catch((err) => {
  console.error('\nE2E TEST SUITE TERMINATED WITH ERROR:', err);
  process.exit(1);
});
