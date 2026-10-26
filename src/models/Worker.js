const mongoose = require('mongoose');

const workerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
    verificationStatus: {
      type: String,
      enum: ['unsubmitted', 'pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    kyc: {
      documents: [{ kind: String, url: String, uploadedAt: Date }],
      notes: String,
      reviewedAt: Date,
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    services: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Service', index: true }],
    experienceYears: { type: Number, default: 0, min: 0, max: 50 },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    online: { type: Boolean, default: false, index: true },
    busyUntil: Date,
    availability: {
      start: { type: String, default: '09:00' },
      end: { type: String, default: '18:00' },
    },
    serviceArea: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] },
      radiusKm: { type: Number, default: 12 },
      label: String,
    },
    lastKnown: {
      type: { type: String, enum: ['Point'] },
      coordinates: [Number],
      updatedAt: Date,
    },
    earningsTotal: { type: Number, default: 0 },
  },
  { timestamps: true },
);

workerSchema.index({ 'serviceArea.coordinates': '2dsphere' });
workerSchema.index({ 'lastKnown.coordinates': '2dsphere' });
workerSchema.index({ online: 1, verificationStatus: 1 });

module.exports = mongoose.model('Worker', workerSchema);
