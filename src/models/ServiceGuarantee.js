const mongoose = require('mongoose');

const serviceGuaranteeSchema = new mongoose.Schema(
  {
    guaranteeId: { type: String, unique: true, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    customerName: { type: String, required: true },
    customerPhone: { type: String },
    originalBookingId: { type: String, required: true, unique: true, index: true },
    originalBooking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    workerId: { type: String, required: true, index: true },
    workerName: { type: String },
    workerPhone: { type: String },
    service: { type: String, required: true },
    category: { type: String, required: true },
    address: { type: String, required: true },
    completionDate: { type: Date, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true, index: true },
    warrantyDays: { type: Number, default: 7 },
    status: {
      type: String,
      enum: [
        'ACTIVE',
        'CLAIM_REQUESTED',
        'REVIEWING',
        'APPROVED',
        'ASSIGNED',
        'IN_PROGRESS',
        'RESOLVED',
        'REJECTED',
        'EXPIRED',
        'USED',
      ],
      default: 'ACTIVE',
      index: true,
    },
    claim: {
      requestedAt: { type: Date },
      reason: { type: String },
      customerNotes: { type: String },
      photos: [{ type: String }],
      rejectionReason: { type: String },
      reviewedBy: { type: String },
      reviewedAt: { type: Date },
    },
    revisitBookingId: { type: String, index: true },
    revisitBooking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  },
  { timestamps: true }
);

serviceGuaranteeSchema.index({ customerId: 1, status: 1 });
serviceGuaranteeSchema.index({ workerId: 1, status: 1 });
serviceGuaranteeSchema.index({ endDate: 1, status: 1 });

module.exports = mongoose.model('ServiceGuarantee', serviceGuaranteeSchema);
