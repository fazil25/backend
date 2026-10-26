const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    notificationId: { type: String, unique: true, sparse: true, index: true },
    recipientId: { type: String, required: true, index: true },
    eventId: { type: String, index: true },
    type: { type: String, required: true, index: true },
    priority: { type: String, enum: ['CRITICAL', 'HIGH', 'IMPORTANT', 'NORMAL'], default: 'NORMAL' },
    title: { type: String, required: true },
    body: { type: String, required: true },
    bookingId: { type: String, index: true },
    deepLink: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
    readAt: { type: Date, default: null },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index({ eventId: 1, recipientId: 1, type: 1 });
notificationSchema.index({ recipientId: 1, read: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
