const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema(
  {
    hash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    customId: { type: String, unique: true, sparse: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    employeeId: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['customer', 'worker', 'admin'], required: true, index: true },
    status: {
      type: String,
      enum: ['active', 'disabled', 'suspended', 'pending_verification'],
      default: 'active',
      index: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    avatarUrl: String,
    address: String,
    addresses: [
      {
        id: String,
        label: { type: String, default: 'Home' },
        address: { type: String, required: true },
        formattedAddress: String,
        house: String,
        houseNumber: String,
        floor: String,
        line1: String,
        street: String,
        area: String,
        locality: String,
        city: String,
        district: String,
        state: String,
        pincode: String,
        postalCode: String,
        country: { type: String, default: 'India' },
        landmark: String,
        mobileNumber: String,
        latitude: Number,
        longitude: Number,
        accuracy: Number,
        source: { type: String, default: 'GPS' },
        confirmedAt: { type: Date, default: Date.now },
        isDefault: { type: Boolean, default: false },
      },
    ],
    // Worker specific profile metadata
    kycStatus: { type: String, enum: ['unsubmitted', 'pending', 'approved', 'rejected'], default: 'pending' },
    services: [{ type: String }],
    serviceArea: { type: String, default: 'Bengaluru' },
    serviceRadiusKm: { type: Number, default: 15 },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    online: { type: Boolean, default: false, index: true },
    todayEarnings: { type: Number, default: 0 },
    walletBalance: { type: Number, default: 0 },
    otp: {
      codeHash: String,
      expiresAt: Date,
      purpose: String,
    },
    fcmTokens: [
      {
        token: { type: String, required: true },
        deviceId: { type: String },
        platform: { type: String, enum: ['android', 'ios', 'web'], default: 'android' },
        lastSeenAt: { type: Date, default: Date.now },
      },
    ],
    refreshTokens: { type: [refreshTokenSchema], default: [], select: false },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

userSchema.index({ role: 1, online: 1 });
userSchema.index({ role: 1, status: 1, online: 1, services: 1 });

module.exports = mongoose.model('User', userSchema);
