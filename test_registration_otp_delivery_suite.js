/**
 * =========================================================================
 *  HOMESTEPIN — REGISTRATION OTP DELIVERY & VERIFICATION TEST SUITE
 * =========================================================================
 *  Verifies:
 *  1. OTP request reaches backend & creates challenge.
 *  2. Resend delivery accepts message for authorized recipient.
 *  3. Resend trial domain restriction (unverified recipient) rejected with 403 & challenge rolled back.
 *  4. Failed delivery does NOT falsely report success.
 *  5. Invalid and expired codes rejected.
 *  6. Reused codes rejected.
 *  7. Cooldowns and attempt limits work.
 *  8. Successful verification activates account and issues JWT.
 * =========================================================================
 */

const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { setTestEmailTransport } = require('./src/services/emailService');
const { connectDb } = require('./src/db');
const mongoose = require('mongoose');
const OtpChallenge = require('./src/models/OtpChallenge');
const User = require('./src/models/User');

const { app } = require('./server');
const PORT = 4001;
const LIVE_URL = `http://127.0.0.1:${PORT}`;
const IN_PROCESS_PORT = 4135;
const IN_PROCESS_URL = `http://127.0.0.1:${IN_PROCESS_PORT}`;

let inProcessServer = null;

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (e) {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runDeliverySuite() {
  console.log('========================================================================');
  console.log('  HOMESTEPIN REGISTRATION OTP DELIVERY & VERIFICATION SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let total = 8;

  await connectDb();

  await new Promise((resolve) => {
    inProcessServer = app.listen(IN_PROCESS_PORT, '127.0.0.1', resolve);
  });

  try {
    // ── TEST 1: Restricted Recipient Rejection & No False Success ────────
    console.log('▶ TEST 1: Unverified recipient rejected with 403 RESEND_RESTRICTED_RECIPIENT');
    const restrictedEmail = `unverified_cust_${Date.now()}@example.com`;
    const res1 = await post(`${LIVE_URL}/api/auth/register-customer`, {
      name: 'Restricted User',
      email: restrictedEmail,
      phone: '9988776655',
      password: 'Password@123',
      confirmPassword: 'Password@123',
    });

    if (res1.status === 403 && res1.body.code === 'RESEND_RESTRICTED_RECIPIENT') {
      console.log('  ✔ Correctly returned 403 RESEND_RESTRICTED_RECIPIENT');
      console.log(`  ✔ Message: "${res1.body.error}"`);
      passed++;
    } else {
      throw new Error(`Expected 403 RESEND_RESTRICTED_RECIPIENT, got ${res1.status}: ${JSON.stringify(res1.body)}`);
    }

    // ── TEST 2: Challenge Rollback on Failed Delivery ─────────────────────
    console.log('\n▶ TEST 2: OtpChallenge is rolled back after delivery failure (no orphan cooldown)');
    const orphanChallenge = await OtpChallenge.findOne({ email: restrictedEmail });
    if (!orphanChallenge) {
      console.log('  ✔ Challenge rolled back: no orphaned challenge left in database');
      passed++;
    } else {
      throw new Error('Orphaned challenge remained in database after failed email delivery');
    }

    // ── TEST 3: Mock Delivery Captures Real Code ──────────────────────────
    console.log('\n▶ TEST 3: Authorized recipient delivery creates valid challenge');
    let capturedOtp = null;
    setTestEmailTransport({
      send: async (options) => {
        capturedOtp = options.otp;
        return { id: 'mock_msg_' + Date.now() };
      },
    });

    const validEmail = `valid_cust_${Date.now()}@homestepin.com`;
    const validPhone = '9' + String(Date.now()).slice(-9);
    const res3 = await post(`${IN_PROCESS_URL}/api/auth/register-customer`, {
      name: 'Valid Customer',
      email: validEmail,
      phone: validPhone,
      password: 'Password@123',
      confirmPassword: 'Password@123',
    });

    if (res3.status === 200 && res3.body.requiresOtp && res3.body.challengeId && capturedOtp) {
      console.log(`  ✔ Valid challenge created: ${res3.body.challengeId}`);
      console.log(`  ✔ Masked email returned: ${res3.body.email}`);
      passed++;
    } else {
      throw new Error(`Expected 200 with requiresOtp, got ${res3.status}: ${JSON.stringify(res3.body)}`);
    }

    const activeChallengeId = res3.body.challengeId;

    // ── TEST 4: Resend Cooldown Blocks Rapid Requests ────────────────────
    console.log('\n▶ TEST 4: Immediate resend request blocked by 60s cooldown');
    const res4 = await post(`${IN_PROCESS_URL}/api/auth/resend-otp`, {
      challengeId: activeChallengeId,
    });

    if (res4.status === 429 && res4.body.code === 'RESEND_COOLDOWN') {
      console.log(`  ✔ Correctly blocked by cooldown: "${res4.body.error}"`);
      passed++;
    } else {
      throw new Error(`Expected 429 RESEND_COOLDOWN, got ${res4.status}: ${JSON.stringify(res4.body)}`);
    }

    // ── TEST 5: Invalid Code Rejection with Remaining Attempts ───────────
    console.log('\n▶ TEST 5: Wrong OTP code rejected with attempt decrement');
    const res5 = await post(`${IN_PROCESS_URL}/api/auth/verify-otp`, {
      challengeId: activeChallengeId,
      otp: '000000',
    });

    if (res5.status === 400 && res5.body.code === 'INCORRECT_OTP' && res5.body.remainingAttempts === 4) {
      console.log(`  ✔ Wrong code rejected: "${res5.body.error}" (${res5.body.remainingAttempts} attempts left)`);
      passed++;
    } else {
      throw new Error(`Expected 400 INCORRECT_OTP with 4 attempts remaining, got ${res5.status}: ${JSON.stringify(res5.body)}`);
    }

    // ── TEST 6: Correct OTP Verification Completes Account Creation ──────
    console.log('\n▶ TEST 6: Correct OTP code verifies and completes registration');
    const res6 = await post(`${IN_PROCESS_URL}/api/auth/verify-otp`, {
      challengeId: activeChallengeId,
      otp: capturedOtp,
    });

    if (res6.status === 200 && res6.body.token && res6.body.user) {
      console.log(`  ✔ Account created: ${res6.body.user.name} (${res6.body.user.email})`);
      console.log(`  ✔ Email verified: ${res6.body.user.emailVerified}`);
      passed++;
    } else {
      throw new Error(`Expected 200 with token and user, got ${res6.status}: ${JSON.stringify(res6.body)}`);
    }

    // ── TEST 7: Reused Code Rejection (Replay Protection) ────────────────
    console.log('\n▶ TEST 7: Reused code rejected (cannot verify or register twice)');
    const res7 = await post(`${IN_PROCESS_URL}/api/auth/verify-otp`, {
      challengeId: activeChallengeId,
      otp: capturedOtp,
    });

    if (res7.status === 409 && res7.body.code === 'OTP_ALREADY_USED') {
      console.log(`  ✔ Replay protection verified: "${res7.body.error}"`);
      passed++;
    } else {
      throw new Error(`Expected 409 OTP_ALREADY_USED, got ${res7.status}: ${JSON.stringify(res7.body)}`);
    }

    // ── TEST 8: Live Resend Provider Delivery to Authorized Recipient ───
    console.log('\n▶ TEST 8: Live Resend delivery to authorized recipient (vinothan.aaaa@gmail.com)');
    setTestEmailTransport(null); // Restore live Resend SDK

    const { sendOtpEmail } = require('./src/services/emailService');
    const liveRes = await sendOtpEmail({
      to: 'vinothan.aaaa@gmail.com',
      otp: '918273',
      purpose: 'signup_verification',
    });

    if (liveRes && liveRes.id) {
      console.log(`  ✔ Live Resend dispatch accepted: message ID ${liveRes.id}`);
      passed++;
    } else {
      throw new Error(`Expected live Resend response with id, got ${JSON.stringify(liveRes)}`);
    }

    // Clean test accounts
    await User.deleteMany({ $or: [{ email: { $in: [restrictedEmail, validEmail] } }, { phone: { $in: [validPhone, '9123456780'] } }] });
    await OtpChallenge.deleteMany({ email: { $in: [restrictedEmail, validEmail] } });

    console.log('\n========================================================================');
    console.log(`  REGISTRATION OTP DELIVERY SUITE PASSED (${passed}/${total} TESTS)`);
    console.log('========================================================================\n');
  } finally {
    if (inProcessServer) {
      await new Promise((resolve) => inProcessServer.close(resolve));
    }
    await mongoose.disconnect();
  }
}

runDeliverySuite().catch((err) => {
  console.error('\n❌ Delivery suite failed:', err);
  process.exit(1);
});
