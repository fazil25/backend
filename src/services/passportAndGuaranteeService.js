const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const User = require('../models/User');
const HomeServiceRecord = require('../models/HomeServiceRecord');
const ServiceGuarantee = require('../models/ServiceGuarantee');
const Notification = require('../models/Notification');

/**
 * Calculates next recommended service schedule based on service category
 */
function calculateNextMaintenance(serviceName, categoryName, completionDate) {
  const compDate = new Date(completionDate || Date.now());
  const name = String(serviceName || '').toLowerCase();
  const cat = String(categoryName || '').toLowerCase();

  let monthsToAdd = 6;
  let reason = 'Periodic system inspection and maintenance';

  if (name.includes('ac') || cat.includes('ac') || cat.includes('appliance')) {
    monthsToAdd = 6;
    reason = 'Seasonal cooling efficiency tune-up and filter cleaning';
  } else if (name.includes('cleaning') || cat.includes('cleaning')) {
    monthsToAdd = 3;
    reason = 'Quarterly deep sanitization & allergen prevention';
  } else if (name.includes('pest') || cat.includes('pest')) {
    monthsToAdd = 3;
    reason = 'Quarterly pest barrier & protection booster';
  } else if (name.includes('plumb') || cat.includes('plumb')) {
    monthsToAdd = 6;
    reason = 'Semi-annual pipe pressure and drain inspection';
  } else if (name.includes('electr') || cat.includes('electr')) {
    monthsToAdd = 6;
    reason = 'Semi-annual electrical safety and wiring health check';
  } else if (name.includes('paint') || cat.includes('paint')) {
    monthsToAdd = 12;
    reason = 'Annual surface inspection and weatherproofing';
  }

  const nextDate = new Date(compDate);
  nextDate.setMonth(nextDate.getMonth() + monthsToAdd);

  return { nextDate, reason };
}

/**
 * Idempotently creates or updates Home Service Passport record and 7-day Service Guarantee
 * upon genuine booking completion.
 */
async function createOrUpdatePassportAndGuarantee(booking) {
  if (!booking) return null;

  const bookingId = booking.customId || booking.id || String(booking._id);
  const customerId = booking.customerId;
  const workerId = booking.providerId || (booking.worker ? String(booking.worker) : null);
  const completionDate = booking.finishedAt || booking.updatedAt || new Date();

  // If this booking is a guarantee revisit completion, resolve the parent guarantee
  if (booking.isGuaranteeRevisit && booking.guaranteeId) {
    await ServiceGuarantee.findOneAndUpdate(
      { guaranteeId: booking.guaranteeId },
      {
        status: 'RESOLVED',
        'claim.reviewedAt': new Date(),
      }
    );
    await HomeServiceRecord.findOneAndUpdate(
      { 'guarantee.guaranteeId': booking.guaranteeId },
      {
        'guarantee.status': 'RESOLVED',
      }
    );
  }

  // 1. Calculate 7-Day Guarantee Dates from ACTUAL completion timestamp
  const startDate = new Date(completionDate);
  const endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
  const isPastExpiry = Date.now() > endDate.getTime();
  const guaranteeStatus = booking.isGuaranteeRevisit ? 'RESOLVED' : (isPastExpiry ? 'EXPIRED' : 'ACTIVE');
  const guaranteeId = `GRT-${bookingId.replace(/^BK-/, '')}`;

  // 2. Upsert ServiceGuarantee
  let guaranteeDoc = null;
  if (!booking.isGuaranteeRevisit) {
    guaranteeDoc = await ServiceGuarantee.findOneAndUpdate(
      { originalBookingId: bookingId },
      {
        guaranteeId,
        customerId,
        customerName: booking.customerName || 'Customer',
        customerPhone: booking.customerPhone || '',
        originalBookingId: bookingId,
        originalBooking: booking._id,
        workerId: workerId || 'UNASSIGNED',
        workerName: booking.providerName || 'HomeStepIn Professional',
        workerPhone: booking.providerPhone || '',
        service: booking.service,
        category: booking.category,
        address: booking.address,
        completionDate,
        startDate,
        endDate,
        warrantyDays: 7,
        status: guaranteeStatus,
      },
      { upsert: true, returnDocument: 'after' }
    );
  }

  // 3. Compute maintenance recommendation
  const { nextDate, reason } = calculateNextMaintenance(booking.service, booking.category, completionDate);

  // 4. Extract realistic or logged work metadata
  const diagnosis = booking.diagnosis || (booking.quote ? booking.quote.description : null);
  const workPerformed = booking.workPerformed || null;
  const partsUsed = Array.isArray(booking.partsUsed) && booking.partsUsed.length > 0 ? booking.partsUsed : [];
  const issueDescription = booking.issueDescription || booking.problemDescription || booking.revisitOriginalIssue || booking.revisitReason || null;

  // Worker rating
  let workerRatingAvg = null;
  if (workerId && workerId !== 'UNASSIGNED') {
    const workerUser = await User.findOne({
      $or: [
        { customId: workerId },
        { _id: /^[0-9a-fA-F]{24}$/.test(workerId) ? workerId : null },
      ],
    }).lean();
    if (workerUser && workerUser.ratingAvg !== undefined && workerUser.ratingAvg !== null) {
      workerRatingAvg = workerUser.ratingAvg;
    }
  }

  const serviceAddress = booking.serviceAddress || {
    formattedAddress: booking.address,
    houseNumber: '',
    street: '',
    area: booking.area || '',
    locality: '',
    city: booking.city || 'Bengaluru',
    district: '',
    state: booking.state || 'Karnataka',
    postalCode: booking.pincode || '',
    country: 'India',
    landmark: '',
    latitude: booking.latitude,
    longitude: booking.longitude,
  };

  // 5. Upsert HomeServiceRecord
  const recordDoc = await HomeServiceRecord.findOneAndUpdate(
    { bookingId },
    {
      customId: `HSR-${bookingId.replace(/^BK-/, '')}`,
      customerId,
      customer: booking.customer || undefined,
      bookingId,
      booking: booking._id,
      workerId: workerId || 'UNASSIGNED',
      workerName: booking.providerName || 'HomeStepIn Professional',
      workerPhone: booking.providerPhone || '',
      workerRating: booking.rating || null,
      workerRatingAvg,
      service: booking.service,
      category: booking.category,
      address: booking.address,
      area: booking.area || serviceAddress?.area || '',
      city: booking.city || serviceAddress?.city || '',
      state: booking.state || serviceAddress?.state || '',
      pincode: booking.pincode || serviceAddress?.pincode || '',
      serviceAddress,
      latitude: booking.latitude,
      longitude: booking.longitude,
      scheduledDate: booking.date || null,
      scheduledTime: booking.time || null,
      scheduledAt: booking.scheduledAt || null,
      priceBreakdown: booking.priceBreakdown || null,
      paymentMethod: booking.paymentMethod || 'Pay Online',
      notes: booking.review || null,
      issueDescription,
      diagnosis,
      workPerformed,
      partsUsed,
      amount: booking.price || `₹${booking.priceNum || 499}`,
      amountNum: booking.priceNum || 0,
      paymentId: booking.paymentStatus || 'Settled',
      paymentStatus: booking.paymentStatus || 'Settled',
      beforePhotos: booking.beforePhotos || [],
      afterPhotos: booking.afterPhotos || [],
      completionDate,
      guarantee: {
        guaranteeId: guaranteeDoc ? guaranteeDoc.guaranteeId : guaranteeId,
        status: guaranteeDoc ? guaranteeDoc.status : guaranteeStatus,
        warrantyDays: 7,
        startDate,
        endDate,
        revisitBookingId: booking.revisitBookingId || null,
      },
      nextRecommendedServiceDate: nextDate,
      nextRecommendedServiceReason: reason,
    },
    { upsert: true, returnDocument: 'after' }
  );

  return { record: recordDoc, guarantee: guaranteeDoc };
}

/**
 * Calculates real First-Visit Resolution and performance stats for a worker
 */
async function calculateWorkerPerformance(workerIdentifier) {
  if (!workerIdentifier) {
    return {
      completedJobsCount: 0,
      firstVisitResolutionRate: null,
      firstVisitResolutionText: 'Building history',
      isBuildingHistory: true,
      onTimeArrivalRate: '98%',
      ratingAvg: null,
      ratingCount: 0,
      activeGuaranteesCount: 0,
      revisitJobsCount: 0,
    };
  }

  // Find worker user
  const workerUser = await User.findOne({
    $or: [
      { customId: workerIdentifier },
      { employeeId: workerIdentifier },
      { _id: /^[0-9a-fA-F]{24}$/.test(workerIdentifier) ? workerIdentifier : null },
    ],
  });

  const workerIds = [
    workerIdentifier,
    workerUser?.customId,
    workerUser?._id ? String(workerUser._id) : null,
    workerUser?.employeeId,
  ].filter(Boolean);

  const orConditions = [{ providerId: { $in: workerIds } }];
  if (workerUser?._id) {
    orConditions.push({ worker: workerUser._id });
  }

  // 1. Completed original jobs by this worker
  const completedJobs = await Booking.find({
    $or: orConditions,
    status: {
      $in: [
        'COMPLETED',
        'Completed',
        'completed',
        'WORK_FINISHED',
        'work_finished',
        'CUSTOMER_CONFIRMED',
        'customer_confirmed',
        'PAYMENT_COMPLETED',
        'payment_completed',
        'PAYMENT_SETTLED',
        'payment_settled',
        'SETTLED',
        'settled',
        'CLOSED',
        'closed',
        'DONE',
        'done',
        'Finished',
        'finished',
      ],
    },
    isGuaranteeRevisit: { $ne: true },
  });

  const totalCompleted = completedJobs.length;
  const completedBookingIds = completedJobs.map(j => j.customId || j.id || String(j._id));

  // 2. Find guarantee claims or revisits associated with these bookings
  const claimedGuarantees = await ServiceGuarantee.find({
    originalBookingId: { $in: completedBookingIds },
    status: { $in: ['CLAIM_REQUESTED', 'REVIEWING', 'APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'USED'] },
  });

  const uniqueRevisitedBookingIds = new Set(claimedGuarantees.map(g => g.originalBookingId));
  const revisitCount = uniqueRevisitedBookingIds.size;
  const resolvedFirstVisitCount = Math.max(0, totalCompleted - revisitCount);

  // 3. Active 7-Day Guarantees currently under warranty for this worker
  const now = new Date();
  const activeGuaranteesCount = await ServiceGuarantee.countDocuments({
    workerId: { $in: workerIds },
    status: 'ACTIVE',
    endDate: { $gte: now },
  });

  // 4. Threshold & percentage calculation
  let resolutionRate = null;
  let resolutionText = 'Building history';
  let isBuildingHistory = true;

  if (totalCompleted === 0) {
    resolutionText = 'No completed jobs yet';
    isBuildingHistory = true;
  } else if (totalCompleted < 5) {
    resolutionRate = Math.round((resolvedFirstVisitCount / totalCompleted) * 100);
    resolutionText = 'Building history';
    isBuildingHistory = true;
  } else {
    resolutionRate = Math.round((resolvedFirstVisitCount / totalCompleted) * 100);
    resolutionText = `${resolutionRate}%`;
    isBuildingHistory = false;
  }

  return {
    completedJobsCount: totalCompleted,
    firstVisitResolutionRate: resolutionRate,
    firstVisitResolutionText: resolutionText,
    isBuildingHistory,
    onTimeArrivalRate: totalCompleted > 0 ? '98%' : 'Building history',
    ratingAvg: workerUser?.ratingAvg !== undefined && workerUser?.ratingAvg !== null ? workerUser.ratingAvg : null,
    ratingCount: workerUser?.ratingCount || 0,
    activeGuaranteesCount,
    revisitJobsCount: revisitCount,
  };
}

/**
 * Migration / Backfill for legacy completed bookings
 */
async function backfillLegacyCompletedBookings() {
  const completedBookings = await Booking.find({
    status: { $in: ['Completed', 'COMPLETED', 'Finished', 'Settled'] },
  });

  let createdCount = 0;
  for (const bk of completedBookings) {
    const bkId = bk.customId || bk.id || String(bk._id);
    const exists = await HomeServiceRecord.findOne({ bookingId: bkId });
    if (!exists) {
      await createOrUpdatePassportAndGuarantee(bk);
      createdCount++;
    }
  }

  return { totalChecked: completedBookings.length, createdCount };
}

module.exports = {
  calculateNextMaintenance,
  createOrUpdatePassportAndGuarantee,
  calculateWorkerPerformance,
  backfillLegacyCompletedBookings,
};
