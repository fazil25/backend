process.env.PORT = process.env.TEST_MAIN_PORT || '4122';
process.env.REQUIRE_LOGIN_2FA = 'true';
const assert = require('assert');
const http = require('http');
const { app, startServer } = require('./server');
const { setTestEmailTransport } = require('./src/services/emailService');
const {
  generateSixDigitCode,
  hashOtpCode,
  timingSafeEqualHex,
} = require('./src/services/otpService');
const OtpChallenge = require('./src/models/OtpChallenge');
const User = require('./src/models/User');

const TEST_PORT = 4123;
let serverInstance = null;
let lastCapturedEmail = null;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const dataString = body ? JSON.stringify(body) : '';
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(dataString),
      ...headers,
    };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers: reqHeaders,
      },
      res => {
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null });
          } catch (e) {
            resolve({ status: res.statusCode, raw });
          }
        });
      }
    );

    req.on('error', reject);
    if (dataString) req.write(dataString);
    req.end();
  });
}

async function runOtpAuthTestSuite() {
  console.log('================================================================');
  console.log('🧪 HOMESTEPIN EMAIL OTP AUTHENTICATION & RESEND TEST SUITE');
  console.log('================================================================\n');

  // Configure test email transport hook
  setTestEmailTransport({
    send: async emailData => {
      lastCapturedEmail = emailData;
      return { id: `mock_email_${Date.now()}` };
    },
  });

  // Start internal test server on TEST_PORT
  await new Promise(resolve => {
    serverInstance = app.listen(TEST_PORT, '127.0.0.1', resolve);
  });

  let passed = 0;
  let failed = 0;

  function testCase(name, condition, extra = '') {
    if (condition) {
      console.log(`✅ [PASS] ${name} ${extra}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name} ${extra}`);
      failed++;
    }
  }

  try {
    // ── 1. OTP Generation and Format (6 digits) ───────────────────────
    const code1 = generateSixDigitCode();
    const code2 = generateSixDigitCode();
    testCase(
      '1. OTP generation and 6-digit format',
      /^\d{6}$/.test(code1) &&
        /^\d{6}$/.test(code2) &&
        Number(code1) >= 100000 &&
        Number(code1) <= 999999
    );

    // Keyed Hash and Timing-Safe Verification
    const hashA = hashOtpCode('123456', 'ch_1', 'user@example.com');
    const hashB = hashOtpCode('123456', 'ch_1', 'user@example.com');
    const hashDiff = hashOtpCode('123457', 'ch_1', 'user@example.com');
    testCase(
      'Keyed hash consistency and timingSafeEqual',
      hashA === hashB &&
        hashA.length === 64 &&
        timingSafeEqualHex(hashA, hashB) &&
        !timingSafeEqualHex(hashA, hashDiff)
    );

    // ── 2. Registration Flow with Email OTP Dispatch ──────────────────
    const testEmail = `otp.cust.${Date.now()}@example.com`;
    const testPhone = `98${Math.floor(10000000 + Math.random() * 90000000)}`;

    const regRes = await request('POST', '/api/auth/register-customer', {
      name: 'Tanvi Verma',
      email: testEmail,
      phone: testPhone,
      password: 'password123',
      confirmPassword: 'password123',
    });

    testCase(
      '2. Registration initiates OTP challenge (requiresOtp: true, challengeId present)',
      regRes.status === 200 &&
        regRes.data.requiresOtp === true &&
        Boolean(regRes.data.challengeId) &&
        regRes.data.email.includes('@')
    );

    const challengeId = regRes.data.challengeId;
    testCase(
      'Resend email mock received 6-digit code',
      lastCapturedEmail &&
        lastCapturedEmail.to === testEmail &&
        /^\d{6}$/.test(lastCapturedEmail.otp) &&
        lastCapturedEmail.purpose === 'signup_verification'
    );
    const sentOtp = lastCapturedEmail.otp;

    // ── 3. Incorrect OTP Rejection ────────────────────────────────────
    const wrongOtpRes = await request('POST', '/api/auth/verify-otp', {
      challengeId,
      otp: '000000',
    });
    testCase(
      '3. Incorrect OTP rejection with remaining attempts counter',
      wrongOtpRes.status === 400 &&
        wrongOtpRes.data.code === 'INCORRECT_OTP' &&
        wrongOtpRes.data.remainingAttempts === 4
    );

    // ── 4. Correct OTP Verification & JWT Token Issuance ──────────────
    const correctOtpRes = await request('POST', '/api/auth/verify-otp', {
      challengeId,
      otp: sentOtp,
    });
    testCase(
      '4. Correct OTP verification succeeds and returns JWT & verified user profile',
      correctOtpRes.status === 200 &&
        correctOtpRes.data.success === true &&
        Boolean(correctOtpRes.data.token) &&
        correctOtpRes.data.user.email === testEmail &&
        correctOtpRes.data.user.emailVerified === true &&
        correctOtpRes.data.user.role === 'customer'
    );

    // ── 5. Reuse Prevention ───────────────────────────────────────────
    const reuseRes = await request('POST', '/api/auth/verify-otp', {
      challengeId,
      otp: sentOtp,
    });
    testCase(
      '5. Reuse prevention rejects already-verified OTP challenge',
      reuseRes.status === 409 && reuseRes.data.code === 'OTP_ALREADY_USED'
    );

    // ── 6. Resend Cooldown Enforcement ────────────────────────────────
    // Create new challenge for testing resend & cooldown
    const regRes2 = await request('POST', '/api/auth/register-customer', {
      name: 'Cooldown Tester',
      email: `cooldown.${Date.now()}@example.com`,
      phone: `97${Math.floor(10000000 + Math.random() * 90000000)}`,
      password: 'password123',
    });
    const challenge2Id = regRes2.data.challengeId;

    const resendRes1 = await request('POST', '/api/auth/resend-otp', {
      challengeId: challenge2Id,
    });
    testCase(
      '6. Resend cooldown blocks immediate re-requests (RESEND_FAILED / RESEND_COOLDOWN)',
      resendRes1.status === 429 && Boolean(resendRes1.data.waitSeconds)
    );

    // Advance resendAvailableAt in DB to verify successful resend
    await OtpChallenge.updateOne(
      { challengeId: challenge2Id },
      { $set: { resendAvailableAt: new Date(Date.now() - 1000) } }
    );
    const resendRes2 = await request('POST', '/api/auth/resend-otp', {
      challengeId: challenge2Id,
    });
    testCase(
      'Resend succeeds after cooldown expiry and sends new code',
      resendRes2.status === 200 &&
        resendRes2.data.success === true &&
        lastCapturedEmail &&
        /^\d{6}$/.test(lastCapturedEmail.otp)
    );

    // ── 7. Maximum Verification Attempts (Lockout) ────────────────────
    const lockoutChallenge = regRes2.data.challengeId;
    let lockoutRes;
    for (let i = 0; i < 5; i++) {
      lockoutRes = await request('POST', '/api/auth/verify-otp', {
        challengeId: lockoutChallenge,
        otp: '111111',
      });
    }
    testCase(
      '7. Maximum 5 incorrect attempts triggers lockout (MAX_ATTEMPTS_EXCEEDED)',
      lockoutRes.status === 429 &&
        lockoutRes.data.code === 'MAX_ATTEMPTS_EXCEEDED'
    );

    // Further attempt on locked challenge
    const afterLockoutRes = await request('POST', '/api/auth/verify-otp', {
      challengeId: lockoutChallenge,
      otp: '111111',
    });
    testCase(
      'Challenge deleted/locked after exceeding max attempts',
      afterLockoutRes.status === 400 &&
        afterLockoutRes.data.code === 'CHALLENGE_NOT_FOUND'
    );

    // ── 8. Expired OTP Rejection ──────────────────────────────────────
    const regRes3 = await request('POST', '/api/auth/register-customer', {
      name: 'Expiry Tester',
      email: `expiry.${Date.now()}@example.com`,
      phone: `96${Math.floor(10000000 + Math.random() * 90000000)}`,
      password: 'password123',
    });
    const challenge3Id = regRes3.data.challengeId;
    // Artificially expire the challenge
    await OtpChallenge.updateOne(
      { challengeId: challenge3Id },
      { $set: { expiresAt: new Date(Date.now() - 5000) } }
    );
    const expiredRes = await request('POST', '/api/auth/verify-otp', {
      challengeId: challenge3Id,
      otp: lastCapturedEmail.otp,
    });
    testCase(
      '8. Expired OTP rejected even before MongoDB TTL collection sweep',
      expiredRes.status === 400 && expiredRes.data.code === 'OTP_EXPIRED'
    );

    // ── 9. Malformed and Invalid Inputs ───────────────────────────────
    const badInput1 = await request('POST', '/api/auth/verify-otp', {
      challengeId: '',
      otp: '123',
    });
    const badInput2 = await request('POST', '/api/auth/verify-otp', {
      challengeId: 'nonexistent-uuid',
      otp: '123456',
    });
    testCase(
      '9. Invalid format (non-6-digit) and unknown challenge handled safely',
      badInput1.status === 400 && badInput2.status === 400
    );

    // ── 10. Duplicate Registration Rejection ──────────────────────────
    const dupEmailRes = await request('POST', '/api/auth/register-customer', {
      name: 'Dup Name',
      email: testEmail, // already verified in test 4
      phone: `95${Math.floor(10000000 + Math.random() * 90000000)}`,
      password: 'password123',
    });
    testCase(
      '10. Duplicate registration rejected for verified email (409 Conflict)',
      dupEmailRes.status === 409 && dupEmailRes.data.code === 'DUPLICATE_EMAIL'
    );

    // ── 11. Login Two-Factor Authentication ───────────────────────────
    // Wrong password -> No OTP issued
    const wrongPassRes = await request('POST', '/api/auth/login', {
      identifier: testEmail,
      password: 'wrongPassword',
    });
    testCase(
      '11a. Invalid password rejected without issuing OTP (401)',
      wrongPassRes.status === 401 && !wrongPassRes.data.requiresOtp
    );

    // Correct password -> Issues login_2fa challenge
    const login2faRes = await request('POST', '/api/auth/login', {
      identifier: testEmail,
      password: 'password123',
    });
    testCase(
      '11b. Valid password issues 2FA challenge without issuing JWT token',
      login2faRes.status === 200 &&
        login2faRes.data.requiresOtp === true &&
        Boolean(login2faRes.data.challengeId) &&
        !login2faRes.data.token &&
        lastCapturedEmail.purpose === 'login_2fa'
    );

    const loginChallengeId = login2faRes.data.challengeId;
    const loginOtp = lastCapturedEmail.otp;

    // Verify 2FA OTP -> Issues JWT token
    const verifyLoginRes = await request('POST', '/api/auth/verify-otp', {
      challengeId: loginChallengeId,
      otp: loginOtp,
    });
    testCase(
      '11c. 2FA OTP verification succeeds and issues authenticated JWT',
      verifyLoginRes.status === 200 &&
        Boolean(verifyLoginRes.data.token) &&
        verifyLoginRes.data.user.email === testEmail
    );

    // ── 12. Role-Based Mismatch Protection ────────────────────────────
    const roleMismatchRes = await request('POST', '/api/auth/login', {
      identifier: testEmail,
      password: 'password123',
      expectedRole: 'worker', // customer trying to log into worker role
    });
    testCase(
      '12. Role-based authorization rejects role mismatch (403 ROLE_MISMATCH)',
      roleMismatchRes.status === 403 &&
        roleMismatchRes.data.code === 'ROLE_MISMATCH'
    );

    // ── 13. Resend Delivery Failure Handling ──────────────────────────
    // Temporarily simulate delivery failure
    setTestEmailTransport({
      send: async () => {
        const err = new Error('Resend rate limit exceeded');
        err.code = 'EMAIL_DELIVERY_FAILED';
        throw err;
      },
    });

    const failedDeliveryRes = await request('POST', '/api/auth/send-registration-otp', {
      email: `fail.${Date.now()}@example.com`,
      phone: `94${Math.floor(10000000 + Math.random() * 90000000)}`,
    });
    testCase(
      '13. Email delivery failure handled gracefully without server crash',
      failedDeliveryRes.status === 500
    );

    // Restore working mock transport
    setTestEmailTransport({
      send: async emailData => {
        lastCapturedEmail = emailData;
        return { id: `mock_email_${Date.now()}` };
      },
    });

    // ── 14. Concurrent Verification Attempts ──────────────────────────
    const regRes4 = await request('POST', '/api/auth/register-customer', {
      name: 'Concurrent Tester',
      email: `concurrent.${Date.now()}@example.com`,
      phone: `93${Math.floor(10000000 + Math.random() * 90000000)}`,
      password: 'password123',
    });
    const concurrentChallengeId = regRes4.data.challengeId;

    // Fire 3 simultaneous requests with incorrect OTP
    const concurrentResults = await Promise.all([
      request('POST', '/api/auth/verify-otp', { challengeId: concurrentChallengeId, otp: '111111' }),
      request('POST', '/api/auth/verify-otp', { challengeId: concurrentChallengeId, otp: '222222' }),
      request('POST', '/api/auth/verify-otp', { challengeId: concurrentChallengeId, otp: '333333' }),
    ]);

    const challengeAfterConcurrent = await OtpChallenge.findOne({ challengeId: concurrentChallengeId });
    testCase(
      '14. Concurrent verification attempts track atomic attempt counts safely',
      challengeAfterConcurrent && challengeAfterConcurrent.attempts === 3
    );

  } finally {
    if (serverInstance) {
      serverInstance.close();
    }
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

// Start DB and execute test suite
startServer().then(() => {
  runOtpAuthTestSuite().catch(err => {
    console.error('Fatal error running OTP auth test suite:', err);
    process.exit(1);
  });
});
