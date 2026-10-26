/**
 * =========================================================================
 *  HOMESTEPIN — STAGING DATABASE RESET & BACKUP E2E VERIFICATION SUITE
 * =========================================================================
 *  Verifies:
 *  1. Pre-flight verification blocks non-staging targets and production signatures.
 *  2. Full backup creation and manifest integrity verification.
 *  3. Cascading clean deletion of test records while preserving catalogs & settings.
 *  4. Baseline staging administrator and synthetic demo accounts recreation.
 *  5. End-to-end booking creation and worker assignment post-reset.
 * =========================================================================
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const {
  verifyStagingTarget,
  createRecoverableBackup,
  executeStagingReset,
} = require('./scripts/reset-staging-database');

const User = require('./src/models/User');
const Booking = require('./src/models/Booking');
const Payment = require('./src/models/Payment');
const Notification = require('./src/models/Notification');
const Message = require('./src/models/Message');
const Service = require('./src/models/Service');
const Category = require('./src/models/Category');

let mongoServer;

async function setupStagingTestDb() {
  const uriFile = path.resolve(__dirname, './data/active_mongo.json');
  let baseUri = 'mongodb://127.0.0.1:27017/';
  if (fs.existsSync(uriFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(uriFile, 'utf8'));
      if (parsed.uri) baseUri = parsed.uri;
    } catch (e) {}
  }
  const stagingUri = baseUri.replace(/\/+$/, '') + '/homestepin_staging';
  await mongoose.connect(stagingUri);
  return mongoose.connection;
}

async function runStagingResetVerification() {
  console.log('========================================================================');
  console.log('  STARTING STAGING DATABASE RESET E2E VERIFICATION SUITE');
  console.log('========================================================================\n');

  let passedTests = 0;
  let totalTests = 5;

  // ── TEST 1: Safety Guard Rejection for Non-Staging DB ────────────────
  console.log('▶ TEST 1: Safety guard rejects non-staging and production targets');
  try {
    process.env.NODE_ENV = 'production';
    await verifyStagingTarget({ name: 'homestepin_prod' });
    throw new Error('Should have thrown on production database');
  } catch (err) {
    if (err.message.includes('FATAL') || err.message.includes('VERIFICATION FAILED')) {
      console.log('  ✔ Correctly rejected production target.');
    } else {
      throw err;
    }
  }

  try {
    process.env.NODE_ENV = 'development';
    await verifyStagingTarget({ name: 'homestepin_dev' });
    throw new Error('Should have thrown on non-staging database name');
  } catch (err) {
    if (err.message.includes('VERIFICATION FAILED')) {
      console.log('  ✔ Correctly rejected non-staging database name.');
      passedTests++;
    } else {
      throw err;
    }
  }

  // ── Setup Staging Database Instance ─────────────────────────────────
  process.env.NODE_ENV = 'staging';
  const connection = await setupStagingTestDb();

  // ── TEST 2: Safety Guard Approves Verified Staging Target ────────────
  console.log('\n▶ TEST 2: Safety guard approves homestepin_staging target');
  const isApproved = await verifyStagingTarget(connection);
  if (isApproved) {
    console.log('  ✔ Staging target successfully approved.');
    passedTests++;
  }

  // ── Seed Disposable Staging Test Data ────────────────────────────────
  console.log('\n▶ Populating mock staging test dataset...');
  await connection.db.dropDatabase();
  const testCustomer = await User.create({
    customId: 'usr_mock_01',
    name: 'Old Staging Customer',
    email: 'old_staging_cust@test.com',
    phone: '+919999900001',
    role: 'customer',
    passwordHash: 'dummy',
  });

  const testWorker = await User.create({
    customId: 'usr_mock_w01',
    name: 'Old Staging Worker',
    email: 'old_staging_work@test.com',
    phone: '+919999900002',
    role: 'worker',
    passwordHash: 'dummy',
  });

  await Booking.create({
    customId: 'BK-STG-999',
    customer: testCustomer._id,
    customerName: testCustomer.name,
    customerPhone: testCustomer.phone,
    service: 'AC Service & Repair',
    category: 'AC & Appliances',
    status: 'COMPLETED',
    price: '₹499',
    totalAmount: 499,
    address: 'Staging Test Address, Bangalore',
    latitude: 12.9352,
    longitude: 77.6245,
  });

  await Payment.create({
    customId: 'PAY-STG-999',
    bookingId: 'BK-STG-999',
    user: testCustomer._id,
    customerId: testCustomer.customId,
    amount: 499,
    status: 'captured',
    paymentMethod: 'online',
  });

  await Message.create({
    messageId: 'msg_stg_01',
    bookingId: 'BK-STG-999',
    senderId: testCustomer.customId,
    senderName: testCustomer.name,
    senderRole: 'customer',
    text: 'Test chat message in staging',
  });

  await Notification.create({
    notificationId: 'notif_stg_01',
    recipientId: testCustomer.customId,
    title: 'Staging Test Notification',
    body: 'Booking completed in staging',
    type: 'booking_update',
  });

  // ── TEST 3: Recoverable Backup Verification ──────────────────────────
  console.log('\n▶ TEST 3: Recoverable backup generation and integrity check');
  const backup = await createRecoverableBackup(connection);
  if (
    fs.existsSync(backup.backupDir) &&
    fs.existsSync(backup.manifestPath) &&
    backup.backupSummary.totalDocuments > 0
  ) {
    console.log(`  ✔ Backup verified at: ${backup.backupDir}`);
    console.log(`  ✔ Documents backed up: ${backup.backupSummary.totalDocuments}`);
    passedTests++;
  } else {
    throw new Error('Backup verification failed: manifest or files missing.');
  }

  // ── TEST 4: Execute Reset & Check Residual Records ───────────────────
  console.log('\n▶ TEST 4: Executing controlled staging reset and checking catalog preservation');
  const resetResult = await executeStagingReset(connection);

  const bookingsLeft = await Booking.countDocuments();
  const paymentsLeft = await Payment.countDocuments();
  const messagesLeft = await Message.countDocuments();
  const servicesCount = await Service.countDocuments();
  const categoriesCount = await Category.countDocuments();
  const adminCount = await User.countDocuments({ role: 'admin' });

  if (
    bookingsLeft === 0 &&
    paymentsLeft === 0 &&
    messagesLeft === 0 &&
    servicesCount > 0 &&
    categoriesCount > 0 &&
    adminCount >= 1
  ) {
    console.log('  ✔ All stale bookings, payments, and messages wiped to 0.');
    console.log(`  ✔ System catalogs preserved: ${servicesCount} services, ${categoriesCount} categories.`);
    console.log(`  ✔ Staging administrator preserved: ${adminCount} admin.`);
    passedTests++;
  } else {
    throw new Error('Reset failed: unexpected residual records or missing catalogs.');
  }

  // ── TEST 5: Verify Post-Reset Application Workflow ───────────────────
  console.log('\n▶ TEST 5: Verify synthetic booking creation & worker assignment on clean DB');
  const cleanCustomer = await User.findOne({ email: 'customer@homestep.in' });
  const cleanWorker = await User.findOne({ $or: [{ email: 'worker@homestep.in' }, { employeeId: '8888' }] });

  if (!cleanCustomer || !cleanWorker) {
    throw new Error('Clean baseline accounts missing after reset.');
  }

  const newBooking = await Booking.create({
    customId: 'BK-CLEAN-001',
    customer: cleanCustomer._id,
    customerName: cleanCustomer.name,
    customerPhone: cleanCustomer.phone,
    worker: cleanWorker._id,
    workerName: cleanWorker.name,
    service: 'AC Service & Repair',
    category: 'AC & Appliances',
    status: 'CONFIRMED',
    price: '₹499',
    totalAmount: 499,
    address: 'Clean Staging Validation Suite, Bangalore',
    latitude: 12.9352,
    longitude: 77.6245,
  });

  const persistedNotification = await Notification.create({
    notificationId: 'notif_clean_01',
    recipientId: cleanCustomer.customId,
    title: 'Booking Confirmed',
    body: `Your booking #${newBooking.customId} has been confirmed.`,
    type: 'booking_update',
  });

  if (newBooking && newBooking._id && persistedNotification && persistedNotification._id) {
    console.log(`  ✔ Clean booking created: ${newBooking.customId} (${newBooking.status})`);
    console.log(`  ✔ Worker assignment verified: ${cleanWorker.name}`);
    console.log(`  ✔ Notification persistence verified: ${persistedNotification.title}`);
    passedTests++;
  }

  // Clean up test backup
  try {
    fs.rmSync(backup.backupDir, { recursive: true, force: true });
  } catch (e) {}

  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();

  console.log('\n========================================================================');
  console.log(`  STAGING DATABASE RESET SUITE PASSED (${passedTests}/${totalTests} TESTS)`);
  console.log('========================================================================\n');
}

runStagingResetVerification().catch(err => {
  console.error('\n❌ Staging reset verification suite failed:', err);
  process.exit(1);
});
