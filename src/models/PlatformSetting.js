const mongoose = require('mongoose');

const platformSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global_config' },
    platformName: { type: String, default: 'HomeStepIn Technologies' },
    platformCommissionPercent: { type: Number, default: 20 },
    convenienceFee: { type: Number, default: 49 },
    freeDeliveryThreshold: { type: Number, default: 2000 },
    taxRatePercent: { type: Number, default: 5 },
    defaultServiceRadiusKm: { type: Number, default: 15 },
    supportPhone: { type: String, default: '+91 80 6900 4746' },
    supportEmail: { type: String, default: 'support@homestep.in' },
    autoDispatchEnabled: { type: Boolean, default: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PlatformSetting', platformSettingSchema);
