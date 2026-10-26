const mongoose = require('mongoose');

const callSessionSchema = new mongoose.Schema(
  {
    callSessionId: { type: String, required: true, unique: true, index: true },
    bookingId: { type: String, required: true, index: true },
    callerId: { type: String, required: true, index: true },
    callerName: { type: String, required: true },
    callerRole: { type: String, enum: ['customer', 'worker', 'admin', 'system'], required: true },
    receiverId: { type: String, required: true, index: true },
    receiverName: { type: String, required: true },
    receiverRole: { type: String, enum: ['customer', 'worker', 'admin', 'system'], required: true },
    status: {
      type: String,
      enum: ['CALL_RINGING', 'CALL_CONNECTED', 'CALL_REJECTED', 'CALL_ENDED', 'MISSED', 'FAILED'],
      default: 'CALL_RINGING',
      index: true,
    },
    startedAt: { type: Date, default: Date.now },
    connectedAt: { type: Date },
    endedAt: { type: Date },
    durationSeconds: { type: Number, default: 0 },
    endReason: { type: String },
    maskedLine: { type: Boolean, default: true },
    maskedNumber: { type: String, default: '+91-80-6900-HSIN' },
  },
  { timestamps: true }
);

callSessionSchema.index({ bookingId: 1, createdAt: -1 });

module.exports = mongoose.model('CallSession', callSessionSchema);
