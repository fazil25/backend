const mongoose = require('mongoose');

const idempotencyKeySchema = new mongoose.Schema(
  {
    customerId: { type: String, required: true, index: true },
    idempotencyKey: { type: String, required: true, index: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['IN_FLIGHT', 'COMPLETED'], default: 'IN_FLIGHT', index: true },
    response: { type: mongoose.Schema.Types.Mixed, default: null },
    statusCode: { type: Number, default: 200 },
  },
  { timestamps: true }
);

idempotencyKeySchema.index({ customerId: 1, idempotencyKey: 1 }, { unique: true });
// Automatically expire idempotency records after 24 hours
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('IdempotencyKey', idempotencyKeySchema);
