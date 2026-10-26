const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4001';

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || 5000,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed, raw: data });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, raw: data });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runPromotionalBannersTestSuite() {
  console.log('====================================================');
  console.log('Starting Promotional Banners Integration Test Suite');
  console.log('====================================================\n');

  let testsPassed = 0;
  let testsFailed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      testsPassed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      testsFailed++;
    }
  }

  try {
    // 0. Test Security & RBAC Enforcement on Admin Banners
    console.log('0. Testing Unauthenticated Access Rejection (Security Audit):');
    const unauthBanners = await makeRequest('GET', '/api/admin/banners');
    assert(unauthBanners.status === 401, 'Unauthenticated GET /api/admin/banners rejected with 401');

    const unauthUpload = await makeRequest('POST', '/api/admin/banners/upload', { image: 'fake' });
    assert(unauthUpload.status === 401, 'Unauthenticated POST /api/admin/banners/upload rejected with 401');

    // Authenticate Admin
    console.log('\n0b. Authenticating Admin:');
    const adminLoginRes = await makeRequest('POST', '/api/auth/login', {
      identifier: 'admin@homestep.in',
      password: 'admin123',
    });
    assert(adminLoginRes.status === 200, 'Admin login succeeded');
    const adminToken = adminLoginRes.data?.token;
    assert(Boolean(adminToken), 'Admin token received');
    const adminHeaders = { Authorization: `Bearer ${adminToken}` };

    // Test Invalid / Executable / Script Upload Rejection
    console.log('\n0c. Testing Invalid Non-Image Upload Rejection (Magic Byte Verification):');
    const badUploadRes = await makeRequest('POST', '/api/admin/banners/upload', {
      image: Buffer.from('<script>alert("xss")</script>').toString('base64'),
    }, adminHeaders);
    assert(badUploadRes.status === 400, 'Malicious/Script upload rejected with 400');
    assert(badUploadRes.data?.code === 'INVALID_IMAGE_TYPE', 'Returned error code INVALID_IMAGE_TYPE');

    // 1. Test GET /api/banners (Public endpoint)
    console.log('\n1. Testing Public GET /api/banners:');
    const pubRes = await makeRequest('GET', '/api/banners');
    assert(pubRes.status === 200, 'Public endpoint returns 200 OK');
    assert(Array.isArray(pubRes.data?.banners), 'Returns banners array');
    assert(pubRes.data.banners.length > 0, `Returns ${pubRes.data.banners.length} active banners`);
    const firstPub = pubRes.data.banners[0];
    assert(firstPub.id && firstPub.title && firstPub.badge_text, 'Banner object has required dynamic fields (id, title, badge_text)');
    assert(firstPub.background_type !== undefined && firstPub.background_color !== undefined, 'Banner object has background customization fields');

    // 2. Test GET /api/admin/banners (Authenticated)
    console.log('\n2. Testing Admin GET /api/admin/banners:');
    const adminRes = await makeRequest('GET', '/api/admin/banners', null, adminHeaders);
    assert(adminRes.status === 200, 'Admin endpoint returns 200 OK');
    assert(Array.isArray(adminRes.data?.banners), 'Admin returns full banners catalog');

    // 3. Test POST /api/admin/banners/upload (Upload Base64 image with verified PNG magic bytes)
    console.log('\n3. Testing Banner Image Upload POST /api/admin/banners/upload:');
    // 1x1 transparent PNG base64
    const samplePngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const uploadRes = await makeRequest('POST', '/api/admin/banners/upload', {
      image: samplePngBase64,
      mimeType: 'image/png',
    }, adminHeaders);
    assert(uploadRes.status === 200, 'Upload endpoint returns 200 OK');
    assert(uploadRes.data?.success === true, 'Upload response indicates success');
    assert(uploadRes.data?.url && uploadRes.data.url.startsWith('/uploads/banners/'), `Returns public URL: ${uploadRes.data?.url}`);
    const uploadedImageUrl = uploadRes.data?.url;

    // 4. Test POST /api/admin/banners (Create new custom banner)
    console.log('\n4. Testing Banner Creation POST /api/admin/banners:');
    const createPayload = {
      title: 'Monsoon Home Safety & Roof Leak Audit',
      badge_text: 'WEATHER PROOF',
      description: 'Comprehensive roof waterproofing, drain clearing & sealant test',
      price_text: 'STARTS AT ₹299',
      cta_text: 'Book Monsoon Check',
      targetServiceId: 'srv_plumb',
      couponCode: 'RAIN299',
      background_type: 'color',
      background_color: '#0B1E3B',
      background_image: uploadedImageUrl,
      background_overlay_color: 'rgba(11, 30, 59, 0.75)',
      background_overlay_opacity: 0.75,
      title_color: '#FFFFFF',
      description_color: '#93C5FD',
      badge_background_color: '#3B82F6',
      badge_text_color: '#FFFFFF',
      price_background_color: 'rgba(59, 130, 246, 0.2)',
      price_text_color: '#60A5FA',
      cta_color: '#3B82F6',
      promotional_image: uploadedImageUrl,
      image_position: 'right',
      display_order: 1,
      is_active: true,
    };

    const createRes = await makeRequest('POST', '/api/admin/banners', createPayload, adminHeaders);
    assert(createRes.status === 201, 'Banner created with 201 Created');
    assert(createRes.data?.success === true, 'Response indicates success');
    const createdBanner = createRes.data?.banner;
    assert(createdBanner?.title === createPayload.title, 'Created banner title matches payload');
    assert(createdBanner?.background_image === uploadedImageUrl, 'Created banner background_image saved');
    assert(createdBanner?.promotional_image === uploadedImageUrl, 'Created banner promotional_image saved');
    const createdId = createdBanner?.id || createdBanner?.customId;

    // 5. Test GET /api/admin/banners/:id
    console.log(`\n5. Testing Single Banner Fetch GET /api/admin/banners/${createdId}:`);
    const singleRes = await makeRequest('GET', `/api/admin/banners/${createdId}`, null, adminHeaders);
    assert(singleRes.status === 200, 'Single banner fetch returns 200 OK');
    assert(singleRes.data?.banner?.id === createdId, 'Fetched banner ID matches');

    // 6. Test PUT /api/admin/banners/:id (Update banner)
    console.log(`\n6. Testing Banner Update PUT /api/admin/banners/${createdId}:`);
    const updateRes = await makeRequest('PUT', `/api/admin/banners/${createdId}`, {
      title: 'Monsoon Home Safety & Roof Leak Audit (Updated)',
      price_text: 'FLAT ₹100 OFF',
      background_color: '#1E1B4B',
      title_color: '#FDE047',
    }, adminHeaders);
    assert(updateRes.status === 200, 'Update returns 200 OK');
    assert(updateRes.data?.banner?.title === 'Monsoon Home Safety & Roof Leak Audit (Updated)', 'Title updated');
    assert(updateRes.data?.banner?.price_text === 'FLAT ₹100 OFF', 'Price text updated');
    assert(updateRes.data?.banner?.background_color === '#1E1B4B', 'Background color updated');

    // 7. Test PATCH /api/admin/banners/:id/toggle (Toggle active state)
    console.log(`\n7. Testing Status Toggle PATCH /api/admin/banners/${createdId}/toggle:`);
    const toggleRes1 = await makeRequest('PATCH', `/api/admin/banners/${createdId}/toggle`, { is_active: false }, adminHeaders);
    assert(toggleRes1.status === 200, 'Toggle returns 200 OK');
    assert(toggleRes1.data?.is_active === false, 'Banner toggled to inactive / hidden');

    // Verify it is excluded from public mobile endpoint
    const pubCheck1 = await makeRequest('GET', '/api/banners');
    const foundInPub1 = pubCheck1.data?.banners?.some((b) => b.id === createdId);
    assert(!foundInPub1, 'Inactive banner is hidden from mobile GET /api/banners');

    // Toggle back to active
    const toggleRes2 = await makeRequest('PATCH', `/api/admin/banners/${createdId}/toggle`, { is_active: true }, adminHeaders);
    assert(toggleRes2.data?.is_active === true, 'Banner toggled back to active');

    // Verify it is visible again on public mobile endpoint
    const pubCheck2 = await makeRequest('GET', '/api/banners');
    const foundInPub2 = pubCheck2.data?.banners?.some((b) => b.id === createdId);
    assert(foundInPub2, 'Active banner is visible on mobile GET /api/banners');

    // 8. Test PATCH /api/admin/banners/reorder
    console.log('\n8. Testing Reordering PATCH /api/admin/banners/reorder:');
    const reorderRes = await makeRequest('PATCH', '/api/admin/banners/reorder', {
      orders: [
        { id: createdId, display_order: 99 },
      ],
    }, adminHeaders);
    assert(reorderRes.status === 200, 'Reorder returns 200 OK');
    assert(reorderRes.data?.success === true, 'Reorder success confirmed');

    // 9. Test DELETE /api/admin/banners/:id
    console.log(`\n9. Testing Banner Deletion DELETE /api/admin/banners/${createdId}:`);
    const deleteRes = await makeRequest('DELETE', `/api/admin/banners/${createdId}`, null, adminHeaders);
    assert(deleteRes.status === 200, 'Delete returns 200 OK');
    assert(deleteRes.data?.success === true, 'Delete success confirmed');

    // Verify deletion
    const pubCheck3 = await makeRequest('GET', '/api/banners');
    const foundInPub3 = pubCheck3.data?.banners?.some((b) => b.id === createdId);
    assert(!foundInPub3, 'Deleted banner does not appear on mobile GET /api/banners');

    console.log('\n====================================================');
    console.log(`Tests Completed: ${testsPassed} Passed, ${testsFailed} Failed`);
    console.log('====================================================\n');
    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Test suite failed with unhandled exception:', err);
    process.exit(1);
  }
}

runPromotionalBannersTestSuite();
