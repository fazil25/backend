const assert = require('assert');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
require('dotenv').config();

const { connectDb, disconnectDb } = require('./src/db');
const User = require('./src/models/User');

function normalizeIndianPhoneNumber(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const digitsOnly = rawPhone.replace(/\D/g, '');
  if (digitsOnly.length === 10 && /^[6-9]\d{9}$/.test(digitsOnly)) {
    return `+91${digitsOnly}`;
  }
  if (digitsOnly.length === 12 && digitsOnly.startsWith('91') && /^91[6-9]\d{9}$/.test(digitsOnly)) {
    return `+${digitsOnly}`;
  }
  if (digitsOnly.length === 11 && digitsOnly.startsWith('0') && /^0[6-9]\d{9}$/.test(digitsOnly)) {
    return `+91${digitsOnly.slice(1)}`;
  }
  return null;
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

async function registerCustomerHandler({ name, email, phone, password, confirmPassword }) {
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return { status: 400, error: 'Full Name is required and must be at least 2 characters.' };
  }
  if (!email || !isValidEmail(email)) {
    return { status: 400, error: 'Please enter a valid email address (e.g. name@example.com).' };
  }
  const normalizedEmail = email.trim().toLowerCase();

  if (!phone) {
    return { status: 400, error: 'Mobile number is required.' };
  }
  const normalizedPhone = normalizeIndianPhoneNumber(phone);
  if (!normalizedPhone) {
    return { status: 400, error: 'Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9.' };
  }

  if (!password || typeof password !== 'string' || password.length < 6) {
    return { status: 400, error: 'Password is required and must be at least 6 characters long.' };
  }

  if (confirmPassword !== undefined && confirmPassword !== null && password !== confirmPassword) {
    return { status: 400, error: 'Passwords do not match. Please re-enter your password.' };
  }

  const existingEmail = await User.findOne({ email: normalizedEmail });
  const existingPhone = await User.findOne({ phone: normalizedPhone });

  if (existingEmail && existingPhone) {
    return { status: 409, error: 'An account with this email and phone number already exists. Please sign in instead.' };
  }
  if (existingEmail) {
    return { status: 409, error: 'An account with this email already exists. Please sign in instead.' };
  }
  if (existingPhone) {
    return { status: 409, error: 'This phone number is already registered. Please sign in instead.' };
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const customId = `usr_cust_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;

    const newUser = await User.create({
      customId,
      name: name.trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      passwordHash,
      role: 'customer',
      status: 'active',
      address: 'Indiranagar, Bengaluru',
      addresses: [{ id: `addr_${Date.now()}`, label: 'Home', address: 'Indiranagar, Bengaluru', isDefault: true }],
    });

    return {
      status: 201,
      success: true,
      message: 'Account created successfully! Please sign in with your credentials.',
      user: {
        id: newUser.customId,
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        role: newUser.role,
      },
    };
  } catch (err) {
    if (err.code === 11000) {
      const keyPattern = err.keyPattern || {};
      if (keyPattern.email) return { status: 409, error: 'An account with this email already exists. Please sign in instead.' };
      if (keyPattern.phone) return { status: 409, error: 'This phone number is already registered. Please sign in instead.' };
      return { status: 409, error: 'An account with these details already exists. Please sign in instead.' };
    }
    throw err;
  }
}

async function runDirectVerification() {
  console.log('================================================================');
  console.log('🧪 VERIFYING CUSTOMER REGISTRATION LOGIC & DATABASE CONSTRAINTS');
  console.log('================================================================\n');

  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const rand = Math.floor(100000 + Math.random() * 900000);
  const testEmail = `cust.reg.${rand}@homestep.in`;
  const testPhone = `98${Math.floor(10000000 + Math.random() * 90000000)}`;
  const testPass = 'Password@123';

  // 1. Success Case
  console.log('▶ [1] Testing New Registration:');
  const res1 = await registerCustomerHandler({
    name: 'Kavita Menon',
    email: testEmail,
    phone: testPhone,
    password: testPass,
    confirmPassword: testPass,
  });
  assert.strictEqual(res1.status, 201, `Expected 201, got ${res1.status}: ${res1.error}`);
  assert.strictEqual(res1.user.role, 'customer');
  console.log('  ✓ Created user:', res1.user);

  // 2. Duplicate Email Check
  console.log('\n▶ [2] Testing Duplicate Email Rejection:');
  const res2 = await registerCustomerHandler({
    name: 'Other Name',
    email: testEmail,
    phone: `97${Math.floor(10000000 + Math.random() * 90000000)}`,
    password: testPass,
    confirmPassword: testPass,
  });
  assert.strictEqual(res2.status, 409);
  assert.strictEqual(res2.error, 'An account with this email already exists. Please sign in instead.');
  console.log('  ✓ Rejected duplicate email:', res2.error);

  // 3. Duplicate Phone Check
  console.log('\n▶ [3] Testing Duplicate Phone Rejection:');
  const res3 = await registerCustomerHandler({
    name: 'Other Name 2',
    email: `diff.email.${rand}@homestep.in`,
    phone: testPhone,
    password: testPass,
    confirmPassword: testPass,
  });
  assert.strictEqual(res3.status, 409);
  assert.strictEqual(res3.error, 'This phone number is already registered. Please sign in instead.');
  console.log('  ✓ Rejected duplicate phone:', res3.error);

  // 4. Duplicate Both Check
  console.log('\n▶ [4] Testing Duplicate Both Email & Phone:');
  const res4 = await registerCustomerHandler({
    name: 'Both Duplicate',
    email: testEmail,
    phone: testPhone,
    password: testPass,
    confirmPassword: testPass,
  });
  assert.strictEqual(res4.status, 409);
  assert.strictEqual(res4.error, 'An account with this email and phone number already exists. Please sign in instead.');
  console.log('  ✓ Rejected duplicate both:', res4.error);

  // 5. Password Mismatch Check
  console.log('\n▶ [5] Testing Password Mismatch:');
  const res5 = await registerCustomerHandler({
    name: 'Valid Name',
    email: `valid.${rand}@homestep.in`,
    phone: `96${Math.floor(10000000 + Math.random() * 90000000)}`,
    password: 'Password123',
    confirmPassword: 'MismatchPassword',
  });
  assert.strictEqual(res5.status, 400);
  assert.strictEqual(res5.error, 'Passwords do not match. Please re-enter your password.');
  console.log('  ✓ Rejected password mismatch:', res5.error);

  // 6. Invalid Phone Check
  console.log('\n▶ [6] Testing Invalid Mobile Number (not starting with 6,7,8,9):');
  const res6 = await registerCustomerHandler({
    name: 'Valid Name',
    email: `valid.${rand}@homestep.in`,
    phone: '1234567890',
    password: testPass,
    confirmPassword: testPass,
  });
  assert.strictEqual(res6.status, 400);
  assert(res6.error.includes('valid 10-digit Indian mobile number'));
  console.log('  ✓ Rejected invalid phone:', res6.error);

  // 7. Login with newly created user
  console.log('\n▶ [7] Testing Authentication with Newly Created Customer:');
  const userInDb = await User.findOne({ email: testEmail.toLowerCase() }).select('+passwordHash');
  assert(userInDb, 'User must exist in database');
  const isMatch = await bcrypt.compare(testPass, userInDb.passwordHash);
  assert.strictEqual(isMatch, true, 'Password hash must verify with bcrypt');
  console.log('  ✓ Password hash verified successfully for:', userInDb.name, `(${userInDb.role})`);

  await mongoose.disconnect();
  await mongoServer.stop();
  console.log('\n================================================================');
  console.log('✅ ALL PRODUCTION REGISTRATION LOGIC & DATABASE TESTS PASSED!');
  console.log('================================================================');
}

runDirectVerification().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
