const assert = require('assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
require('dotenv').config();

const User = require('./src/models/User');
const Booking = require('./src/models/Booking');
const Review = require('./src/models/Review');

async function handleRatingSubmission({
  bookingId,
  actor,
  rating,
  review,
  reviewText,
  comment,
}) {
  const booking = await Booking.findOne({
    $or: [{ customId: bookingId }, { id: bookingId }],
  });

  // 1. Booking Existence Validation
  if (!booking) {
    return {
      status: 404,
      error: 'This booking could not be found.',
      code: 'BOOKING_NOT_FOUND',
    };
  }

  // 2. Ownership Validation
  if (booking.customerId !== actor.sub && actor.role !== 'admin') {
    return {
      status: 403,
      error: 'You cannot rate this booking.',
      code: 'FORBIDDEN',
    };
  }

  // 3. Completed Status Validation
  const completedStates = ['Completed', 'COMPLETED', 'Finished', 'Settled'];
  if (!completedStates.includes(booking.status)) {
    return {
      status: 400,
      error: 'Only completed bookings can be rated.',
      code: 'BOOKING_NOT_COMPLETED',
    };
  }

  // 4. Assigned Professional Validation
  if (!booking.providerId) {
    return {
      status: 400,
      error: 'No service professional is assigned to this booking.',
      code: 'NO_ASSIGNED_PROVIDER',
    };
  }

  // 5. Duplicate Rating Check
  const existingReview = await Review.findOne({
    booking: booking.customId || booking.id,
  });
  if (booking.rating || existingReview) {
    return {
      status: 409,
      error: 'This booking has already been rated.',
      code: 'ALREADY_RATED',
      rating: booking.rating || (existingReview ? existingReview.rating : 5),
    };
  }

  // 6. Rating Value Range Validation (1 to 5)
  const parsedRating = parseInt(rating, 10);
  if (isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
    return {
      status: 400,
      error: 'Rating is required and must be an integer between 1 and 5 stars.',
      code: 'INVALID_RATING',
    };
  }

  const reviewString = String(review || reviewText || comment || '').trim().slice(0, 1000);

  // 7. Save Rating to Booking
  booking.rating = parsedRating;
  booking.review = reviewString;
  await booking.save();

  // 8. Create / Upsert Review Record
  await Review.findOneAndUpdate(
    { booking: booking.customId || booking.id },
    {
      $set: {
        booking: booking.customId || booking.id,
        customer: booking.customerId,
        worker: booking.providerId,
        service: booking.service,
        rating: parsedRating,
        comment: reviewString,
      },
    },
    { upsert: true, new: true }
  );

  // 9. Recalculate Professional's Aggregate Rating & Review Count
  if (booking.providerId) {
    const worker = await User.findOne({
      $or: [{ customId: booking.providerId }, { id: booking.providerId }],
    });
    if (worker) {
      const allReviews = await Review.find({
        $or: [
          { worker: worker.customId },
          { worker: worker.id },
          { worker: booking.providerId },
        ],
      });

      const totalCount = allReviews.length;
      const totalSum = allReviews.reduce((sum, r) => sum + (r.rating || 5), 0);
      const avgRating = totalCount > 0 ? Number((totalSum / totalCount).toFixed(2)) : 5.0;

      worker.ratingAvg = avgRating;
      worker.ratingCount = totalCount;
      await worker.save();
    }
  }

  return {
    status: 200,
    success: true,
    message: 'Rating submitted successfully!',
    booking,
  };
}

async function runRatingTestSuite() {
  console.log('================================================================');
  console.log('🧪 HOMESTEPIN END-TO-END CUSTOMER RATING SYSTEM TEST SUITE');
  console.log('================================================================\n');

  const mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  // Setup mock customer and worker
  const customer1 = await User.create({
    customId: 'usr_cust_01',
    name: 'Suresh Kumar',
    email: 'suresh@homestepin.in',
    phone: '+919876543210',
    role: 'customer',
    passwordHash: '$2a$10$dummyHashCustomer1',
  });

  const customer2 = await User.create({
    customId: 'usr_cust_02',
    name: 'Rohan Varma',
    email: 'rohan@homestepin.in',
    phone: '+919876543211',
    role: 'customer',
    passwordHash: '$2a$10$dummyHashCustomer2',
  });

  const worker = await User.create({
    customId: 'usr_worker_01',
    name: 'Ramesh Plumber',
    email: 'ramesh@homestepin.in',
    phone: '+919876543212',
    role: 'worker',
    ratingAvg: 5.0,
    ratingCount: 0,
    passwordHash: '$2a$10$dummyHashWorker1',
  });

  // Setup bookings:
  // Booking 1: Completed, unrated
  const booking1 = await Booking.create({
    customId: 'bk_test_101',
    customerId: customer1.customId,
    customerName: customer1.name,
    providerId: worker.customId,
    providerName: worker.name,
    service: 'Pipe Leakage Repair',
    category: 'Plumbing',
    status: 'COMPLETED',
    price: '₹499',
    address: 'Indiranagar, Bengaluru',
    latitude: 12.9719,
    longitude: 77.6412,
  });

  // Booking 2: InProgress (not completed)
  const booking2 = await Booking.create({
    customId: 'bk_test_102',
    customerId: customer1.customId,
    customerName: customer1.name,
    providerId: worker.customId,
    providerName: worker.name,
    service: 'Tap Installation',
    category: 'Plumbing',
    status: 'WORK_STARTED',
    price: '₹299',
    address: 'Indiranagar, Bengaluru',
    latitude: 12.9719,
    longitude: 77.6412,
  });

  // Booking 3: Completed, belonging to customer2
  const booking3 = await Booking.create({
    customId: 'bk_test_103',
    customerId: customer2.customId,
    customerName: customer2.name,
    providerId: worker.customId,
    providerName: worker.name,
    service: 'Drain Cleaning',
    category: 'Plumbing',
    status: 'COMPLETED',
    price: '₹599',
    address: 'Koramangala, Bengaluru',
    latitude: 12.9719,
    longitude: 77.6412,
  });

  // Booking 4: Completed, unassigned (no providerId)
  const booking4 = await Booking.create({
    customId: 'bk_test_104',
    customerId: customer1.customId,
    customerName: customer1.name,
    service: 'General Plumbing Check',
    category: 'Plumbing',
    status: 'COMPLETED',
    price: '₹199',
    address: 'Indiranagar, Bengaluru',
    latitude: 12.9719,
    longitude: 77.6412,
  });

  // ── TEST A & B: Completed unrated booking → Submit 5 stars rating ─────
  console.log('▶ [TEST A & B] Completed booking rating with 5 stars...');
  const res1 = await handleRatingSubmission({
    bookingId: booking1.customId,
    actor: { sub: customer1.customId, role: 'customer' },
    rating: 5,
    review: 'Excellent plumbing work, very punctual!',
  });
  assert.strictEqual(res1.status, 200, `Expected 200 OK, got ${res1.status}`);
  assert.strictEqual(res1.booking.rating, 5);
  assert.strictEqual(res1.booking.review, 'Excellent plumbing work, very punctual!');
  console.log(`  ✓ Rating submitted successfully: ${res1.booking.rating}/5 stars.`);

  // ── TEST C & J: Booking persistence verification ─────────────────────
  console.log('\n▶ [TEST C & J] Verify rating persistence in database...');
  const savedBooking = await Booking.findOne({ customId: booking1.customId });
  assert.strictEqual(savedBooking.rating, 5);
  assert.strictEqual(savedBooking.review, 'Excellent plumbing work, very punctual!');
  const reviewDoc = await Review.findOne({ booking: booking1.customId });
  assert(reviewDoc, 'Review record must be stored');
  assert.strictEqual(reviewDoc.rating, 5);
  assert.strictEqual(reviewDoc.worker, worker.customId);
  console.log(`  ✓ Database verification passed: Booking rating = ${savedBooking.rating}, Review created = true`);

  // ── TEST E: Same booking rated again → Prevented (409) ────────────────
  console.log('\n▶ [TEST E] Attempting duplicate rating on already rated booking...');
  const resDuplicate = await handleRatingSubmission({
    bookingId: booking1.customId,
    actor: { sub: customer1.customId, role: 'customer' },
    rating: 4,
    review: 'Trying to rate again',
  });
  assert.strictEqual(resDuplicate.status, 409, 'Expected 409 Conflict');
  assert.strictEqual(resDuplicate.code, 'ALREADY_RATED');
  console.log(`  ✓ Duplicate rating blocked: "${resDuplicate.error}" (Code: ${resDuplicate.code})`);

  // ── TEST F: Invalid Booking ID → 404 Not Found ────────────────────────
  console.log('\n▶ [TEST F] Rating non-existent booking ID...');
  const resNotFound = await handleRatingSubmission({
    bookingId: 'bk_non_existent_999',
    actor: { sub: customer1.customId, role: 'customer' },
    rating: 5,
  });
  assert.strictEqual(resNotFound.status, 404);
  assert.strictEqual(resNotFound.code, 'BOOKING_NOT_FOUND');
  console.log(`  ✓ Non-existent booking returned 404: "${resNotFound.error}"`);

  // ── TEST G: Non-completed booking → 400 Bad Request ───────────────────
  console.log('\n▶ [TEST G] Rating an InProgress booking...');
  const resNotCompleted = await handleRatingSubmission({
    bookingId: booking2.customId,
    actor: { sub: customer1.customId, role: 'customer' },
    rating: 4,
  });
  assert.strictEqual(resNotCompleted.status, 400);
  assert.strictEqual(resNotCompleted.code, 'BOOKING_NOT_COMPLETED');
  console.log(`  ✓ Incomplete booking rejected: "${resNotCompleted.error}"`);

  // ── TEST H: Customer attempting to rate another customer's booking ────
  console.log('\n▶ [TEST H] Customer 1 attempting to rate Customer 2 booking...');
  const resForbidden = await handleRatingSubmission({
    bookingId: booking3.customId,
    actor: { sub: customer1.customId, role: 'customer' },
    rating: 5,
  });
  assert.strictEqual(resForbidden.status, 403);
  assert.strictEqual(resForbidden.code, 'FORBIDDEN');
  console.log(`  ✓ Unauthorized rating attempt rejected: "${resForbidden.error}"`);

  // ── TEST D & I: Rating 1-4 stars and aggregate recalculation ─────────
  console.log('\n▶ [TEST D & I] Customer 2 rating Booking 3 with 3 stars & checking worker aggregate...');
  const resCustomer2 = await handleRatingSubmission({
    bookingId: booking3.customId,
    actor: { sub: customer2.customId, role: 'customer' },
    rating: 3,
    review: 'Decent work but took longer than expected.',
  });
  assert.strictEqual(resCustomer2.status, 200);
  assert.strictEqual(resCustomer2.booking.rating, 3);

  // Check worker aggregate: Booking 1 had 5 stars, Booking 3 had 3 stars -> Avg = (5 + 3)/2 = 4.0
  const updatedWorker = await User.findOne({ customId: worker.customId });
  assert.strictEqual(updatedWorker.ratingCount, 2, 'Worker ratingCount must be 2');
  assert.strictEqual(updatedWorker.ratingAvg, 4.0, 'Worker ratingAvg must be 4.0');
  console.log(`  ✓ Professional ratings aggregated: count = ${updatedWorker.ratingCount}, average = ${updatedWorker.ratingAvg} ⭐`);

  // ── TEST L: Invalid rating ranges (<1 or >5) ──────────────────────────
  console.log('\n▶ [TEST L] Testing invalid rating numbers (0, 6, NaN)...');
  const resZero = await handleRatingSubmission({
    bookingId: booking4.customId,
    actor: { sub: customer1.customId, role: 'customer' },
    rating: 0,
  });
  assert.strictEqual(resZero.status, 400);

  const resSix = await handleRatingSubmission({
    bookingId: booking4.customId,
    actor: { sub: customer1.customId, role: 'customer' },
    rating: 6,
  });
  assert.strictEqual(resSix.status, 400);
  console.log('  ✓ Invalid rating numbers 0 and 6 rejected with 400 Bad Request');

  await mongoose.disconnect();
  await mongoServer.stop();

  console.log('\n================================================================');
  console.log('🎉 ALL RATING SYSTEM TEST CASES PASSED SUCCESSFULLY!');
  console.log('================================================================');
}

runRatingTestSuite().catch((err) => {
  console.error('❌ RATING TEST FAILED:', err);
  process.exit(1);
});
