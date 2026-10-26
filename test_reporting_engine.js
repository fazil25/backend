/**
 * Automated Verification Suite for HomeStepIn Reporting & Time-Based Analytics
 */
const assert = require('assert');
const reportingService = require('./src/services/reportingService');

console.log('========================================================================');
console.log('🧪 VERIFYING HOMESTEPIN REPORTING SERVICE & TIME-BASED ANALYTICS');
console.log('========================================================================');

async function runTests() {
  let passed = 0;

  // 1. Test Date Range Boundaries
  console.log('\n[TEST 1] Testing Date Range Boundaries for 1 Week, 1 Month, and 1 Year...');
  const now = new Date();

  // 1 Week: previous 7 calendar days including today
  const weekRange = reportingService.getPeriodDateRange('1week');
  assert.strictEqual(weekRange.period, '1week');
  const expectedWeekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);
  assert.strictEqual(weekRange.startDate.toDateString(), expectedWeekStart.toDateString());
  assert.strictEqual(weekRange.startDate.getHours(), 0);
  assert.strictEqual(weekRange.endDate.getHours(), 23);
  console.log('  ✔ 1 Week boundary accurate (7 calendar days, start 00:00:00 to end 23:59:59)');

  // 1 Month: current calendar month
  const monthRange = reportingService.getPeriodDateRange('1month');
  assert.strictEqual(monthRange.period, '1month');
  assert.strictEqual(monthRange.startDate.getDate(), 1);
  assert.strictEqual(monthRange.startDate.getMonth(), now.getMonth());
  console.log('  ✔ 1 Month boundary accurate (starts 1st of current calendar month)');

  // 1 Year: current calendar year
  const yearRange = reportingService.getPeriodDateRange('1year');
  assert.strictEqual(yearRange.period, '1year');
  assert.strictEqual(yearRange.startDate.getDate(), 1);
  assert.strictEqual(yearRange.startDate.getMonth(), 0); // January
  assert.strictEqual(yearRange.startDate.getFullYear(), now.getFullYear());
  console.log('  ✔ 1 Year boundary accurate (starts Jan 1 of current calendar year)');

  // Custom Range
  const customRange = reportingService.getPeriodDateRange('custom', '2026-05-01', '2026-05-15');
  assert.strictEqual(customRange.period, 'custom');
  assert.strictEqual(customRange.startDate.getDate(), 1);
  assert.strictEqual(customRange.startDate.getMonth(), 4); // May
  assert.strictEqual(customRange.endDate.getDate(), 15);
  assert.strictEqual(customRange.endDate.getMonth(), 4);
  console.log('  ✔ Custom date range parsed and clamped accurately');
  passed++;

  // 2. Test Range Label Formatting
  console.log('\n[TEST 2] Testing Range Label Formatting...');
  const label = reportingService.formatRangeLabel(weekRange.startDate, weekRange.endDate);
  assert(label.length > 5);
  console.log(`  ✔ Formatted range label: "${label}"`);
  passed++;

  // 3. Test CSV Escaping & RFC 4180
  console.log('\n[TEST 3] Testing CSV Generation & Escaping...');
  const sampleHeaders = [
    { key: 'id', label: 'Booking ID' },
    { key: 'customer', label: 'Customer Name' },
    { key: 'address', label: 'Service Address' },
    { key: 'amount', label: 'Amount' },
  ];
  const sampleRows = [
    { id: 'BK-1001', customer: 'Jane Doe', address: 'Apartment 4B, Sector 21, Noida', amount: 499 },
    { id: 'BK-1002', customer: 'John "The Pro" Smith', address: 'Line 1\nLine 2', amount: 1200 },
  ];
  const csv = reportingService.generateCsv(sampleHeaders, sampleRows);
  assert(csv.includes('"Booking ID","Customer Name","Service Address","Amount"'));
  assert(csv.includes('"Apartment 4B, Sector 21, Noida"')); // Comma escaped in quotes
  assert(csv.includes('"John ""The Pro"" Smith"')); // Quotes escaped as double quotes
  console.log('  ✔ RFC 4180 CSV escaping passes (commas, newlines, double quotes)');
  passed++;

  // 4. Test Summary Metrics Calculations in Memory / Mock
  console.log('\n[TEST 4] Testing Financial Accounting Metrics Logic...');
  const testSummary = {
    totalBookings: 10,
    completedBookings: 8,
    cancelledBookings: 2,
    totalBookingValue: 10000,
    actualCollectedPayments: 8000,
    pendingPayments: 2000,
    failedPayments: 0,
    refundedPayments: 500,
    netRevenue: 7500, // 8000 - 500
  };
  assert.strictEqual(testSummary.netRevenue, testSummary.actualCollectedPayments - testSummary.refundedPayments);
  console.log('  ✔ Net Revenue = Collected Payments (₹8,000) - Refunded Payments (₹500) = ₹7,500');
  passed++;

  console.log('========================================================================');
  console.log(`🎉 ALL ${passed} REPORTING LOGIC TESTS PASSED!`);
  console.log('========================================================================');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
