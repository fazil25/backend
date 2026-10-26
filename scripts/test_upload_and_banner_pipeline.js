const fs = require('fs');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const BASE_URL = 'http://localhost:4001';
const WS_URL = 'ws://localhost:4001/ws';

async function runTest() {
  console.log('=== STARTING HOMESTEPIN UPLOAD & BANNER PIPELINE VERIFICATION (PORT 4001) ===\n');

  // Step 1: Admin Login
  console.log('1. Authenticating as Admin on port 4001...');
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@homestep.in',
      password: 'admin123',
    }),
  });
  assert.strictEqual(loginRes.status, 200, `Login status: ${loginRes.status}`);
  const loginData = await loginRes.json();
  const token = loginData.tokens?.accessToken || loginData.token;
  assert(token, 'Access token must be returned');
  console.log('✓ Admin authenticated successfully.');

  // Step 2: Upload a real JPG image
  console.log('\n2. Uploading a JPG image...');
  // 1x1 valid minimal JPEG buffer
  const jpgBuffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
    0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
    0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
    0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
    0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
    0x00, 0xbf, 0x00, 0xff, 0xd9
  ]);
  const jpgBase64 = `data:image/jpeg;base64,${jpgBuffer.toString('base64')}`;

  const uploadJpgRes = await fetch(`${BASE_URL}/api/admin/banners/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      image: jpgBase64,
      fileName: 'background_test.jpg',
      mimeType: 'image/jpeg',
    }),
  });
  assert.strictEqual(uploadJpgRes.status, 200, `Upload JPG status: ${uploadJpgRes.status}`);
  const uploadJpgData = await uploadJpgRes.json();
  assert(uploadJpgData.success, 'Upload JPG must succeed');
  assert(uploadJpgData.url.startsWith('/uploads/banners/'), `URL format: ${uploadJpgData.url}`);
  assert(uploadJpgData.url.endsWith('.jpg'), `JPG extension: ${uploadJpgData.url}`);
  console.log(`✓ JPG uploaded successfully: ${uploadJpgData.url}`);

  // Step 3: Upload a real PNG image
  console.log('\n3. Uploading a PNG image...');
  // 1x1 valid minimal PNG buffer
  const pngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82
  ]);
  const pngBase64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;

  const uploadPngRes = await fetch(`${BASE_URL}/api/admin/banners/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      image: pngBase64,
      fileName: 'promo_test.png',
      mimeType: 'image/png',
    }),
  });
  assert.strictEqual(uploadPngRes.status, 200, `Upload PNG status: ${uploadPngRes.status}`);
  const uploadPngData = await uploadPngRes.json();
  assert(uploadPngData.success, 'Upload PNG must succeed');
  assert(uploadPngData.url.startsWith('/uploads/banners/'), `URL format: ${uploadPngData.url}`);
  assert(uploadPngData.url.endsWith('.png'), `PNG extension: ${uploadPngData.url}`);
  console.log(`✓ PNG uploaded successfully: ${uploadPngData.url}`);

  // Step 4: Confirm physical files exist on filesystem
  console.log('\n4. Verifying physical files on disk...');
  const jpgDiskPath = path.join(__dirname, '../public', uploadJpgData.url);
  const pngDiskPath = path.join(__dirname, '../public', uploadPngData.url);
  assert(fs.existsSync(jpgDiskPath), `Physical JPG file exists at: ${jpgDiskPath}`);
  assert(fs.existsSync(pngDiskPath), `Physical PNG file exists at: ${pngDiskPath}`);
  console.log(`✓ Physical JPG file verified: ${jpgDiskPath} (${fs.statSync(jpgDiskPath).size} bytes)`);
  console.log(`✓ Physical PNG file verified: ${pngDiskPath} (${fs.statSync(pngDiskPath).size} bytes)`);

  // Step 5: Direct HTTP GET of the uploaded images on port 4001
  console.log('\n5. Testing direct HTTP GET on backend port 4001...');
  const fetchJpgRes = await fetch(`${BASE_URL}${uploadJpgData.url}`);
  assert.strictEqual(fetchJpgRes.status, 200, 'JPG URL must return HTTP 200');
  assert.strictEqual(fetchJpgRes.headers.get('content-type'), 'image/jpeg', 'Content-type must be image/jpeg');
  assert.strictEqual(fetchJpgRes.headers.get('cross-origin-resource-policy'), 'cross-origin', 'CORP header must be cross-origin');
  console.log('✓ JPG direct GET verified (HTTP 200, image/jpeg, cross-origin)');

  const fetchPngRes = await fetch(`${BASE_URL}${uploadPngData.url}`);
  assert.strictEqual(fetchPngRes.status, 200, 'PNG URL must return HTTP 200');
  assert.strictEqual(fetchPngRes.headers.get('content-type'), 'image/png', 'Content-type must be image/png');
  assert.strictEqual(fetchPngRes.headers.get('cross-origin-resource-policy'), 'cross-origin', 'CORP header must be cross-origin');
  console.log('✓ PNG direct GET verified (HTTP 200, image/png, cross-origin)');

  // Step 6: Create Banner in Admin using the uploaded URLs
  console.log('\n6. Creating promotional banner with uploaded background and promotional image...');
  const createBannerRes = await fetch(`${BASE_URL}/api/admin/banners`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: 'Automated E2E Banner Test',
      badge_text: 'VERIFIED DEAL',
      description: 'Tested end-to-end with real JPG background and PNG hero icon.',
      price_text: 'SAVE ₹250 TODAY',
      cta_text: 'Claim Offer',
      targetServiceId: 'srv_ac',
      background_type: 'image',
      background_image: uploadJpgData.url,
      promotional_image: uploadPngData.url,
      display_order: 1,
      is_active: true,
    }),
  });
  assert(createBannerRes.status === 200 || createBannerRes.status === 201, `Create banner status: ${createBannerRes.status}`);
  const createBannerData = await createBannerRes.json();
  const createdBanner = createBannerData.banner;
  assert(createdBanner, 'Created banner object returned');
  assert.strictEqual(createdBanner.background_image, uploadJpgData.url, 'Saved background_image matches');
  assert.strictEqual(createdBanner.promotional_image, uploadPngData.url, 'Saved promotional_image matches');
  console.log(`✓ Banner created successfully: "${createdBanner.title}" (ID: ${createdBanner.id || createdBanner._id})`);

  // Step 7: Verify Customer Home Banner API returns the newly created banner with correct image paths
  console.log('\n7. Verifying Customer Home banner endpoint (GET /api/banners)...');
  const customerBannersRes = await fetch(`${BASE_URL}/api/banners`);
  assert.strictEqual(customerBannersRes.status, 200, 'Customer banners status: 200');
  const customerBannersData = await customerBannersRes.json();
  const foundInCustomer = customerBannersData.banners.find(b => (b.id === createdBanner.id || b.title === 'Automated E2E Banner Test'));
  assert(foundInCustomer, 'Created banner visible to customer app');
  assert.strictEqual(foundInCustomer.background_image, uploadJpgData.url);
  assert.strictEqual(foundInCustomer.promotional_image, uploadPngData.url);
  console.log('✓ Banner returned accurately to Customer Mobile App with canonical image paths');

  // Step 8: Verify WebSocket is healthy on port 4001
  console.log('\n8. Verifying WebSocket server on port 4001 (/ws)...');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timed out on port 4001'));
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log('✓ WebSocket connected successfully on ws://localhost:4001/ws');
      ws.close();
      resolve();
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Step 9: Clean up test banner
  console.log('\n9. Cleaning up test banner...');
  const delRes = await fetch(`${BASE_URL}/api/admin/banners/${createdBanner.id || createdBanner._id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(delRes.status, 200, `Delete banner status: ${delRes.status}`);
  console.log('✓ Test banner cleaned up cleanly.');

  console.log('\n🎉 ALL 9 PIPELINE TESTS PASSED 100% CLEANLY ON PORT 4001!');
}

runTest().catch((err) => {
  console.error('\n❌ PIPELINE TEST FAILED:', err);
  process.exit(1);
});
