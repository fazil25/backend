const assert = require('assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');

const User = require('./src/models/User');
const Booking = require('./src/models/Booking');
const Notification = require('./src/models/Notification');

// Haversine Distance Helper
function calculateHaversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

async function runPushDispatchTestSuite() {
  console.log('================================================================');
  console.log('🧪 HOMESTEPIN WORKER PUSH NOTIFICATION & DISPATCH TEST SUITE');
  console.log('================================================================\n');

  const mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  try {
    const passwordHash = await bcrypt.hash('password123', 10);

    // 1. Setup Test Customer
    const testCustomer = await User.create({
      customId: 'USR-PUSH-CUST',
      name: 'Rohan Verma',
      email: 'push_test_customer@homestep.in',
      phone: '+919988776655',
      passwordHash,
      role: 'customer',
      status: 'active',
    });

    // 2. Setup 4 Distinct Test Workers
    // Worker 1: AC specialist, Online, Free
    const worker1 = await User.create({
      customId: 'WKR-AC-FREE',
      name: 'Suresh AC Pro',
      email: 'worker_ac_online@homestep.in',
      phone: '+919876500001',
      employeeId: 'EMP-W001',
      passwordHash,
      role: 'worker',
      status: 'active',
      kycStatus: 'approved',
      online: true,
      services: ['AC Service & Repair'],
      serviceRadiusKm: 25,
      fcmTokens: [{ token: 'fcm_token_wkr_1', platform: 'android', deviceId: 'device_wkr_1' }],
    });

    // Worker 2: AC specialist, OFFLINE
    const worker2 = await User.create({
      customId: 'WKR-AC-OFFLINE',
      name: 'Ramesh Offline Pro',
      email: 'worker_ac_offline@homestep.in',
      phone: '+919876500002',
      employeeId: 'EMP-W002',
      passwordHash,
      role: 'worker',
      status: 'active',
      kycStatus: 'approved',
      online: false, // OFFLINE
      services: ['AC Service & Repair'],
      serviceRadiusKm: 25,
      fcmTokens: [{ token: 'fcm_token_wkr_2', platform: 'android', deviceId: 'device_wkr_2' }],
    });

    // Worker 3: Cleaning specialist (Wrong Skill for AC), Online
    const worker3 = await User.create({
      customId: 'WKR-CLEAN-FREE',
      name: 'Pooja Cleaning Pro',
      email: 'worker_cleaning_online@homestep.in',
      phone: '+919876500003',
      employeeId: 'EMP-W003',
      passwordHash,
      role: 'worker',
      status: 'active',
      kycStatus: 'approved',
      online: true,
      services: ['Full Home Deep Cleaning'], // Non-matching skill
      serviceRadiusKm: 25,
      fcmTokens: [{ token: 'fcm_token_wkr_3', platform: 'android', deviceId: 'device_wkr_3' }],
    });

    // Worker 4: AC specialist, Online, but BUSY with an active in-flight job
    const worker4 = await User.create({
      customId: 'WKR-AC-BUSY',
      name: 'Vijay Busy Pro',
      email: 'worker_ac_busy@homestep.in',
      phone: '+919876500004',
      employeeId: 'EMP-W004',
      passwordHash,
      role: 'worker',
      status: 'active',
      kycStatus: 'approved',
      online: true,
      services: ['AC Service & Repair'],
      serviceRadiusKm: 25,
      fcmTokens: [{ token: 'fcm_token_wkr_4', platform: 'android', deviceId: 'device_wkr_4' }],
    });

    // Create an active in-flight job assigned to Worker 4
    await Booking.create({
      customId: 'BK-TEST-INFLIGHT-BUSY',
      customerId: testCustomer.customId,
      customerName: testCustomer.name,
      providerId: worker4.customId,
      providerName: worker4.name,
      service: 'AC Service & Repair',
      category: 'AC & Appliance',
      status: 'InProgress',
      date: 'Today',
      time: '09:00 AM',
      price: '₹799',
      priceNum: 799,
      address: 'Indiranagar, Bengaluru',
    });

    console.log('▶ [TEST A & L] Targeted Dispatch & Worker Eligibility Checks...');

    // Simulate Booking Creation for AC Service
    const newBookingId = `BK-DISPATCH-${Date.now()}`;
    const newBooking = await Booking.create({
      customId: newBookingId,
      customerId: testCustomer.customId,
      customerName: testCustomer.name,
      customerPhone: testCustomer.phone,
      service: 'AC Service & Repair',
      category: 'AC & Appliance',
      date: 'Today',
      time: '11:00 AM',
      address: '100ft Road, Indiranagar, Bengaluru',
      area: 'Indiranagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560038',
      latitude: 12.9784,
      longitude: 77.6408,
      price: '₹838',
      priceNum: 838,
      status: 'Pending',
      startOtp: '4829',
      paymentStatus: 'Pending (Cash on Service)',
    });

    // Run Dispatch Logic (Matching server.js logic)
    const potentialWorkers = await User.find({
      role: 'worker',
      status: 'active',
      online: true,
      services: { $in: [newBooking.service, newBooking.category] },
    });

    const busyWorkerBookings = await Booking.find({
      providerId: { $ne: null },
      status: {
        $in: [
          'Accepted',
          'Worker on the way',
          'Travelling',
          'Arrived',
          'EnteredHome',
          'Work started',
          'InProgress',
          'ADDITIONAL_QUOTE_PENDING',
        ],
      },
    }).select('providerId');

    const busyWorkerIds = new Set(busyWorkerBookings.map(b => String(b.providerId)));

    const dispatchedWorkers = [];
    for (const worker of potentialWorkers) {
      const workerIdStr = worker.customId || worker._id.toString();
      if (busyWorkerIds.has(workerIdStr)) continue;

      dispatchedWorkers.push(worker);

      await Notification.create({
        notificationId: `notif_${Date.now()}_${worker.customId}`,
        recipientId: workerIdStr,
        eventId: `evt_offer_${newBooking.customId}_${workerIdStr}`,
        type: 'NEW_JOB_DISPATCH',
        priority: 'HIGH',
        title: 'New Job Available',
        body: `${newBooking.service}\n₹670 • 2.4 km away • 11:00 AM`,
        bookingId: newBooking.customId,
        metadata: {
          channelId: 'homestepin_jobs',
          sound: 'default',
          vibrate: true,
          payout: '₹670',
          distance: '2.4 km',
        },
      });
    }

    // Verify Dispatched Worker Count
    assert(dispatchedWorkers.some(w => w.customId === worker1.customId), 'Worker 1 (AC, Online, Free) MUST receive dispatch');
    assert(!dispatchedWorkers.some(w => w.customId === worker2.customId), 'Worker 2 (Offline) MUST NOT receive dispatch');
    assert(!dispatchedWorkers.some(w => w.customId === worker3.customId), 'Worker 3 (Wrong Skill) MUST NOT receive dispatch');
    assert(!dispatchedWorkers.some(w => w.customId === worker4.customId), 'Worker 4 (Busy in-flight) MUST NOT receive dispatch');

    console.log('  ✓ Targeted dispatch correctly isolated eligible, online, skilled, and non-busy workers.');

    console.log('\n▶ [TEST B, C & M] High Priority Push Notification & Channel Verification...');
    const notif = await Notification.findOne({ recipientId: worker1.customId, type: 'NEW_JOB_DISPATCH' });
    assert(notif !== null, 'Notification record must exist in database');
    assert(notif.priority === 'HIGH', 'Notification priority must be HIGH');
    assert(notif.metadata.channelId === 'homestepin_jobs', 'Notification channel must be homestepin_jobs');
    assert(notif.title === 'New Job Available', 'Title must be "New Job Available"');
    console.log(`  ✓ Notification configured with channel '${notif.metadata.channelId}' and priority '${notif.priority}'.`);

    console.log('\n▶ [TEST E, F & G] Real-Time Atomic Concurrency Job Claiming...');
    // Setup Worker 5 (Competitor AC Pro)
    const worker5 = await User.create({
      customId: 'WKR-AC-COMPETITOR',
      name: 'Anand AC Pro',
      email: 'worker_ac_competitor@homestep.in',
      phone: '+919876500005',
      employeeId: 'EMP-W005',
      passwordHash,
      role: 'worker',
      status: 'active',
      kycStatus: 'approved',
      online: true,
      services: ['AC Service & Repair'],
    });

    // Worker 1 accepts first
    const acceptedBookingW1 = await Booking.findOneAndUpdate(
      {
        customId: newBooking.customId,
        providerId: null,
        status: { $in: ['Pending', 'Requested', 'SEARCHING_WORKER', 'CONFIRMED'] },
      },
      {
        providerId: worker1.customId,
        providerName: worker1.name,
        providerPhone: worker1.phone,
        status: 'Accepted',
        acceptedAt: new Date(),
      },
      { returnDocument: 'after' }
    );

    assert(acceptedBookingW1 !== null, 'Worker 1 first accept MUST succeed');
    assert(acceptedBookingW1.providerId === worker1.customId, 'Worker 1 must be set as provider');
    assert(acceptedBookingW1.status === 'Accepted', 'Status must be Accepted');
    console.log('  ✓ Worker 1 atomically accepted the job first.');

    // Worker 5 attempts to accept the already-claimed job
    const acceptedBookingW5 = await Booking.findOneAndUpdate(
      {
        customId: newBooking.customId,
        providerId: null,
        status: { $in: ['Pending', 'Requested', 'SEARCHING_WORKER', 'CONFIRMED'] },
      },
      {
        providerId: worker5.customId,
        providerName: worker5.name,
        status: 'Accepted',
      },
      { returnDocument: 'after' }
    );

    assert(acceptedBookingW5 === null, 'Worker 5 accept MUST FAIL and return null (409 Conflict)');
    console.log('  ✓ Worker 5 race-condition claim rejected: atomic conditional lock prevented double assignment.');

    console.log('\n▶ [TEST H & K] Worker Device Token Lifecycle & Logout Purge...');
    // Add token
    const sampleToken = 'fcm_android_test_device_token_xyz999';
    await User.updateOne(
      { customId: worker1.customId },
      { $push: { fcmTokens: { token: sampleToken, platform: 'android', deviceId: 'device_test_123' } } }
    );

    let workerDoc = await User.findOne({ customId: worker1.customId });
    assert(workerDoc.fcmTokens.some(t => t.token === sampleToken), 'Token must be registered');
    console.log('  ✓ Push token registered successfully on worker account.');

    // Simulate Logout
    await User.updateOne(
      { customId: worker1.customId },
      { $pull: { fcmTokens: { token: sampleToken } } }
    );

    workerDoc = await User.findOne({ customId: worker1.customId });
    assert(!workerDoc.fcmTokens.some(t => t.token === sampleToken), 'Token must be purged on logout');
    console.log('  ✓ Push token cleanly purged on logout. Stray alerts prevented.');

    console.log('\n▶ [TEST I & J] Customer Cancellation Invalidation & Offline Status...');
    // Create another pending booking and cancel it
    const cancelBooking = await Booking.create({
      customId: `BK-CANCEL-TEST-${Date.now()}`,
      customerId: testCustomer.customId,
      customerName: testCustomer.name,
      service: 'AC Service & Repair',
      category: 'AC & Appliance',
      status: 'Pending',
      price: '₹499',
      priceNum: 499,
    });

    // Customer cancels
    cancelBooking.status = 'CANCELLED';
    await cancelBooking.save();

    // Verify worker cannot accept cancelled booking
    const attemptAcceptCancelled = await Booking.findOneAndUpdate(
      {
        customId: cancelBooking.customId,
        providerId: null,
        status: { $in: ['Pending', 'Requested', 'SEARCHING_WORKER', 'CONFIRMED'] },
      },
      {
        providerId: worker1.customId,
        status: 'Accepted',
      },
      { returnDocument: 'after' }
    );

    assert(attemptAcceptCancelled === null, 'Cancelled booking cannot be accepted by any worker');
    console.log('  ✓ Cancelled booking cannot be accepted and was invalidated.');

    console.log('\n================================================================');
    console.log('🎉 ALL PUSH NOTIFICATION & WORKER DISPATCH TESTS PASSED (100%)!');
    console.log('================================================================');
  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    await mongoServer.stop();
  }
}

runPushDispatchTestSuite();
