const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema(
  {
    customId: { type: String, unique: true, sparse: true, index: true },
    name: { type: String, required: true, trim: true, unique: true, index: true },
    shortName: { type: String, default: '' },
    slug: { type: String, unique: true, sparse: true, index: true },
    category: { type: String, required: true, index: true },
    icon: { type: String, default: '🛠️' },
    imageUrl: { type: String, default: '' },
    description: { type: String, default: '' },
    detailedDescription: { type: String, default: '' },
    images: [String],
    priceStart: { type: String, default: '₹499' },
    priceNum: { type: Number, default: 499, min: 0 },
    discount: { type: Number, default: 0 },
    finalPrice: { type: Number, default: 0 },
    priceUnit: { type: String, default: 'per service' },
    minCharge: { type: Number, default: 0 },
    badge: { type: String, default: 'PRO' },
    highlights: [String],
    features: [String],
    duration: { type: String, default: '45 mins' },
    durationMinutes: { type: Number, default: 45 },
    ratingAvg: { type: Number, default: 4.8 },
    ratingCount: { type: Number, default: 45 },
    inclusions: [String],
    exclusions: [String],
    instructions: { type: String, default: '' },
    requirements: { type: String, default: '' },
    displayOrder: { type: Number, default: 0, index: true },
    popular: { type: Boolean, default: false },
    featured: { type: Boolean, default: false },
    is_visible: { type: Boolean, default: true, index: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

serviceSchema.index({ name: 'text', description: 'text', category: 'text' });
serviceSchema.index({ category: 1, is_visible: 1, active: 1, displayOrder: 1, priceNum: 1 });

module.exports = mongoose.model('Service', serviceSchema);
