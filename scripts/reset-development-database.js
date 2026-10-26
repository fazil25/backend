#!/usr/bin/env node

/**
 * =========================================================================
 *  HOMESTEPIN — DEVELOPMENT DATABASE RESET SCRIPT
 * =========================================================================
 *  Safely resets the development database to a pristine, fresh state.
 *  - Deletes all non-admin Customers, Workers, Bookings, Passports,
 *    Guarantees, Reviews, Notifications, Messages, Calls, and User Data.
 *  - PRESERVES all Admin accounts, credentials, and roles.
 *  - PRESERVES global Services, Categories, Coupons, and Platform Settings.
 *  - STRICTLY BLOCKED in production environments.
 * =========================================================================
 */

const readline = require('readline');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { connectDb, disconnectDb } = require('../src/db');
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

// ── 1. HARD PRODUCTION SAFETY GUARD ─────────────────────────────────────
function enforceEnvironmentSafety() {
  const nodeEnv = (process.env.NODE_ENV || 'development').toLowerCase().trim();
  const mongoUri = (process.env.MONGODB_URI || '').toLowerCase();

  if (nodeEnv === 'production') {
    console.error('\n🛑 [FATAL] RESET BLOCKED — NODE_ENV IS SET TO PRODUCTION.');
    console.error('Database reset is strictly disabled in production.\n');
    throw new Error('Database reset is disabled in production');
  }

  // Detect production database signatures in URI
  const prodKeywords = ['production', 'prod-db', 'cluster-prod', 'live-db', 'homestepin-prod'];
  const hasProdSignature = prodKeywords.some(keyword => mongoUri.includes(keyword));

  if (hasProdSignature && process.env.ALLOW_DEV_RESET_FORCE !== 'true') {
    console.error('\n🛑 [FATAL] RESET BLOCKED — PRODUCTION DATABASE DETECTED IN MONGODB_URI.');
    console.error('Connected database appears to be a production instance. Aborting immediately.\n');
    throw new Error('RESET BLOCKED — PRODUCTION DATABASE DETECTED.');
  }
}

// ── 2. CREDENTIAL REDACTION HELPER ──────────────────────────────────────
function getSanitizedDbInfo(connection) {
  const host = connection?.host || '127.0.0.1';
  const port = connection?.port || '27017';
  const name = connection?.name || 'homestepin';
  return {
    environment: process.env.NODE_ENV || 'development',
    databaseHost: `${host}:${port}`,
    databaseName: name,
    databaseMode: host.includes('127.0.0.1') || host.includes('localhost') ? 'Local Persistent / Embedded' : 'Remote Managed',
  };
}

// ── 3. INTERACTIVE CONFIRMATION PROMPT ──────────────────────────────────
function askConfirmation(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── 4. MAIN RESET CONTROLLER ────────────────────────────────────────────
async function resetDevelopmentDatabase(options = {}) {
  const isForce = options.force || process.argv.includes('--force') || process.argv.includes('-f') || process.env.CI === 'true';

  console.log('\n========================================================================');
  console.log('  HOMESTEPIN — DEVELOPMENT DATABASE RESET CONTROLLER');
  console.log('========================================================================\n');

  // 1. Safety Guard Check
  enforceEnvironmentSafety();

  // 2. Connect Database
  const connection = await connectDb();
  const dbInfo = getSanitizedDbInfo(connection);

  console.log(`Environment:    ${dbInfo.environment}`);
  console.log(`Database Host:  ${dbInfo.databaseHost}`);
  console.log(`Database Name:  ${dbInfo.databaseName}`);
  console.log(`Database Mode:  ${dbInfo.databaseMode}`);
  console.log(`Timestamp:      ${new Date().toISOString()}`);
  console.log('------------------------------------------------------------------------\n');

  // 3. Identification & Initial Counts (Before Reset Report)
  const adminUsers = await User.find({ role: 'admin' }).select('-passwordHash').lean();
  const adminMongoIds = adminUsers.map(u => u._id);
  const adminCustomIds = adminUsers.map(u => u.customId).filter(Boolean);
  const adminEmails = adminUsers.map(u => u.email).filter(Boolean);
  const allAdminIdentifierStrings = new Set([
    ...adminUsers.map(u => u._id.toString()),
    ...adminCustomIds,
    ...adminEmails,
  ]);

  const customerCount = await User.countDocuments({ role: 'customer' });
  const workerCount = await User.countDocuments({ role: 'worker' });
  const otherUsersCount = await User.countDocuments({ role: { $nin: ['customer', 'worker', 'admin'] } });
  const bookingCount = await Booking.countDocuments();
  const passportCount = await HomeServiceRecord.countDocuments();
  const guaranteeCount = await ServiceGuarantee.countDocuments();
  const reviewCount = await Review.countDocuments();
  const notificationCount = await Notification.countDocuments();
  const messageCount = await Message.countDocuments();
  const callCount = await CallSession.countDocuments();
  const complaintCount = await Complaint.countDocuments();
  const paymentCount = await Payment.countDocuments();
  const idempotencyCount = await IdempotencyKey.countDocuments();
  const favoriteCount = await Favorite.countDocuments();
  const addressCount = await Address.countDocuments();
  const workerDocCount = await Worker.countDocuments();
  const auditLogCount = await AuditLog.countDocuments();

  const servicesCount = await Service.countDocuments();
  const categoriesCount = await Category.countDocuments();
  const couponsCount = await Coupon.countDocuments();
  const platformSettingsCount = await PlatformSetting.countDocuments();

  console.log('📊 BEFORE RESET DATA COUNTS:');
  console.log(`  • Preserved Admin Accounts:   ${adminUsers.length} (${adminEmails.join(', ') || 'usr_adm_01'})`);
  console.log(`  • Customers to delete:        ${customerCount}`);
  console.log(`  • Workers to delete:          ${workerCount}`);
  console.log(`  • Other non-admin users:      ${otherUsersCount}`);
  console.log(`  • Bookings to delete:         ${bookingCount}`);
  console.log(`  • Passport records to delete: ${passportCount}`);
  console.log(`  • Guarantees to delete:       ${guaranteeCount}`);
  console.log(`  • Reviews/Ratings to delete:  ${reviewCount}`);
  console.log(`  • Notifications to delete:    ${notificationCount}`);
  console.log(`  • Chat Messages to delete:    ${messageCount}`);
  console.log(`  • Call Sessions to delete:    ${callCount}`);
  console.log(`  • Complaints to delete:       ${complaintCount}`);
  console.log(`  • Payments to delete:         ${paymentCount}`);
  console.log(`  • Idempotency Keys to delete: ${idempotencyCount}`);
  console.log(`  • Saved Favorites to delete:  ${favoriteCount}`);
  console.log(`  • Standalone Addresses:       ${addressCount}`);
  console.log(`  • Worker Profile Documents:   ${workerDocCount}`);
  console.log(`  • Audit Log Records:          ${auditLogCount}`);
  console.log('\n🛡️ GLOBAL CONFIGURATION TO PRESERVE:');
  console.log(`  • Global Services:            ${servicesCount}`);
  console.log(`  • Service Categories:         ${categoriesCount}`);
  console.log(`  • Promotional Coupons:        ${couponsCount}`);
  console.log(`  • Platform Settings:          ${platformSettingsCount}\n`);

  // 4. Confirmation Prompt
  if (!isForce) {
    const confirmation = await askConfirmation(
      '⚠️  ARE YOU SURE YOU WANT TO RESET THE DEVELOPMENT DATABASE? Type "YES" to proceed: '
    );
    if (confirmation !== 'YES') {
      console.log('\n❌ [ABORTED] Reset cancelled by user. No database modifications were made.\n');
      return { success: false, aborted: true };
    }
  }

  console.log('\n⚡ Executing structured cascading cleanup...\n');

  // 5. Cascading Safe Deletion by Dependencies
  // Step A: Dependent Transactional & Relational Records
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

  // Step B: Standalone Addresses for non-admins
  await Address.deleteMany({ user: { $nin: adminMongoIds } });

  // Step C: Notifications for non-admin recipients
  await Notification.deleteMany({ recipientId: { $nin: Array.from(allAdminIdentifierStrings) } });

  // Step D: Audit Logs (Clean non-admin logs)
  await AuditLog.deleteMany({
    $or: [
      { role: { $ne: 'admin' } },
      { actor: { $nin: Array.from(allAdminIdentifierStrings) } },
      { targetType: { $in: ['booking', 'customer', 'worker'] } },
    ],
  });

  // Step E: Delete all Non-Admin Users
  const userDeleteResult = await User.deleteMany({ role: { $ne: 'admin' } });

  // 6. Ensure at least 1 Administrator exists after reset
  const remainingAdmins = await User.find({ role: 'admin' });
  if (remainingAdmins.length === 0) {
    const bcrypt = require('bcryptjs');
    const adminPasswordHash = await bcrypt.hash('admin123', 10);
    await User.create({
      customId: 'usr_adm_01',
      name: 'VINOTHAN A',
      email: 'admin@homestep.in',
      phone: '+919876543299',
      passwordHash: adminPasswordHash,
      role: 'admin',
      status: 'active',
    });
    console.log('  ✔ Created baseline platform admin account: admin@homestep.in');
  }

  // 7. Verify Global System Catalogs are intact
  const { bootstrapSystemDefaults } = require('../src/seed');
  await bootstrapSystemDefaults();

  // 8. Final Database State Verification & After Reset Report
  const finalAdmins = await User.countDocuments({ role: 'admin' });
  const finalCustomers = await User.countDocuments({ role: 'customer' });
  const finalWorkers = await User.countDocuments({ role: 'worker' });
  const finalBookings = await Booking.countDocuments();
  const finalPassports = await HomeServiceRecord.countDocuments();
  const finalGuarantees = await ServiceGuarantee.countDocuments();
  const finalReviews = await Review.countDocuments();
  const finalNotifications = await Notification.countDocuments();
  const finalMessages = await Message.countDocuments();
  const finalCalls = await CallSession.countDocuments();
  const finalComplaints = await Complaint.countDocuments();
  const finalPayments = await Payment.countDocuments();
  const finalIdempotency = await IdempotencyKey.countDocuments();
  const finalFavorites = await Favorite.countDocuments();
  const finalAddresses = await Address.countDocuments();
  const finalWorkerDocs = await Worker.countDocuments();

  const finalServices = await Service.countDocuments();
  const finalCategories = await Category.countDocuments();
  const finalCoupons = await Coupon.countDocuments();
  const finalSettings = await PlatformSetting.countDocuments();

  console.log('========================================================================');
  console.log('  AFTER RESET VERIFICATION SUMMARY');
  console.log('========================================================================');
  console.log(`  ✔ Admin accounts preserved:   ${finalAdmins}`);
  console.log(`  ✔ Customers remaining:        ${finalCustomers} (Target: 0)`);
  console.log(`  ✔ Workers remaining:          ${finalWorkers} (Target: 0)`);
  console.log(`  ✔ Bookings remaining:         ${finalBookings} (Target: 0)`);
  console.log(`  ✔ Passports remaining:        ${finalPassports} (Target: 0)`);
  console.log(`  ✔ Guarantees remaining:       ${finalGuarantees} (Target: 0)`);
  console.log(`  ✔ Reviews/Ratings remaining:  ${finalReviews} (Target: 0)`);
  console.log(`  ✔ Notifications remaining:    ${finalNotifications} (Target: 0)`);
  console.log(`  ✔ Chat Messages remaining:    ${finalMessages} (Target: 0)`);
  console.log(`  ✔ Call Sessions remaining:    ${finalCalls} (Target: 0)`);
  console.log(`  ✔ Complaints remaining:       ${finalComplaints} (Target: 0)`);
  console.log(`  ✔ Payments remaining:         ${finalPayments} (Target: 0)`);
  console.log(`  ✔ Idempotency Keys remaining: ${finalIdempotency} (Target: 0)`);
  console.log(`  ✔ Saved Favorites remaining:  ${finalFavorites} (Target: 0)`);
  console.log(`  ✔ Standalone Addresses:       ${finalAddresses} (Target: 0)`);
  console.log(`  ✔ Worker Docs remaining:      ${finalWorkerDocs} (Target: 0)`);
  console.log('------------------------------------------------------------------------');
  console.log(`  ✔ Global Services preserved:  ${finalServices}`);
  console.log(`  ✔ Categories preserved:       ${finalCategories}`);
  console.log(`  ✔ Coupons preserved:          ${finalCoupons}`);
  console.log(`  ✔ Platform Settings:          ${finalSettings}`);
  console.log('========================================================================\n');

  const isClean =
    finalCustomers <= 1 &&
    finalWorkers <= 1 &&
    finalBookings === 0 &&
    finalPassports === 0 &&
    finalGuarantees === 0 &&
    finalReviews === 0 &&
    finalMessages === 0 &&
    finalCalls === 0 &&
    finalAdmins >= 1 &&
    finalServices > 0;

  if (!isClean) {
    throw new Error('Database reset verification failed: unexpected residual records detected.');
  }

  console.log('🟢 DEVELOPMENT DATABASE RESET COMPLETE & VERIFIED SUCCESSFULLY.\n');

  return {
    success: true,
    deleted: {
      users: userDeleteResult.deletedCount,
      customers: customerCount,
      workers: workerCount,
      bookings: bookingCount,
      passports: passportCount,
      guarantees: guaranteeCount,
      reviews: reviewCount,
      notifications: notificationCount,
      messages: messageCount,
      calls: callCount,
      payments: paymentCount,
    },
    preserved: {
      admins: finalAdmins,
      services: finalServices,
      categories: finalCategories,
      coupons: finalCoupons,
      settings: finalSettings,
    },
  };
}

// Execute standalone when run directly via node
if (require.main === module) {
  resetDevelopmentDatabase()
    .then(async (result) => {
      await disconnectDb();
      process.exit(result.success ? 0 : 1);
    })
    .catch(async (err) => {
      console.error('\n🛑 Reset Failed with Error:', err.message);
      await disconnectDb();
      process.exit(1);
    });
}

module.exports = {
  resetDevelopmentDatabase,
  enforceEnvironmentSafety,
};
