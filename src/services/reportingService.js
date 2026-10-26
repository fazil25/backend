const Booking = require('../models/Booking');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Service = require('../models/Service');
const { BOOKING_STATES, normalizeState } = require('../bookingStates');

/**
 * Calculates start and end Date boundaries for reporting periods.
 * - 1 Week: previous 7 calendar days, including today.
 * - 1 Month: current calendar month.
 * - 1 Year: current calendar year.
 * - Custom: user-provided start and end dates.
 */
function getPeriodDateRange(period = '1week', customStart = null, customEnd = null) {
  const now = new Date();
  let startDate, endDate;
  const p = String(period || '1week').toLowerCase().replace(/[\s_-]+/g, '');

  if (p === '1week' || p === 'week' || p === '7d') {
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
  } else if (p === '1month' || p === 'month' || p === '30d') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (p === '1year' || p === 'year' || p === '1y') {
    startDate = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  } else if (p === 'custom' && customStart && customEnd) {
    const sParts = String(customStart).split('T')[0].split('-').map(Number);
    startDate = new Date(sParts[0], sParts[1] - 1, sParts[2], 0, 0, 0, 0);
    const eParts = String(customEnd).split('T')[0].split('-').map(Number);
    endDate = new Date(eParts[0], eParts[1] - 1, eParts[2], 23, 59, 59, 999);
  } else {
    // Default 1 week
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
  }

  return { startDate, endDate, period: p };
}

/**
 * Formats a date range into a clean human-readable label.
 * E.g., "17 Oct 2026 – 23 Oct 2026"
 */
function formatRangeLabel(startDate, endDate) {
  const options = { day: '2-digit', month: 'short', year: 'numeric' };
  const sStr = startDate.toLocaleDateString('en-IN', options);
  const eStr = endDate.toLocaleDateString('en-IN', options);
  return `${sStr} – ${eStr}`;
}

/**
 * Canonical status mapper.
 */
function getCanonicalStatus(status) {
  if (!status) return 'Created';
  const s = String(status).trim().toUpperCase();
  if (['PENDING', 'CREATED', 'REQUESTED', 'SEARCHING_WORKER', 'OPEN'].includes(s)) return 'Created';
  if (['ACCEPTED', 'ASSIGNED', 'WORKER_ASSIGNED', 'WORKER_ACCEPTED'].includes(s)) return 'Accepted';
  if (['TRAVELLING', 'ON_THE_WAY', 'WORKER_ON_THE_WAY'].includes(s)) return 'Travelling';
  if (['ARRIVED', 'ENTERED_HOME', 'ENTEREDHOME'].includes(s)) return 'Arrived';
  if (['INPROGRESS', 'IN_PROGRESS', 'WORK_STARTED', 'STARTED'].includes(s)) return 'InProgress';
  if (['COMPLETED', 'RESOLVED', 'PAYMENT_COMPLETED', 'PAYMENT_SETTLED', 'WORK_FINISHED', 'CUSTOMER_CONFIRMED', 'FINISHED', 'SETTLED'].includes(s)) return 'Completed';
  if (['CANCELLED', 'REJECTED', 'DECLINED', 'EXPIRED'].includes(s)) return 'Cancelled';
  return status;
}

/**
 * Extracts numeric booking price reliably.
 */
function getBookingPriceNum(b) {
  if (typeof b.priceNum === 'number' && !isNaN(b.priceNum) && b.priceNum > 0) return b.priceNum;
  if (b.priceBreakdown && typeof b.priceBreakdown.totalAmount === 'number') return b.priceBreakdown.totalAmount;
  if (typeof b.price === 'string') {
    const parsed = parseFloat(b.price.replace(/[^0-9.]/g, ''));
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * Generate period summary metrics derived from authoritative Booking and Payment records.
 */
async function getPeriodSummary(startDate, endDate) {
  const bookings = await Booking.find({
    createdAt: { $gte: startDate, $lte: endDate },
  }).lean();

  const payments = await Payment.find({
    createdAt: { $gte: startDate, $lte: endDate },
  }).lean();

  // Status counts
  let newBookings = 0;
  let pendingBookings = 0;
  let acceptedBookings = 0;
  let travellingBookings = 0;
  let arrivedBookings = 0;
  let inProgressBookings = 0;
  let completedBookings = 0;
  let cancelledBookings = 0;
  let failedBookings = 0;

  let totalBookingValue = 0;
  let pendingPayments = 0;
  let failedPayments = 0;
  let refundedPayments = 0;

  const paidPaymentRecords = payments.filter(p => ['PAID', 'SUCCESS', 'CAPTURED', 'COMPLETED', 'paid', 'captured'].includes(p.status));
  const paidBookingIds = new Set(paidPaymentRecords.map(p => String(p.bookingId)));

  let actualCollectedPayments = paidPaymentRecords.reduce((sum, p) => sum + (p.amount || 0), 0);

  // Add payments from completed bookings with Cash/Paid status that don't have duplicate Payment records
  bookings.forEach(b => {
    const cStatus = getCanonicalStatus(b.status);
    const pStatus = String(b.paymentStatus || '').toUpperCase();
    const bPrice = getBookingPriceNum(b);

    totalBookingValue += bPrice;

    if (cStatus === 'Created') {
      newBookings++;
      pendingBookings++;
    } else if (cStatus === 'Accepted') {
      acceptedBookings++;
    } else if (cStatus === 'Travelling') {
      travellingBookings++;
    } else if (cStatus === 'Arrived') {
      arrivedBookings++;
    } else if (cStatus === 'InProgress') {
      inProgressBookings++;
    } else if (cStatus === 'Completed') {
      completedBookings++;
      const bId = String(b.customId || b.id || b._id);
      if (!paidBookingIds.has(bId)) {
        if (['PAID', 'SETTLED', 'SUCCESS', 'PAID ONLINE', 'CASH ON SERVICE', 'COMPLETED'].includes(pStatus)) {
          actualCollectedPayments += bPrice;
        }
      }
    } else if (cStatus === 'Cancelled') {
      cancelledBookings++;
    }

    // Check failed
    if (pStatus === 'FAILED' || b.status === 'DECLINED') {
      failedBookings++;
      failedPayments += bPrice;
    }

    // Check pending payment
    if (cStatus !== 'Cancelled' && cStatus !== 'Completed') {
      if (['PENDING', 'CREATED', 'AUTHORIZED'].includes(pStatus) || !b.paymentStatus) {
        pendingPayments += bPrice;
      }
    }

    // Refunded from booking
    if (b.refundAmount && b.refundAmount > 0) {
      refundedPayments += b.refundAmount;
    }
  });

  // Check Payment refunds and failed payments
  payments.forEach(p => {
    const s = String(p.status || '').toUpperCase();
    if (s === 'FAILED') {
      failedPayments += (p.amount || 0);
    }
    if (s === 'REFUNDED' && p.refundAmount) {
      // If payment record has explicit refund amount, ensure counted
      refundedPayments += p.refundAmount;
    }
  });

  const totalBookings = bookings.length;
  const netRevenue = Math.max(0, actualCollectedPayments - refundedPayments);
  const avgBookingValue = totalBookings > 0 ? Math.round(totalBookingValue / totalBookings) : 0;
  const cancellationRate = totalBookings > 0 ? ((cancelledBookings / totalBookings) * 100).toFixed(1) + '%' : '0.0%';

  return {
    totalBookings,
    newBookings,
    pendingBookings,
    acceptedBookings,
    travellingBookings,
    arrivedBookings,
    inProgressBookings,
    completedBookings,
    cancelledBookings,
    failedBookings,
    totalBookingValue,
    totalBookingValueFormatted: `₹${totalBookingValue.toLocaleString('en-IN')}`,
    actualCollectedPayments,
    actualCollectedPaymentsFormatted: `₹${actualCollectedPayments.toLocaleString('en-IN')}`,
    pendingPayments,
    pendingPaymentsFormatted: `₹${pendingPayments.toLocaleString('en-IN')}`,
    failedPayments,
    failedPaymentsFormatted: `₹${failedPayments.toLocaleString('en-IN')}`,
    refundedPayments,
    refundedPaymentsFormatted: `₹${refundedPayments.toLocaleString('en-IN')}`,
    netRevenue,
    netRevenueFormatted: `₹${netRevenue.toLocaleString('en-IN')}`,
    avgBookingValue,
    avgBookingValueFormatted: `₹${avgBookingValue.toLocaleString('en-IN')}`,
    cancellationRate,
  };
}

/**
 * Generate time-series trends breakdown for charts and detailed revenue reports.
 */
async function getTrendsBreakdown(periodType, startDate, endDate) {
  const bookings = await Booking.find({
    createdAt: { $gte: startDate, $lte: endDate },
  }).lean();

  const payments = await Payment.find({
    createdAt: { $gte: startDate, $lte: endDate },
    status: { $in: ['PAID', 'SUCCESS', 'CAPTURED', 'COMPLETED', 'paid', 'captured'] },
  }).lean();

  const paidBookingIds = new Set(payments.map(p => String(p.bookingId)));

  const p = String(periodType || '1week').toLowerCase();

  if (p === '1year' || p === 'year' || p === '1y') {
    // 12 Monthly Buckets (Jan through Dec of current year)
    const months = [];
    const year = startDate.getFullYear();
    for (let m = 0; m < 12; m++) {
      const mStart = new Date(year, m, 1, 0, 0, 0, 0);
      const mEnd = new Date(year, m + 1, 0, 23, 59, 59, 999);
      const monthLabel = mStart.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
      const monthShort = mStart.toLocaleDateString('en-IN', { month: 'short' });

      const mBookings = bookings.filter(b => {
        const d = new Date(b.createdAt);
        return d >= mStart && d <= mEnd;
      });

      let bookingValue = 0;
      let completedCount = 0;
      let cancelledCount = 0;
      let collected = 0;
      let pending = 0;
      let refunds = 0;

      mBookings.forEach(b => {
        const amt = getBookingPriceNum(b);
        bookingValue += amt;
        const cStatus = getCanonicalStatus(b.status);
        if (cStatus === 'Completed') {
          completedCount++;
          const bId = String(b.customId || b.id || b._id);
          if (!paidBookingIds.has(bId)) {
            collected += amt;
          }
        } else if (cStatus === 'Cancelled') {
          cancelledCount++;
        } else {
          pending += amt;
        }
        if (b.refundAmount) refunds += b.refundAmount;
      });

      // Payments created in this month
      const mPayments = payments.filter(pay => {
        const d = new Date(pay.createdAt);
        return d >= mStart && d <= mEnd;
      });
      collected += mPayments.reduce((sum, pay) => sum + (pay.amount || 0), 0);

      const netCollected = Math.max(0, collected - refunds);

      months.push({
        key: `${year}-${String(m + 1).padStart(2, '0')}`,
        label: monthShort,
        fullLabel: monthLabel,
        bookingsCount: mBookings.length,
        completedCount,
        cancelledCount,
        bookingValue,
        collected,
        pending,
        refunds,
        netCollected,
      });
    }

    return { type: 'monthly', data: months };
  }

  // Daily Buckets (For 1 Week or 1 Month)
  const days = [];
  const curr = new Date(startDate);
  while (curr <= endDate) {
    const dStart = new Date(curr.getFullYear(), curr.getMonth(), curr.getDate(), 0, 0, 0, 0);
    const dEnd = new Date(curr.getFullYear(), curr.getMonth(), curr.getDate(), 23, 59, 59, 999);
    const dateKey = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
    const dayLabel = curr.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' });
    const fullDateLabel = curr.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    const dBookings = bookings.filter(b => {
      const d = new Date(b.createdAt);
      return d >= dStart && d <= dEnd;
    });

    let bookingValue = 0;
    let completedCount = 0;
    let cancelledCount = 0;
    let collected = 0;
    let pending = 0;
    let refunds = 0;

    dBookings.forEach(b => {
      const amt = getBookingPriceNum(b);
      bookingValue += amt;
      const cStatus = getCanonicalStatus(b.status);
      if (cStatus === 'Completed') {
        completedCount++;
        const bId = String(b.customId || b.id || b._id);
        if (!paidBookingIds.has(bId)) {
          collected += amt;
        }
      } else if (cStatus === 'Cancelled') {
        cancelledCount++;
      } else {
        pending += amt;
      }
      if (b.refundAmount) refunds += b.refundAmount;
    });

    const dPayments = payments.filter(pay => {
      const d = new Date(pay.createdAt);
      return d >= dStart && d <= dEnd;
    });
    collected += dPayments.reduce((sum, pay) => sum + (pay.amount || 0), 0);

    const netCollected = Math.max(0, collected - refunds);

    days.push({
      key: dateKey,
      label: dayLabel,
      fullLabel: fullDateLabel,
      bookingsCount: dBookings.length,
      completedCount,
      cancelledCount,
      bookingValue,
      collected,
      pending,
      refunds,
      netCollected,
    });

    curr.setDate(curr.getDate() + 1);
  }

  // If month, also compute weekly comparison buckets
  let weeklyComparisons = null;
  if (p === '1month' || p === 'month' || p === '30d' || days.length > 14) {
    weeklyComparisons = [];
    const chunkSize = 7;
    for (let i = 0; i < days.length; i += chunkSize) {
      const slice = days.slice(i, i + chunkSize);
      const weekIndex = Math.floor(i / chunkSize) + 1;
      const bCount = slice.reduce((s, d) => s + d.bookingsCount, 0);
      const compCount = slice.reduce((s, d) => s + d.completedCount, 0);
      const cancCount = slice.reduce((s, d) => s + d.cancelledCount, 0);
      const bVal = slice.reduce((s, d) => s + d.bookingValue, 0);
      const coll = slice.reduce((s, d) => s + d.collected, 0);
      const ref = slice.reduce((s, d) => s + d.refunds, 0);
      weeklyComparisons.push({
        week: `Week ${weekIndex}`,
        range: `${slice[0].fullLabel} – ${slice[slice.length - 1].fullLabel}`,
        bookingsCount: bCount,
        completedCount: compCount,
        cancelledCount: cancCount,
        bookingValue: bVal,
        collected: coll,
        refunds: ref,
        netCollected: Math.max(0, coll - ref),
      });
    }
  }

  return { type: 'daily', data: days, weeklyComparisons };
}

/**
 * Status and Service Distributions for Charts.
 */
async function getDistributions(startDate, endDate) {
  const bookings = await Booking.find({
    createdAt: { $gte: startDate, $lte: endDate },
  }).lean();

  const total = bookings.length;

  // 1. Status Distribution
  const statusMap = {
    Created: { count: 0, color: '#F59E0B' },
    Accepted: { count: 0, color: '#3B82F6' },
    Travelling: { count: 0, color: '#8B5CF6' },
    Arrived: { count: 0, color: '#06B6D4' },
    InProgress: { count: 0, color: '#EC4899' },
    Completed: { count: 0, color: '#10B981' },
    Cancelled: { count: 0, color: '#EF4444' },
  };

  bookings.forEach(b => {
    const c = getCanonicalStatus(b.status);
    if (statusMap[c]) {
      statusMap[c].count++;
    } else {
      statusMap.Created.count++;
    }
  });

  const statusDistribution = Object.keys(statusMap).map(st => ({
    status: st,
    count: statusMap[st].count,
    percentage: total > 0 ? Math.round((statusMap[st].count / total) * 100) : 0,
    color: statusMap[st].color,
  }));

  // 2. Category Performance
  const catMap = {};
  bookings.forEach(b => {
    const cat = b.category || 'General Services';
    if (!catMap[cat]) catMap[cat] = { total: 0, completed: 0, revenue: 0 };
    catMap[cat].total++;
    const amt = getBookingPriceNum(b);
    if (getCanonicalStatus(b.status) === 'Completed') {
      catMap[cat].completed++;
      catMap[cat].revenue += amt;
    }
  });

  const categoryPerformance = Object.keys(catMap).map(cat => ({
    category: cat,
    totalBookings: catMap[cat].total,
    completedBookings: catMap[cat].completed,
    revenue: catMap[cat].revenue,
    percentage: total > 0 ? Math.round((catMap[cat].total / total) * 100) : 0,
  })).sort((a, b) => b.totalBookings - a.totalBookings);

  // 3. Payment Status Distribution
  const payMap = {
    PAID: { count: 0, amount: 0, color: '#10B981' },
    PENDING: { count: 0, amount: 0, color: '#F59E0B' },
    FAILED: { count: 0, amount: 0, color: '#EF4444' },
    REFUNDED: { count: 0, amount: 0, color: '#6366F1' },
  };

  bookings.forEach(b => {
    const ps = String(b.paymentStatus || '').toUpperCase();
    const amt = getBookingPriceNum(b);
    if (['PAID', 'SETTLED', 'SUCCESS', 'PAID ONLINE', 'CASH ON SERVICE', 'COMPLETED'].includes(ps)) {
      payMap.PAID.count++;
      payMap.PAID.amount += amt;
    } else if (ps === 'FAILED') {
      payMap.FAILED.count++;
      payMap.FAILED.amount += amt;
    } else if (ps === 'REFUNDED' || (b.refundAmount && b.refundAmount > 0)) {
      payMap.REFUNDED.count++;
      payMap.REFUNDED.amount += (b.refundAmount || amt);
    } else {
      payMap.PENDING.count++;
      payMap.PENDING.amount += amt;
    }
  });

  const paymentStatusDistribution = Object.keys(payMap).map(ps => ({
    status: ps,
    count: payMap[ps].count,
    amount: payMap[ps].amount,
    percentage: total > 0 ? Math.round((payMap[ps].count / total) * 100) : 0,
    color: payMap[ps].color,
  }));

  // 4. Top Performing Services
  const srvMap = {};
  bookings.forEach(b => {
    const srv = b.service || 'Standard Service';
    if (!srvMap[srv]) {
      srvMap[srv] = {
        name: srv,
        category: b.category || 'General',
        bookingsCount: 0,
        completedCount: 0,
        revenue: 0,
        ratings: [],
      };
    }
    srvMap[srv].bookingsCount++;
    const amt = getBookingPriceNum(b);
    if (getCanonicalStatus(b.status) === 'Completed') {
      srvMap[srv].completedCount++;
      srvMap[srv].revenue += amt;
    }
    if (b.rating) srvMap[srv].ratings.push(b.rating);
  });

  const topServices = Object.values(srvMap).map(s => ({
    name: s.name,
    category: s.category,
    bookingsCount: s.bookingsCount,
    completedCount: s.completedCount,
    revenue: s.revenue,
    avgRating: s.ratings.length > 0 ? (s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length).toFixed(1) : '5.0',
  })).sort((a, b) => b.bookingsCount - a.bookingsCount).slice(0, 8);

  return {
    statusDistribution,
    categoryPerformance,
    paymentStatusDistribution,
    topServices,
  };
}

/**
 * Detailed Customer Report.
 */
async function getCustomerReport(startDate, endDate) {
  const periodBookings = await Booking.find({
    createdAt: { $gte: startDate, $lte: endDate },
  }).lean();

  const customerMap = {};

  periodBookings.forEach(b => {
    const cId = String(b.customerId || b.customerPhone || b.customerName || 'anon');
    if (!customerMap[cId]) {
      customerMap[cId] = {
        customerId: cId,
        name: b.customerName || 'Valued Customer',
        phone: b.customerPhone || '—',
        bookingsCount: 0,
        completedCount: 0,
        totalSpent: 0,
        lastBookingDate: b.createdAt,
      };
    }
    customerMap[cId].bookingsCount++;
    const amt = getBookingPriceNum(b);
    if (getCanonicalStatus(b.status) === 'Completed') {
      customerMap[cId].completedCount++;
      customerMap[cId].totalSpent += amt;
    }
    if (new Date(b.createdAt) > new Date(customerMap[cId].lastBookingDate)) {
      customerMap[cId].lastBookingDate = b.createdAt;
    }
  });

  const customerList = Object.values(customerMap);
  const totalUniqueCustomers = customerList.length;

  // Repeat customers: more than 1 booking in period
  const repeatCustomers = customerList.filter(c => c.bookingsCount > 1);

  // New customers: customers registered in the period OR whose earliest booking ever is in the period
  const newUsers = await User.find({
    role: 'customer',
    createdAt: { $gte: startDate, $lte: endDate },
  }).lean();

  const newCustomersCount = Math.max(newUsers.length, customerList.filter(c => c.bookingsCount === 1).length);

  return {
    summary: {
      totalCustomers: totalUniqueCustomers,
      newCustomersCount,
      repeatCustomersCount: repeatCustomers.length,
      retentionRate: totalUniqueCustomers > 0 ? ((repeatCustomers.length / totalUniqueCustomers) * 100).toFixed(1) + '%' : '0%',
    },
    customers: customerList.sort((a, b) => b.bookingsCount - a.bookingsCount),
  };
}

/**
 * Detailed Worker Performance Report.
 */
async function getWorkerReport(startDate, endDate) {
  const workers = await User.find({ role: 'worker' }).lean();

  const bookings = await Booking.find({
    createdAt: { $gte: startDate, $lte: endDate },
    providerId: { $ne: null },
  }).lean();

  const workerMap = {};
  workers.forEach(w => {
    const wId = String(w.customId || w._id);
    workerMap[wId] = {
      workerId: wId,
      name: w.name,
      employeeId: w.employeeId || wId,
      phone: w.phone || '—',
      services: w.services || [],
      online: Boolean(w.online),
      ratingAvg: typeof w.ratingAvg === 'number' ? w.ratingAvg : 4.9,
      assignments: 0,
      completedJobs: 0,
      cancellations: 0,
      earnings: 0,
    };
  });

  bookings.forEach(b => {
    const wId = String(b.providerId || '');
    if (!workerMap[wId]) {
      workerMap[wId] = {
        workerId: wId,
        name: b.providerName || 'Worker ' + wId,
        employeeId: wId,
        phone: b.providerPhone || '—',
        services: [b.service],
        online: false,
        ratingAvg: 4.8,
        assignments: 0,
        completedJobs: 0,
        cancellations: 0,
        earnings: 0,
      };
    }

    workerMap[wId].assignments++;
    const cStatus = getCanonicalStatus(b.status);
    const amt = getBookingPriceNum(b);

    if (cStatus === 'Completed') {
      workerMap[wId].completedJobs++;
      // Worker payout standard 80% of booking price
      workerMap[wId].earnings += Math.round(amt * 0.8);
    } else if (cStatus === 'Cancelled') {
      workerMap[wId].cancellations++;
    }
  });

  const workerList = Object.values(workerMap).map(w => {
    const acceptanceRate = w.assignments > 0 ? (((w.completedJobs + (w.assignments - w.completedJobs - w.cancellations)) / w.assignments) * 100).toFixed(1) + '%' : '100.0%';
    return {
      ...w,
      acceptanceRate,
      earningsFormatted: `₹${w.earnings.toLocaleString('en-IN')}`,
    };
  });

  return {
    totalWorkers: workers.length,
    activeWorkersInPeriod: workerList.filter(w => w.assignments > 0).length,
    workers: workerList.sort((a, b) => b.completedJobs - a.completedJobs),
  };
}

/**
 * Detailed Cancellation Report.
 */
async function getCancellationReport(startDate, endDate) {
  const cancelledBookings = await Booking.find({
    createdAt: { $gte: startDate, $lte: endDate },
    status: { $in: ['CANCELLED', 'Cancelled', 'DECLINED', 'REJECTED', 'EXPIRED'] },
  }).sort({ updatedAt: -1 }).lean();

  const reasonsMap = {};
  let totalRefundedAmount = 0;
  let refundedCount = 0;

  const records = cancelledBookings.map(b => {
    const reason = b.cancellationReason || 'Customer requested cancellation';
    reasonsMap[reason] = (reasonsMap[reason] || 0) + 1;

    const refundAmt = typeof b.refundAmount === 'number' ? b.refundAmount : 0;
    if (refundAmt > 0) {
      totalRefundedAmount += refundAmt;
      refundedCount++;
    }

    return {
      bookingId: b.customId || b.id || b._id.toString(),
      customerName: b.customerName,
      customerPhone: b.customerPhone || '—',
      service: b.service,
      bookingAmount: getBookingPriceNum(b),
      cancellationTimestamp: b.updatedAt || b.createdAt,
      reason,
      cancelledBy: b.cancellationReason?.toLowerCase().includes('partner') ? 'Partner' : 'Customer',
      refundAmount: refundAmt,
      refundStatus: b.refundStatus || (refundAmt > 0 ? 'REFUNDED' : 'NONE'),
      refundMethod: b.refundMethod || 'Original Payment Source',
    };
  });

  const topReasons = Object.keys(reasonsMap).map(r => ({
    reason: r,
    count: reasonsMap[r],
  })).sort((a, b) => b.count - a.count);

  return {
    totalCancelled: cancelledBookings.length,
    totalRefundedAmount,
    totalRefundedAmountFormatted: `₹${totalRefundedAmount.toLocaleString('en-IN')}`,
    refundedCount,
    topReasons,
    records,
  };
}

/**
 * Filtered, paginated Bookings Report with comprehensive financial & booking details.
 */
async function getBookingReport(filters = {}, page = 1, limit = 50) {
  const { startDate, endDate, status, service, workerId, customerId, paymentStatus, search } = filters;

  const query = {};

  if (startDate && endDate) {
    query.createdAt = { $gte: startDate, $lte: endDate };
  }

  if (status && status !== 'all') {
    const s = String(status).trim().toUpperCase();
    if (['PENDING', 'CREATED', 'REQUESTED', 'SEARCHING_WORKER', 'OPEN'].includes(s)) {
      query.status = { $in: ['PENDING', 'CONFIRMED', 'CREATED', 'REQUESTED', 'SEARCHING_WORKER', 'OPEN'] };
    } else if (['ACCEPTED', 'ASSIGNED', 'WORKER_ASSIGNED', 'WORKER_ACCEPTED'].includes(s)) {
      query.status = { $in: ['WORKER_ASSIGNED', 'ASSIGNED', 'WORKER_ACCEPTED', 'ACCEPTED'] };
    } else if (['TRAVELLING', 'ON_THE_WAY', 'WORKER_ON_THE_WAY'].includes(s)) {
      query.status = { $in: ['TRAVELLING', 'WORKER_ON_THE_WAY', 'ON_THE_WAY'] };
    } else if (['ARRIVED', 'ENTERED_HOME', 'ENTEREDHOME'].includes(s)) {
      query.status = { $in: ['ARRIVED', 'ENTERED_HOME', 'ENTEREDHOME'] };
    } else if (['INPROGRESS', 'IN_PROGRESS', 'WORK_STARTED', 'STARTED'].includes(s)) {
      query.status = { $in: ['WORK_STARTED', 'IN_PROGRESS', 'INPROGRESS', 'STARTED'] };
    } else if (['COMPLETED', 'RESOLVED', 'PAYMENT_COMPLETED', 'PAYMENT_SETTLED'].includes(s)) {
      query.status = { $in: ['WORK_FINISHED', 'CUSTOMER_CONFIRMED', 'PAYMENT_COMPLETED', 'PAYMENT_SETTLED', 'COMPLETED', 'RESOLVED', 'Completed'] };
    } else if (['CANCELLED', 'REJECTED', 'DECLINED', 'EXPIRED'].includes(s)) {
      query.status = { $in: ['CANCELLED', 'REJECTED', 'DECLINED', 'EXPIRED', 'Cancelled'] };
    } else {
      query.status = new RegExp(`^${status}$`, 'i');
    }
  }

  if (service && service !== 'all') {
    query.service = new RegExp(`^${service}$`, 'i');
  }

  if (workerId && workerId !== 'all') {
    query.$and = (query.$and || []).concat([{ $or: [{ providerId: workerId }, { worker: workerId }] }]);
  }

  if (customerId && customerId !== 'all') {
    query.$and = (query.$and || []).concat([{ $or: [{ customerId }, { customer: customerId }] }]);
  }

  if (paymentStatus && paymentStatus !== 'all') {
    query.paymentStatus = new RegExp(`^${paymentStatus}$`, 'i');
  }

  if (search) {
    const q = String(search).trim();
    query.$or = [
      { customId: new RegExp(q, 'i') },
      { customerName: new RegExp(q, 'i') },
      { customerPhone: new RegExp(q, 'i') },
      { service: new RegExp(q, 'i') },
      { providerName: new RegExp(q, 'i') },
      { address: new RegExp(q, 'i') },
    ];
  }

  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.max(1, parseInt(limit) || 50);

  const total = await Booking.countDocuments(query);
  const rawBookings = await Booking.find(query)
    .sort({ createdAt: -1 })
    .skip((pageNum - 1) * limitNum)
    .limit(limitNum)
    .lean();

  const formattedBookings = rawBookings.map(b => {
    const pb = b.priceBreakdown || {};
    const basePrice = pb.itemSubtotal || pb.basePrice || b.priceNum || 0;
    const fee = pb.convenienceFee ?? 0;
    const tax = pb.tax ?? 0;
    const discount = pb.discount ?? 0;
    const totalPrice = getBookingPriceNum(b);

    return {
      id: b.customId || b.id || b._id.toString(),
      createdAt: b.createdAt,
      customerName: b.customerName,
      customerPhone: b.customerPhone || '—',
      category: b.category,
      service: b.service,
      date: b.date,
      time: b.time,
      scheduledAt: b.scheduledAt,
      address: b.address,
      providerId: b.providerId,
      providerName: b.providerName || 'Unassigned',
      status: getCanonicalStatus(b.status),
      rawStatus: b.status,
      basePrice,
      basePriceFormatted: `₹${basePrice}`,
      convenienceFee: fee,
      convenienceFeeFormatted: fee === 0 ? 'FREE' : `₹${fee}`,
      tax,
      taxFormatted: `₹${tax}`,
      discount,
      discountFormatted: discount > 0 ? `-₹${discount}` : '₹0',
      totalPrice,
      totalPriceFormatted: `₹${totalPrice}`,
      paymentStatus: b.paymentStatus || 'PENDING',
      paymentMethod: b.paymentMethod || 'Online / UPI',
      cancellationReason: b.cancellationReason || null,
      refundAmount: b.refundAmount || 0,
      refundStatus: b.refundStatus || 'NONE',
    };
  });

  return {
    bookings: formattedBookings,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
    },
  };
}

/**
 * Filtered, paginated Payment Report.
 */
async function getPaymentReport(filters = {}, page = 1, limit = 50) {
  const { startDate, endDate, paymentStatus, search } = filters;

  const paymentQuery = {};
  if (startDate && endDate) {
    paymentQuery.createdAt = { $gte: startDate, $lte: endDate };
  }

  if (paymentStatus && paymentStatus !== 'all') {
    paymentQuery.status = new RegExp(`^${paymentStatus}$`, 'i');
  }

  if (search) {
    const q = String(search).trim();
    paymentQuery.$or = [
      { customId: new RegExp(q, 'i') },
      { orderId: new RegExp(q, 'i') },
      { bookingId: new RegExp(q, 'i') },
      { customerId: new RegExp(q, 'i') },
    ];
  }

  const payments = await Payment.find(paymentQuery).sort({ createdAt: -1 }).lean();

  // Also fetch completed bookings in range for bookings that don't have Payment records
  const paidBookingIds = new Set(payments.map(p => String(p.bookingId)));
  const bookingQuery = {
    $or: [
      { status: { $in: ['COMPLETED', 'Completed', 'WORK_FINISHED', 'PAYMENT_SETTLED'] } },
      { paymentStatus: { $in: ['PAID', 'Settled', 'Paid', 'SUCCESS', 'Cash on Service'] } },
    ],
  };
  if (startDate && endDate) {
    bookingQuery.createdAt = { $gte: startDate, $lte: endDate };
  }

  const completedBookings = await Booking.find(bookingQuery).sort({ createdAt: -1 }).lean();

  const synthesized = completedBookings
    .filter(b => !paidBookingIds.has(String(b.customId || b.id || b._id)))
    .map(b => ({
      _id: b._id,
      customId: `PAY-${b.customId || b.id || b._id.toString()}`,
      bookingId: b.customId || b.id || b._id.toString(),
      customerId: b.customerId,
      customerName: b.customerName,
      amount: getBookingPriceNum(b),
      currency: 'INR',
      status: 'PAID',
      method: b.paymentMethod || 'Cash on Service',
      provider: b.paymentMethod?.includes('Cash') ? 'Cash on Service' : 'Razorpay Gateway',
      refundAmount: b.refundAmount || 0,
      refundStatus: b.refundStatus || 'NONE',
      refundReason: b.cancellationReason || null,
      createdAt: b.createdAt,
    }));

  const allTransactions = [...payments.map(p => ({
    _id: p._id,
    customId: p.customId || p.paymentId || p.orderId || `TXN-${p._id.toString().slice(-8)}`,
    bookingId: p.bookingId,
    customerId: p.customerId,
    customerName: p.customerName || 'Customer',
    amount: p.amount || 0,
    currency: p.currency || 'INR',
    status: String(p.status || '').toUpperCase(),
    method: p.method || 'Razorpay Gateway',
    provider: p.provider || 'Razorpay',
    refundAmount: p.refundAmount || 0,
    refundStatus: p.refundStatus || 'NONE',
    refundReason: p.refundReason || null,
    createdAt: p.createdAt,
  })), ...synthesized].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.max(1, parseInt(limit) || 50);
  const total = allTransactions.length;
  const paginated = allTransactions.slice((pageNum - 1) * limitNum, pageNum * limitNum);

  return {
    payments: paginated,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
    },
  };
}

/**
 * Generates CSV string for exporting reports.
 */
function generateCsv(arg1, arg2) {
  let columns, dataArray;
  if (Array.isArray(arg1) && arg1.length > 0 && typeof arg1[0] === 'object' && 'key' in arg1[0] && 'label' in arg1[0]) {
    columns = arg1;
    dataArray = Array.isArray(arg2) ? arg2 : [];
  } else {
    dataArray = Array.isArray(arg1) ? arg1 : [];
    columns = Array.isArray(arg2) ? arg2 : [];
  }

  const header = columns.map(c => {
    const lbl = c && c.label !== undefined ? String(c.label) : (c && c.key ? String(c.key) : '');
    return `"${lbl.replace(/"/g, '""')}"`;
  }).join(',');

  const rows = dataArray.map(item => {
    return columns.map(col => {
      let val = item ? item[col.key] : '';
      if (val === undefined || val === null) val = '';
      if (typeof val === 'object' && val instanceof Date) val = val.toISOString();
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    }).join(',');
  });

  return [header, ...rows].join('\r\n');
}

module.exports = {
  getPeriodDateRange,
  formatRangeLabel,
  getCanonicalStatus,
  getBookingPriceNum,
  getPeriodSummary,
  getTrendsBreakdown,
  getDistributions,
  getCustomerReport,
  getWorkerReport,
  getCancellationReport,
  getBookingReport,
  getPaymentReport,
  generateCsv,
};
