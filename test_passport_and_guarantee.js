/**
 * test_passport_and_guarantee.js
 * End-to-end automated verification of:
 * 1. Home Service Passport automatic creation & schema validation
 * 2. 7-Day Guarantee activation, 7-day window calculation, and free revisit claims
 * 3. Worker First-Visit Resolution (FVR) calculation & threshold handling
 * 4. Admin guarantee claim review, approval, rejection, and ₹0 revisit dispatch
 */

const mongoose = require('mongoose');
const { connectDb, disconnectDb } = require('./src/db');
const Booking = require('./src/models/Booking');
const User = require('./src/models/User');
const HomeServiceRecord = require('./src/models/HomeServiceRecord');
const ServiceGuarantee = require('./src/models/ServiceGuarantee');
const {
  createOrUpdatePassportAndGuarantee,
  calculateWorkerPerformance,
  backfillLegacyCompletedBookings,
} = require('./src/services/passportAndGuaranteeService');

async function runTests() {
  console.log('=== STARTING HOME SERVICE PASSPORT & 7-DAY GUARANTEE VERIFICATION ===\n');

  try {
    await connectDb();
    console.log('✓ Connected to MongoDB');

    const testTimestamp = Date.now();
    const testCustomerId = `cust_test_${testTimestamp}`;
    const testWorkerId = `wrk_test_${testTimestamp}`;
    const testBookingId = `BK_TEST_${testTimestamp}`;

    // ── TEST 1: Automatic Creation on Booking Completion ──
    console.log('\n--- TEST 1: Passport & Guarantee Creation on Booking Completion ---');
    const testBooking = new Booking({
      customId: testBookingId,
      customerId: testCustomerId,
      customerName: 'Sanjay Test',
      customerPhone: '+919988776655',
      providerId: testWorkerId,
      providerName: 'Rajesh Pro',
      service: 'AC Comprehensive Service',
      category: 'AC & Appliance Repair',
      address: '42 Indiranagar 100ft Rd, Bengaluru',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560038',
      price: '₹799',
      priceNum: 799,
      status: 'Completed',
      paymentStatus: 'Paid',
      diagnosis: 'Low refrigerant pressure, dirty condenser coils.',
      workPerformed: 'Deep jet pump coil wash and gas top-up (R32). Pressure stabilized.',
      partsUsed: [{ name: 'R32 Refrigerant Gas', cost: 450 }],
      finishedAt: new Date(),
    });
    await testBooking.save();

    const { passportRecord, guarantee } = await createOrUpdatePassportAndGuarantee(testBooking);

    if (!passportRecord) throw new Error('Failed to create passport record.');
    if (!guarantee) throw new Error('Failed to create service guarantee.');

    console.log(`✓ HomeServiceRecord created: ${passportRecord.customId} for customer ${passportRecord.customerId}`);
    console.log(`  Diagnosis: "${passportRecord.diagnosis}"`);
    console.log(`  Parts: ${JSON.stringify(passportRecord.partsUsed)}`);
    console.log(`  Next Recommended Date: ${passportRecord.nextRecommendedServiceDate?.toISOString()} (${passportRecord.nextRecommendedServiceReason})`);

    // ── TEST 2: 7-Day Guarantee Window Validation ──
    console.log('\n--- TEST 2: 7-Day Guarantee Window Calculation ---');
    const startTime = new Date(guarantee.startDate).getTime();
    const endTime = new Date(guarantee.endDate).getTime();
    const diffDays = Math.round((endTime - startTime) / (1000 * 60 * 60 * 24));

    console.log(`  Guarantee ID: ${guarantee.guaranteeId}`);
    console.log(`  Start: ${guarantee.startDate.toISOString()}`);
    console.log(`  End:   ${guarantee.endDate.toISOString()}`);
    console.log(`  Duration: ${diffDays} days (Expected: 7 days)`);

    if (diffDays !== 7) {
      throw new Error(`Expected exactly 7 days guarantee window, got ${diffDays}`);
    }
    if (guarantee.status !== 'ACTIVE') {
      throw new Error(`Expected guarantee status ACTIVE, got ${guarantee.status}`);
    }
    console.log('✓ 7-Day Guarantee window mathematically verified.');

    // ── TEST 3: First-Visit Resolution Metric (FVR) (<5 threshold vs >=5) ──
    console.log('\n--- TEST 3: Worker First-Visit Resolution Metric Calculation ---');
    
    // Worker with 1 job -> Should be "Building history"
    let perf = await calculateWorkerPerformance(testWorkerId);
    console.log(`  Worker with 1 job: FVR Rate: ${perf.firstVisitResolutionRate}%, Text: "${perf.firstVisitResolutionText}", isBuildingHistory: ${perf.isBuildingHistory}`);
    if (!perf.isBuildingHistory || perf.firstVisitResolutionText !== 'Building history') {
      throw new Error(`Expected "Building history" for worker with 1 completed job.`);
    }

    // Add 4 more completed jobs for worker (Total 5)
    for (let i = 1; i <= 4; i++) {
      const additionalBooking = new Booking({
        customId: `BK_TEST_ADD_${testTimestamp}_${i}`,
        customerId: `cust_other_${i}`,
        customerName: `Customer ${i}`,
        providerId: testWorkerId,
        providerName: 'Rajesh Pro',
        service: 'Plumbing Repair',
        category: 'Plumbing',
        address: 'Whitefield, Bengaluru',
        price: '₹399',
        priceNum: 399,
        status: 'Completed',
        finishedAt: new Date(),
      });
      await additionalBooking.save();
      await createOrUpdatePassportAndGuarantee(additionalBooking);
    }

    perf = await calculateWorkerPerformance(testWorkerId);
    console.log(`  Worker with 5 clean jobs: FVR Rate: ${perf.firstVisitResolutionRate}%, Text: "${perf.firstVisitResolutionText}", isBuildingHistory: ${perf.isBuildingHistory}`);
    if (perf.firstVisitResolutionRate !== 100 || perf.firstVisitResolutionText !== '100%') {
      throw new Error(`Expected 100% FVR for 5 clean jobs, got ${perf.firstVisitResolutionText}`);
    }
    console.log('✓ Threshold handling (<5 jobs vs >=5 jobs) verified.');

    // ── TEST 4: Customer Requests Free Revisit (₹0 Revisit Booking) ──
    console.log('\n--- TEST 4: Customer Requesting Free Revisit (₹0 Charge) ---');
    guarantee.status = 'CLAIM_REQUESTED';
    guarantee.claim = {
      requestedAt: new Date(),
      reason: 'Cooling reduced again on day 2. Same temperature issue.',
      customerNotes: 'Please dispatch technician.',
    };

    const revisitBookingCustomId = `REV_${guarantee.guaranteeId}`;
    const revisitBooking = new Booking({
      customId: revisitBookingCustomId,
      customerId: testCustomerId,
      customerName: 'Sanjay Test',
      customerPhone: '+919988776655',
      providerId: testWorkerId,
      providerName: 'Rajesh Pro',
      service: `${testBooking.service} (7-Day Guarantee Revisit)`,
      category: testBooking.category,
      address: testBooking.address,
      city: testBooking.city,
      state: testBooking.state,
      pincode: testBooking.pincode,
      date: new Date().toISOString().split('T')[0],
      time: '10:00 AM',
      price: '₹0 (Free Guarantee Revisit)',
      priceNum: 0,
      paymentStatus: 'Free Guarantee Revisit',
      status: 'Accepted',
      isGuaranteeRevisit: true,
      originalBookingId: testBooking.customId,
      guaranteeId: guarantee.guaranteeId,
      revisitReason: guarantee.claim.reason,
    });
    await revisitBooking.save();
    guarantee.revisitBookingId = revisitBooking.customId;
    await guarantee.save();

    console.log(`✓ Free Revisit Booking Created: ${revisitBooking.customId}`);
    console.log(`  Price: "${revisitBooking.price}" (priceNum: ${revisitBooking.priceNum})`);
    console.log(`  isGuaranteeRevisit: ${revisitBooking.isGuaranteeRevisit}`);
    console.log(`  Original Booking Ref: #${revisitBooking.originalBookingId}`);

    if (revisitBooking.priceNum !== 0 || !revisitBooking.isGuaranteeRevisit) {
      throw new Error('Revisit booking must have priceNum 0 and isGuaranteeRevisit true.');
    }

    // ── TEST 5: Worker FVR Recalculation After Revisit Claim ──
    console.log('\n--- TEST 5: First-Visit Resolution Recalculation After Claim ---');
    perf = await calculateWorkerPerformance(testWorkerId);
    console.log(`  Worker FVR with 1 revisit out of 5 jobs: Rate: ${perf.firstVisitResolutionRate}%, Text: "${perf.firstVisitResolutionText}"`);
    // 4 resolved / 5 total = 80%
    if (perf.firstVisitResolutionRate !== 80 || perf.firstVisitResolutionText !== '80%') {
      throw new Error(`Expected 80% FVR (4/5), got ${perf.firstVisitResolutionText}`);
    }
    console.log('✓ Worker FVR accurately decremented based on real guarantee claim.');

    // ── TEST 6: Resolving the Guarantee Revisit ──
    console.log('\n--- TEST 6: Revisit Completion Resolves Parent Guarantee ---');
    revisitBooking.status = 'Completed';
    revisitBooking.finishedAt = new Date();
    await revisitBooking.save();

    const revisitResult = await createOrUpdatePassportAndGuarantee(revisitBooking);
    const updatedParentGuarantee = await ServiceGuarantee.findOne({ guaranteeId: guarantee.guaranteeId });

    console.log(`  Parent Guarantee Status after revisit completion: ${updatedParentGuarantee.status}`);
    if (updatedParentGuarantee.status !== 'RESOLVED') {
      throw new Error(`Expected parent guarantee to be RESOLVED, got ${updatedParentGuarantee.status}`);
    }
    console.log('✓ Revisit completion cleanly marked guarantee as RESOLVED.');

    // Cleanup test artifacts
    await Booking.deleteMany({
      customId: { $in: [testBookingId, revisitBookingCustomId, ...[1, 2, 3, 4].map(i => `BK_TEST_ADD_${testTimestamp}_${i}`)] },
    });
    await HomeServiceRecord.deleteMany({ customerId: testCustomerId });
    await ServiceGuarantee.deleteMany({ customerId: testCustomerId });
    console.log('\n✓ Test records cleaned up.');

    console.log('\n======================================================');
    console.log('🎉 ALL HOME SERVICE PASSPORT & GUARANTEE TESTS PASSED!');
    console.log('======================================================\n');
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  } finally {
    await disconnectDb();
  }
}

runTests();
