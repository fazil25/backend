const crypto = require('crypto');
const config = require('../config');
const OtpChallenge = require('../models/OtpChallenge');
const { sendOtpEmail, maskEmail } = require('./emailService');

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
const MAX_VERIFICATION_ATTEMPTS = 5;

/**
 * Generate a cryptographically secure 6-digit numeric OTP.
 * @returns {string} 6-digit string
 */
function generateSixDigitCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Create a keyed HMAC-SHA256 hash of the OTP bound to the challenge and email.
 * @param {string} code - 6-digit code
 * @param {string} challengeId - Unique challenge UUID
 * @param {string} email - Normalized email
 * @returns {string} Hex encoded HMAC
 */
function hashOtpCode(code, challengeId, email) {
  return crypto
    .createHmac('sha256', config.otpSecret)
    .update(`${challengeId}:${email.trim().toLowerCase()}:${code.trim()}`)
    .digest('hex');
}

/**
 * Timing-safe comparison of two hash hex strings.
 */
function timingSafeEqualHex(hashA, hashB) {
  if (typeof hashA !== 'string' || typeof hashB !== 'string') return false;
  const bufA = Buffer.from(hashA, 'hex');
  const bufB = Buffer.from(hashB, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Create and dispatch a new OTP challenge.
 * Invalidate any previous unverified challenges for this email and purpose.
 */
async function issueOtpChallenge({ email, purpose, userId = null, pendingUserData = null, ip = null }) {
  const normalizedEmail = email.trim().toLowerCase();
  const challengeId = crypto.randomUUID();
  const code = generateSixDigitCode();
  const now = Date.now();

  // Enforce cooldown if an unverified, unexpired challenge exists
  const existingChallenge = await OtpChallenge.findOne({
    email: normalizedEmail,
    purpose,
    verified: false,
    expiresAt: { $gt: new Date() },
  });
  if (existingChallenge && now < existingChallenge.resendAvailableAt.getTime()) {
    const waitSeconds = Math.ceil((existingChallenge.resendAvailableAt.getTime() - now) / 1000);
    const err = new Error(`Please wait ${waitSeconds} seconds before requesting another code.`);
    err.code = 'RESEND_COOLDOWN';
    err.status = 429;
    err.waitSeconds = waitSeconds;
    throw err;
  }

  // Invalidate previous unverified codes for this email + purpose
  await OtpChallenge.deleteMany({
    email: normalizedEmail,
    purpose,
    verified: false,
  });

  const otpHash = hashOtpCode(code, challengeId, normalizedEmail);

  const challenge = await OtpChallenge.create({
    challengeId,
    email: normalizedEmail,
    userId,
    purpose,
    otpHash,
    attempts: 0,
    maxAttempts: MAX_VERIFICATION_ATTEMPTS,
    resendAvailableAt: new Date(now + RESEND_COOLDOWN_MS),
    expiresAt: new Date(now + OTP_EXPIRY_MS),
    verified: false,
    pendingUserData,
    ip,
  });

  // Dispatch email with rollback on delivery failure
  try {
    await sendOtpEmail({
      to: normalizedEmail,
      otp: code,
      purpose,
    });
  } catch (deliveryErr) {
    // If delivery failed, delete the challenge so user is not locked into an undelivered challenge
    await OtpChallenge.deleteOne({ _id: challenge._id });
    throw deliveryErr;
  }

  return {
    challengeId: challenge.challengeId,
    email: maskEmail(normalizedEmail),
    expiresInSeconds: Math.floor(OTP_EXPIRY_MS / 1000),
    resendCooldownSeconds: Math.floor(RESEND_COOLDOWN_MS / 1000),
    // Expose raw code ONLY in automated testing environments (nodeEnv === 'test')
    _testOtp: config.nodeEnv === 'test' ? code : undefined,
  };
}

/**
 * Verify an OTP submitted against a challenge.
 * Enforces atomic attempt tracking, TTL, reuse prevention, and max attempt lockout.
 */
async function verifyOtpChallenge({ challengeId, otp }) {
  if (!challengeId || typeof challengeId !== 'string') {
    const err = new Error('Verification challenge ID is required.');
    err.code = 'INVALID_CHALLENGE';
    err.status = 400;
    throw err;
  }

  const rawCode = String(otp || '').trim();
  if (!/^\d{6}$/.test(rawCode)) {
    const err = new Error('Please enter a valid 6-digit verification code.');
    err.code = 'INVALID_OTP_FORMAT';
    err.status = 400;
    throw err;
  }

  // 1. Fetch challenge with otpHash
  const challenge = await OtpChallenge.findOne({ challengeId }).select('+otpHash');
  if (!challenge) {
    const err = new Error('Verification session is invalid or has expired.');
    err.code = 'CHALLENGE_NOT_FOUND';
    err.status = 400;
    throw err;
  }

  // 2. Reject already verified challenges (Reuse prevention)
  if (challenge.verified) {
    const err = new Error('This verification code has already been used.');
    err.code = 'OTP_ALREADY_USED';
    err.status = 409;
    throw err;
  }

  // 3. Reject expired challenges (Check explicitly before TTL cleanup)
  if (new Date() > challenge.expiresAt) {
    await OtpChallenge.deleteOne({ _id: challenge._id });
    const err = new Error('Verification code has expired. Please request a new code.');
    err.code = 'OTP_EXPIRED';
    err.status = 400;
    throw err;
  }

  // 4. Reject if attempts already reached max
  if (challenge.attempts >= challenge.maxAttempts) {
    await OtpChallenge.deleteOne({ _id: challenge._id });
    const err = new Error('Maximum verification attempts exceeded. Please request a new code.');
    err.code = 'MAX_ATTEMPTS_EXCEEDED';
    err.status = 429;
    throw err;
  }

  // 5. Atomic increment of attempts to guard against concurrent verification attempts
  const updatedChallenge = await OtpChallenge.findOneAndUpdate(
    {
      _id: challenge._id,
      verified: false,
      attempts: { $lt: challenge.maxAttempts },
    },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after', select: '+otpHash' }
  );

  if (!updatedChallenge) {
    const err = new Error('Verification request locked. Please request a new code.');
    err.code = 'CONCURRENT_REQUEST_LIMIT';
    err.status = 409;
    throw err;
  }

  // 6. Timing-safe verification of the keyed hash
  const computedHash = hashOtpCode(rawCode, challengeId, challenge.email);
  const isMatch = timingSafeEqualHex(updatedChallenge.otpHash, computedHash);

  if (!isMatch) {
    const remainingAttempts = Math.max(0, updatedChallenge.maxAttempts - updatedChallenge.attempts);
    if (remainingAttempts === 0) {
      await OtpChallenge.deleteOne({ _id: updatedChallenge._id });
      const err = new Error('Maximum verification attempts exceeded. Please request a new code.');
      err.code = 'MAX_ATTEMPTS_EXCEEDED';
      err.status = 429;
      throw err;
    }

    const err = new Error(`Incorrect verification code. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`);
    err.code = 'INCORRECT_OTP';
    err.status = 400;
    err.remainingAttempts = remainingAttempts;
    throw err;
  }

  // 7. Atomic success mark and invalidation
  updatedChallenge.verified = true;
  updatedChallenge.verifiedAt = new Date();
  await updatedChallenge.save();

  return {
    success: true,
    challenge: updatedChallenge,
  };
}

/**
 * Resend an OTP for an active challenge, enforcing cooldown and resetting attempts.
 */
async function resendOtpChallenge({ challengeId, ip = null }) {
  if (!challengeId || typeof challengeId !== 'string') {
    const err = new Error('Challenge ID is required.');
    err.code = 'INVALID_CHALLENGE';
    err.status = 400;
    throw err;
  }

  const challenge = await OtpChallenge.findOne({ challengeId });
  if (!challenge || challenge.verified) {
    const err = new Error('Verification session is invalid or has expired.');
    err.code = 'CHALLENGE_NOT_FOUND';
    err.status = 400;
    throw err;
  }

  // Check cooldown
  const now = Date.now();
  if (now < challenge.resendAvailableAt.getTime()) {
    const waitSeconds = Math.ceil((challenge.resendAvailableAt.getTime() - now) / 1000);
    const err = new Error(`Please wait ${waitSeconds} seconds before requesting another code.`);
    err.code = 'RESEND_COOLDOWN';
    err.status = 429;
    err.waitSeconds = waitSeconds;
    throw err;
  }

  // Generate new code, update hash, reset attempts and expiry
  const newCode = generateSixDigitCode();
  const newHash = hashOtpCode(newCode, challengeId, challenge.email);

  challenge.otpHash = newHash;
  challenge.attempts = 0;
  challenge.expiresAt = new Date(now + OTP_EXPIRY_MS);
  challenge.resendAvailableAt = new Date(now + RESEND_COOLDOWN_MS);
  if (ip) challenge.ip = ip;
  await challenge.save();

  try {
    await sendOtpEmail({
      to: challenge.email,
      otp: newCode,
      purpose: challenge.purpose,
    });
  } catch (deliveryErr) {
    // If resend failed, clear cooldown so user can retry immediately
    challenge.resendAvailableAt = new Date();
    await challenge.save();
    throw deliveryErr;
  }

  return {
    challengeId: challenge.challengeId,
    email: maskEmail(challenge.email),
    expiresInSeconds: Math.floor(OTP_EXPIRY_MS / 1000),
    resendCooldownSeconds: Math.floor(RESEND_COOLDOWN_MS / 1000),
    _testOtp: config.nodeEnv === 'test' ? newCode : undefined,
  };
}

module.exports = {
  issueOtpChallenge,
  verifyOtpChallenge,
  resendOtpChallenge,
  generateSixDigitCode,
  hashOtpCode,
  timingSafeEqualHex,
  OTP_EXPIRY_MS,
  RESEND_COOLDOWN_MS,
  MAX_VERIFICATION_ATTEMPTS,
};
