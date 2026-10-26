const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, index: true },
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    discountType: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
    discountValue: { type: Number, default: 0 },
    percent: { type: Number, min: 0, max: 80, default: 0 },
    amount: { type: Number, min: 0, default: 0 },
    maxDiscount: { type: Number, default: 250 },
    minOrderAmount: { type: Number, default: 299 },
    applicableService: { type: String, default: 'all' },
    applicableCategory: { type: String, default: 'all' },
    startDate: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    usageLimit: { type: Number, default: 0 },
    perUserLimit: { type: Number, default: 1 },
    usageCount: { type: Number, default: 0 },
    displayOrder: { type: Number, default: 0, index: true },
    terms: { type: mongoose.Schema.Types.Mixed, default: '' },
    is_visible: { type: Boolean, default: true, index: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

couponSchema.index({ is_visible: 1, active: 1, expiresAt: 1, displayOrder: 1 });

module.exports = mongoose.model('Coupon', couponSchema);
