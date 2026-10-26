const mongoose = require('mongoose');

const notificationOutboxSchema = new mongoose.Schema(
  {
    outboxId: { type: String, unique: true, required: true, index: true },
    notificationId: { type: String, required: true, index: true },
    recipientId: { type: String, required: true, index: true },
    type: { type: String, required: true, index: true },
    channel: { type: String, enum: ['PUSH', 'EMAIL', 'SMS', 'WEBSOCKET'], default: 'PUSH' },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'DEAD_LETTER'],
      default: 'PENDING',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lastError: { type: String, default: null },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    deliveredAt: { type: Date, default: null },
    lockedBy: { type: String, default: null, index: true },
    lockedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

notificationOutboxSchema.index({ status: 1, nextRetryAt: 1, lockedAt: 1 });
notificationOutboxSchema.index({ status: 1, lockedAt: 1 });
notificationOutboxSchema.index({ notificationId: 1, channel: 1 });
notificationOutboxSchema.index({ recipientId: 1, createdAt: -1 });

module.exports = mongoose.model('NotificationOutbox', notificationOutboxSchema);
