const assert = require('assert');

const BASE_URL = 'http://127.0.0.1:4000';

async function post(url, body) {
  const headers = { 'Content-Type': 'application/json' };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, data: text };
  }
}

async function runRegistrationTestSuite() {
  console.log('================================================================');
  console.log('🧪 HOMESTEPIN PRODUCTION CUSTOMER REGISTRATION TEST SUITE');
  console.log('================================================================\n');

  const randomSuffix = Math.floor(100000 + Math.random() * 900000);
  const testEmail = `cust.test.${randomSuffix}@homestepin.in`;
  const testPhone = `98${Math.floor(10000000 + Math.random() * 90000000)}`;
  const testPassword = 'Password@123';

  // ── TEST A: New Email + New Phone → Registration Succeeds ────────────
  console.log('▶ [TEST A] New email + new phone registration...');
  const resA = await post(`${BASE_URL}/api/auth/register-customer`, {
    name: 'Ananya Sharma',
    email: testEmail,
    phone: testPhone,
    password: testPassword,
    confirmPassword: testPassword,
  });
  assert.strictEqual(resA.status, 201, `Status must be 201 Created (got ${resA.status}): ${JSON.stringify(resA.data)}`);
  assert.strictEqual(resA.data.success, true);
  assert(resA.data.user, 'Must return user object');
  assert.strictEqual(resA.data.user.role, 'customer', 'Role must strictly be customer');
  assert.strictEqual(resA.data.user.email, testEmail.toLowerCase());
  console.log(`  ✓ Registration succeeded: User ID ${resA.data.user.id}, Email: ${resA.data.user.email}`);

  // ── TEST B: Existing Email + New Phone → Rejected ─────────────────────
  console.log('\n▶ [TEST B] Existing email + new phone duplicate check...');
  const newPhone2 = `97${Math.floor(10000000 + Math.random() * 90000000)}`;
  const resB = await post(`${BASE_URL}/api/auth/register-customer`, {
    name: 'Different Name',
    email: testEmail, // duplicate
    phone: newPhone2,
    password: testPassword,
    confirmPassword: testPassword,
  });
  assert.strictEqual(resB.status, 409, `Duplicate email must return 409 Conflict (got ${resB.status})`);
  assert(
    resB.data.error.toLowerCase().includes('email already exists'),
    `Expected duplicate email message, got: ${resB.data.error}`
  );
  console.log(`  ✓ Duplicate email rejected as expected: "${resB.data.error}"`);

  // ── TEST C: New Email + Existing Phone → Rejected ─────────────────────
  console.log('\n▶ [TEST C] New email + existing phone duplicate check...');
  const newEmail2 = `cust.another.${randomSuffix}@homestepin.in`;
  const resC = await post(`${BASE_URL}/api/auth/register-customer`, {
    name: 'Another Customer',
    email: newEmail2,
    phone: testPhone, // duplicate
    password: testPassword,
    confirmPassword: testPassword,
  });
  assert.strictEqual(resC.status, 409, `Duplicate phone must return 409 Conflict (got ${resC.status})`);
  assert(
    resC.data.error.toLowerCase().includes('phone number is already registered') ||
    resC.data.error.toLowerCase().includes('phone'),
    `Expected duplicate phone message, got: ${resC.data.error}`
  );
  console.log(`  ✓ Duplicate phone rejected as expected: "${resC.data.error}"`);

  // ── TEST D: Existing Email + Existing Phone → Rejected ────────────────
  console.log('\n▶ [TEST D] Existing email + existing phone duplicate check...');
  const resD = await post(`${BASE_URL}/api/auth/register-customer`, {
    name: 'Duplicate Both',
    email: testEmail, // duplicate
    phone: testPhone, // duplicate
    password: testPassword,
    confirmPassword: testPassword,
  });
  assert.strictEqual(resD.status, 409, `Duplicate email+phone must return 409 Conflict (got ${resD.status})`);
  assert(
    resD.data.error.toLowerCase().includes('email') && resD.data.error.toLowerCase().includes('phone'),
    `Expected duplicate email and phone message, got: ${resD.data.error}`
  );
  console.log(`  ✓ Duplicate email + phone rejected as expected: "${resD.data.error}"`);

  // ── TEST E: Invalid Email → Rejected ──────────────────────────────────
  console.log('\n▶ [TEST E] Invalid email validation check...');
  const resE = await post(`${BASE_URL}/api/auth/register-customer`, {
    name: 'Valid Name',
    email: 'not-an-email-address',
    phone: `96${Math.floor(10000000 + Math.random() * 90000000)}`,
    password: testPassword,
    confirmPassword: testPassword,
  });
  assert.strictEqual(resE.status, 400, 'Invalid email must return 400 Bad Request');
  console.log(`  ✓ Invalid email rejected as expected: "${resE.data.error}"`);

  // ── TEST F: Invalid Phone Format → Rejected ───────────────────────────
  console.log('\n▶ [TEST F] Invalid phone format validation check...');
  const resF = await post(`${BASE_URL}/api/auth/register-customer`, {
    name: 'Valid Name',
    email: `valid.email.${randomSuffix}@example.com`,
    phone: '12345', // invalid length & invalid starting digit
    password: testPassword,
    confirmPassword: testPassword,
  });
  assert.strictEqual(resF.status, 400, 'Invalid phone must return 400 Bad Request');
  console.log(`  ✓ Invalid phone rejected as expected: "${resF.data.error}"`);

  // ── TEST G: Password Mismatch → Rejected ──────────────────────────────
  console.log('\n▶ [TEST G] Password mismatch validation check...');
  const resG = await post(`${BASE_URL}/api/auth/register-customer`, {
    name: 'Valid Name',
    email: `valid.email2.${randomSuffix}@example.com`,
    phone: `95${Math.floor(10000000 + Math.random() * 90000000)}`,
    password: 'Password123',
    confirmPassword: 'Password456_Different',
  });
  assert.strictEqual(resG.status, 400, 'Password mismatch must return 400 Bad Request');
  assert(resG.data.error.toLowerCase().includes('do not match'), `Expected mismatch message, got: ${resG.data.error}`);
  console.log(`  ✓ Password mismatch rejected as expected: "${resG.data.error}"`);

  // ── TEST H: Short Password (<6 chars) → Rejected ──────────────────────
  console.log('\n▶ [TEST H] Short password validation check...');
  const resH = await post(`${BASE_URL}/api/auth/register-customer`, {
    name: 'Valid Name',
    email: `valid.email3.${randomSuffix}@example.com`,
    phone: `94${Math.floor(10000000 + Math.random() * 90000000)}`,
    password: '123',
    confirmPassword: '123',
  });
  assert.strictEqual(resH.status, 400, 'Short password must return 400 Bad Request');
  console.log(`  ✓ Short password rejected as expected: "${resH.data.error}"`);

  // ── TEST I: Newly Registered Customer Can Actually Log In ─────────────
  console.log('\n▶ [TEST I] Newly registered customer sign in verification...');
  const loginRes = await post(`${BASE_URL}/api/auth/login`, {
    identifier: testEmail,
    password: testPassword,
  });
  assert.strictEqual(loginRes.status, 200, `Login must succeed with 200 (got ${loginRes.status})`);
  assert(loginRes.data.token, 'Login must issue JWT auth token');
  assert.strictEqual(loginRes.data.user.email, testEmail.toLowerCase());
  assert.strictEqual(loginRes.data.user.role, 'customer');
  console.log(`  ✓ Login successful! Token issued. Logged in user: ${loginRes.data.user.name} (${loginRes.data.user.role})`);

  // ── TEST J: Forgot Password Flow ──────────────────────────────────────
  console.log('\n▶ [TEST J] Forgot Password Recovery verification...');
  const forgotRes = await post(`${BASE_URL}/api/auth/forgot-password`, {
    identifier: testEmail,
  });
  assert.strictEqual(forgotRes.status, 200, 'Forgot password must return 200');
  assert(forgotRes.data.message.length > 0, 'Must return informative recovery message');
  console.log(`  ✓ Password recovery response: "${forgotRes.data.message}"`);

  console.log('\n================================================================');
  console.log('🎉 ALL CUSTOMER REGISTRATION TEST CASES PASSED SUCCESSFULLY!');
  console.log('================================================================');
}

runRegistrationTestSuite().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
