#!/usr/bin/env node

/**
 * =========================================================================
 *  HOMESTEPIN — STAGING DATABASE RESET & BACKUP CONTROLLER
 * =========================================================================
 *  Dedicated script to safely backup and reset the STAGING MongoDB Atlas
 *  database (homestepin_staging).
 *
 *  STRICT SAFETY CONTROLS:
 *  1. Refuses to run unless target database name is positively verified
 *     as 'homestepin_staging'.
 *  2. Refuses to run if NODE_ENV is 'production' or connected to production.
 *  3. Refuses to run against the local development database ('homestepin').
 *  4. Performs a full JSON snapshot backup of all collections before any
 *     deletion, and verifies backup readability.
 *  5. Preserves global services, categories, coupons, and platform settings.
 *  6. Recreates baseline synthetic staging admin, customer, and worker accounts.
 *  7. Redacts all sensitive credentials in output logs.
 * =========================================================================
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Try loading .env.staging if present, otherwise .env
const stagingEnvPath = path.resolve(__dirname, '../.env.staging');
const defaultEnvPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(stagingEnvPath)) {
  require('dotenv').config({ path: stagingEnvPath });
} else {
  require('dotenv').config({ path: defaultEnvPath });
}

const User = require('../src/models/User');
const Booking = require('../src/models/Booking');
const HomeServiceRecord = require('../src/models/HomeServiceRecord');
const ServiceGuarantee = require('../src/models/ServiceGuarantee');
const Review = require('../src/models/Review');
const Notification = require('../src/models/Notification');
const Message = require('../src/models/Message');
const CallSession = require('../src/models/CallSession');
const Complaint = require('../src/models/Complaint');
const Payment = require('../src/models/Payment');
const IdempotencyKey = require('../src/models/IdempotencyKey');
const Favorite = require('../src/models/Favorite');
const Address = require('../src/models/Address');
const Worker = require('../src/models/Worker');
const AuditLog = require('../src/models/AuditLog');
const Service = require('../src/models/Service');
const Category = require('../src/models/Category');
const PlatformSetting = require('../src/models/PlatformSetting');
const Coupon = require('../src/models/Coupon');
const { bootstrapSystemDefaults } = require('../src/seed');

// ── SANITIZATION HELPER ──────────────────────────────────────────────────
function sanitizeUri(uri) {
  if (!uri) return 'NOT_CONFIGURED';
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

// ── 1. PRE-FLIGHT DATABASE VERIFICATION ─────────────────────────────────
async function verifyStagingTarget(connection, options = {}) {
  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase().trim();
  const dbName = (connection?.name || '').toLowerCase().trim();
  const rawUri = (process.env.MONGODB_URI || '').toLowerCase().trim();

  const isBypassAllowed = options.allowSimulated === true;

  console.log('\n🔍 [AUDIT] Inspecting Target Database:');
  console.log(`   • Detected NODE_ENV:        ${nodeEnv || 'unspecified'}`);
  console.log(`   • Connected Database Name:  ${dbName || 'unknown'}`);
  console.log(`   • Connection Host:          ${connection?.host || 'unknown'}`);

  // Condition 1: Check production signature
  if (nodeEnv === 'production' || rawUri.includes('production') || dbName.includes('prod')) {
    const errorMsg = 'FATAL: Connected database appears to be PRODUCTION. Aborting immediately without changes.';
    console.error(`\n🛑 ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // Condition 2: Target must be homestepin_staging
  if (dbName !== 'homestepin_staging' && !isBypassAllowed) {
    const errorMsg = `VERIFICATION FAILED: Expected database name "homestepin_staging", but connected to "${dbName}". ` +
      `Safety guard aborted the reset. Configure MONGODB_URI pointing to the staging Atlas database.`;
    console.error(`\n🛑 ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // Condition 3: Must be explicitly configured for staging
  if (nodeEnv !== 'staging' && !isBypassAllowed) {
    const errorMsg = `VERIFICATION FAILED: NODE_ENV is "${nodeEnv}", expected "staging". ` +
      `Safety guard aborted the reset. Set NODE_ENV=staging.`;
    console.error(`\n🛑 ${errorMsg}`);
    throw new Error(errorMsg);
  }

  console.log('   ✔ Target positively verified as dedicated staging database.');
  return true;
}

// ── 2. RECOVERABLE BACKUP ENGINE ─────────────────────────────────────────
async function createRecoverableBackup(connection) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(__dirname, `../backups/staging_${timestamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  console.log(`\n💾 [BACKUP] Creating snapshot backup at: ${backupDir}`);

  const collections = await connection.db.listCollections().toArray();
  const backupSummary = {
    timestamp: new Date().toISOString(),
    databaseName: connection.name,
    collections: {},
    totalDocuments: 0,
  };

  for (const col of collections) {
    const colName = col.name;
    // Skip internal system collections
    if (colName.startsWith('system.')) continue;

    const docs = await connection.db.collection(colName).find({}).toArray();
    const filePath = path.join(backupDir, `${colName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(docs, null, 2), 'utf8');

    backupSummary.collections[colName] = {
      count: docs.length,
      fileSize: fs.statSync(filePath).size,
      filePath,
    };
    backupSummary.totalDocuments += docs.length;
    console.log(`   • Collection "${colName}": ${docs.length} documents backed up.`);
  }

  const manifestPath = path.join(backupDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(backupSummary, null, 2), 'utf8');

  // Verify backup integrity
  console.log('   🔍 Verifying backup integrity...');
  for (const [colName, meta] of Object.entries(backupSummary.collections)) {
    if (!fs.existsSync(meta.filePath)) {
      throw new Error(`Backup verification failed: File missing for collection ${colName}`);
    }
    const readDocs = JSON.parse(fs.readFileSync(meta.filePath, 'utf8'));
    if (readDocs.length !== meta.count) {
      throw new Error(`Backup verification failed: Count mismatch for ${colName} (expected ${meta.count}, got ${readDocs.length})`);
    }
  }

  console.log(`   ✔ Backup successfully verified. Total documents preserved: ${backupSummary.totalDocuments}\n`);
  return { backupDir, manifestPath, backupSummary };
}

// ── 3. DATA RESET EXECUTION ──────────────────────────────────────────────
async function executeStagingReset(connection) {
  console.log('⚡ [RESET] Executing controlled staging reset...');

  // Step 1: Count before reset
  const countsBefore = {
    bookings: await Booking.countDocuments(),
    passports: await HomeServiceRecord.countDocuments(),
    guarantees: await ServiceGuarantee.countDocuments(),
    reviews: await Review.countDocuments(),
    notifications: await Notification.countDocuments(),
    messages: await Message.countDocuments(),
    calls: await CallSession.countDocuments(),
    complaints: await Complaint.countDocuments(),
    payments: await Payment.countDocuments(),
    idempotency: await IdempotencyKey.countDocuments(),
    favorites: await Favorite.countDocuments(),
    addresses: await Address.countDocuments(),
    workers: await Worker.countDocuments(),
    auditLogs: await AuditLog.countDocuments(),
    customers: await User.countDocuments({ role: 'customer' }),
    workerUsers: await User.countDocuments({ role: 'worker' }),
    admins: await User.countDocuments({ role: 'admin' }),
    services: await Service.countDocuments(),
    categories: await Category.countDocuments(),
    coupons: await Coupon.countDocuments(),
    platformSettings: await PlatformSetting.countDocuments(),
  };

  console.log('   📊 Before-reset counts:');
  console.log(`      - Bookings: ${countsBefore.bookings}`);
  console.log(`      - Payments: ${countsBefore.payments}`);
  console.log(`      - Messages: ${countsBefore.messages}`);
  console.log(`      - Customers: ${countsBefore.customers}, Workers: ${countsBefore.workerUsers}, Admins: ${countsBefore.admins}`);
  console.log(`      - Global Services: ${countsBefore.services}, Categories: ${countsBefore.categories}, Coupons: ${countsBefore.coupons}`);

  // Step 2: Delete transient records
  await Booking.deleteMany({});
  await HomeServiceRecord.deleteMany({});
  await ServiceGuarantee.deleteMany({});
  await Review.deleteMany({});
  await Message.deleteMany({});
  await CallSession.deleteMany({});
  await Complaint.deleteMany({});
  await Payment.deleteMany({});
  await IdempotencyKey.deleteMany({});
  await Favorite.deleteMany({});
  await Worker.deleteMany({});
  await Notification.deleteMany({});
  await AuditLog.deleteMany({});

  // Preserve admin addresses, delete non-admin addresses
  const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
  const adminIds = adminUsers.map(a => a._id);
  await Address.deleteMany({ user: { $nin: adminIds } });

  // Delete non-admin users
  await User.deleteMany({ role: { $ne: 'admin' } });

  // Step 3: Ensure baseline staging admin exists
  const adminBootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@staging.homestepin.com';
  const existingAdmin = await User.findOne({ email: adminBootstrapEmail });
  if (!existingAdmin) {
    const bcrypt = require('bcryptjs');
    const adminPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD || 'StrongStagingAdminPass2026!';
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await User.create({
      customId: 'usr_adm_staging',
      name: 'Staging System Administrator',
      email: adminBootstrapEmail,
      phone: '+919876543299',
      passwordHash,
      role: 'admin',
      status: 'active',
      emailVerified: true,
    });
    console.log(`   ✔ Seeded staging admin account: ${adminBootstrapEmail}`);
  }

  // Step 4: Re-bootstrap required system catalogs (services, categories, baseline demo accounts)
  await bootstrapSystemDefaults();

  // Step 5: Verification of counts
  const countsAfter = {
    bookings: await Booking.countDocuments(),
    passports: await HomeServiceRecord.countDocuments(),
    guarantees: await ServiceGuarantee.countDocuments(),
    reviews: await Review.countDocuments(),
    notifications: await Notification.countDocuments(),
    messages: await Message.countDocuments(),
    calls: await CallSession.countDocuments(),
    complaints: await Complaint.countDocuments(),
    payments: await Payment.countDocuments(),
    idempotency: await IdempotencyKey.countDocuments(),
    favorites: await Favorite.countDocuments(),
    addresses: await Address.countDocuments(),
    workers: await Worker.countDocuments(),
    auditLogs: await AuditLog.countDocuments(),
    customers: await User.countDocuments({ role: 'customer' }),
    workerUsers: await User.countDocuments({ role: 'worker' }),
    admins: await User.countDocuments({ role: 'admin' }),
    services: await Service.countDocuments(),
    categories: await Category.countDocuments(),
    coupons: await Coupon.countDocuments(),
    platformSettings: await PlatformSetting.countDocuments(),
  };

  console.log('\n   ✔ After-reset verification:');
  console.log(`      - Bookings remaining:         ${countsAfter.bookings} (Target: 0)`);
  console.log(`      - Payments remaining:         ${countsAfter.payments} (Target: 0)`);
  console.log(`      - Messages remaining:         ${countsAfter.messages} (Target: 0)`);
  console.log(`      - Call sessions remaining:    ${countsAfter.calls} (Target: 0)`);
  console.log(`      - Active Admins:              ${countsAfter.admins} (≥ 1)`);
  console.log(`      - Baseline Synthetic Users:   ${countsAfter.customers} customer, ${countsAfter.workerUsers} worker`);
  console.log(`      - Preserved Global Services:  ${countsAfter.services} (Must be > 0)`);
  console.log(`      - Preserved Categories:       ${countsAfter.categories} (Must be > 0)`);
  console.log(`      - Preserved Coupons:          ${countsAfter.coupons} (Must be > 0)`);

  const isValid =
    countsAfter.bookings === 0 &&
    countsAfter.payments === 0 &&
    countsAfter.messages === 0 &&
    countsAfter.calls === 0 &&
    countsAfter.admins >= 1 &&
    countsAfter.services > 0 &&
    countsAfter.categories > 0;

  if (!isValid) {
    throw new Error('Post-reset verification failed: Residual test data detected or system catalogs missing.');
  }

  return { countsBefore, countsAfter };
}

// ── MAIN RUNNER ──────────────────────────────────────────────────────────
async function main() {
  console.log('========================================================================');
  console.log('  HOMESTEPIN — STAGING DATABASE RESET CONTROLLER');
  console.log('========================================================================');

  const requestedUri = process.env.MONGODB_URI;
  console.log(`Configured MONGODB_URI: ${sanitizeUri(requestedUri)}`);

  let connection;
  try {
    const { connectDb } = require('../src/db');
    connection = await connectDb();
  } catch (err) {
    console.error(`\n❌ Failed to connect to database: ${err.message}`);
    process.exit(1);
  }

  try {
    // 1. Verify Staging Target
    await verifyStagingTarget(connection);

    // 2. Create Recoverable Backup
    const backupResult = await createRecoverableBackup(connection);

    // 3. Execute Reset
    const resetResult = await executeStagingReset(connection);

    console.log('\n========================================================================');
    console.log('  STAGING DATABASE RESET COMPLETED SUCCESSFULLY');
    console.log('========================================================================');
    console.log(`Backup Location: ${backupResult.backupDir}`);
    console.log(`Total Collections Preserved & Cleaned: ${Object.keys(backupResult.backupSummary.collections).length}`);
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ [STOPPED] ${err.message}`);
    process.exit(1);
  } finally {
    if (connection) {
      await mongoose.disconnect();
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  verifyStagingTarget,
  createRecoverableBackup,
  executeStagingReset,
  sanitizeUri,
};
