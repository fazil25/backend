const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    customId: { type: String, unique: true, sparse: true, index: true },
    bookingId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    workerId: { type: String, index: true, default: null },
    amount: { type: Number, required: true },
    amountSmallestUnit: { type: Number },
    currency: { type: String, default: 'INR' },
    status: {
      type: String,
      enum: [
        'CREATED',
        'PENDING',
        'AUTHORIZED',
        'PAID',
        'CAPTURED',
        'PARTIALLY_REFUNDED',
        'REFUND_IN_FLIGHT',
        'REFUNDED',
        'FAILED',
        'CANCELLED',
        'captured',
        'created',
        'pending',
        'paid',
        'failed',
        'refunded',
      ],
      default: 'PENDING',
      index: true,
    },
    provider: { type: String, default: 'Razorpay UPI Gateway' },
    orderId: { type: String, index: true, sparse: true },
    paymentId: { type: String, index: true, sparse: true },
    razorpayOrderId: { type: String, index: true, sparse: true },
    razorpayPaymentId: { type: String, index: true, sparse: true },
    razorpaySignature: { type: String, default: null },
    idempotencyKey: { type: String, index: true, sparse: true },
    method: { type: String, default: 'Razorpay UPI' },
    paidAt: { type: Date, default: null },
    refundId: { type: String, index: true, sparse: true },
    refundStatus: { type: String, default: null },
    refundAmount: { type: Number, default: 0 },
    refundReason: { type: String, default: null },
    refundedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    errorCode: { type: String, default: null },
    webhookEventsProcessed: [{ type: String }],
    raw: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

paymentSchema.index({ bookingId: 1, createdAt: -1 });
paymentSchema.index({ customerId: 1, createdAt: -1 });

module.exports = mongoose.model('Payment', paymentSchema);

