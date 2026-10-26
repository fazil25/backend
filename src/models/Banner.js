const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema(
  {
    customId: { type: String, unique: true },
    title: { type: String, required: true },
    badge_text: { type: String, default: 'VERIFIED EXPERTS' },
    description: { type: String, default: '' },
    price_text: { type: String, default: '' },
    cta_text: { type: String, default: 'Book Now' },
    targetServiceId: { type: String, default: 'srv_ac' },
    couponCode: { type: String, default: null },

    // Background customization
    background_type: {
      type: String,
      enum: ['color', 'image', 'gradient'],
      default: 'color',
    },
    background_color: { type: String, default: '#1E1B4B' },
    background_image: { type: String, default: '' },
    background_overlay_color: { type: String, default: 'rgba(15, 23, 42, 0.65)' },
    background_overlay_opacity: { type: Number, default: 0.65 },

    // Typography & Element Colors
    title_color: { type: String, default: '#FFFFFF' },
    description_color: { type: String, default: '#CBD5E1' },
    badge_background_color: { type: String, default: '#06B6D4' },
    badge_text_color: { type: String, default: '#FFFFFF' },
    price_background_color: { type: String, default: 'rgba(34, 197, 94, 0.2)' },
    price_text_color: { type: String, default: '#4ADE80' },
    cta_color: { type: String, default: '#06B6D4' },

    // Image Configuration
    promotional_image: { type: String, default: '' },
    image_position: {
      type: String,
      enum: ['right', 'left', 'none'],
      default: 'right',
    },

    // Ordering and Visibility
    display_order: { type: Number, default: 0 },
    is_active: { type: Boolean, default: true },

    // Legacy Aliases for backward compatibility
    tag: { type: String },
    subtitle: { type: String },
    discountBadge: { type: String },
    primaryColor: { type: String },
    bgImageUrl: { type: String },
    imageUrl: { type: String },
    containerBg: { type: String },
    buttonText: { type: String },
    active: { type: Boolean },
  },
  { timestamps: true }
);

// Pre-save hook to keep legacy and new fields synchronized
bannerSchema.pre('save', function (next) {
  if (this.badge_text && !this.tag) this.tag = this.badge_text;
  if (this.tag && !this.badge_text) this.badge_text = this.tag;

  if (this.description && !this.subtitle) this.subtitle = this.description;
  if (this.subtitle && !this.description) this.description = this.subtitle;

  if (this.price_text && !this.discountBadge) this.discountBadge = this.price_text;
  if (this.discountBadge && !this.price_text) this.price_text = this.discountBadge;

  if (this.cta_text && !this.buttonText) this.buttonText = this.cta_text;
  if (this.buttonText && !this.cta_text) this.cta_text = this.buttonText;

  if (this.background_color && !this.containerBg) this.containerBg = this.background_color;
  if (this.containerBg && !this.background_color) this.background_color = this.containerBg;

  if (this.background_image && !this.bgImageUrl) this.bgImageUrl = this.background_image;
  if (this.bgImageUrl && !this.background_image) this.background_image = this.bgImageUrl;

  if (this.promotional_image && !this.imageUrl) this.imageUrl = this.promotional_image;
  if (this.imageUrl && !this.promotional_image) this.promotional_image = this.imageUrl;

  if (this.badge_background_color && !this.primaryColor) this.primaryColor = this.badge_background_color;
  if (this.primaryColor && !this.badge_background_color) this.badge_background_color = this.primaryColor;

  if (this.is_active !== undefined && this.active === undefined) this.active = this.is_active;
  if (this.active !== undefined && this.is_active === undefined) this.is_active = this.active;

  if (typeof next === 'function') next();
});

bannerSchema.index({ is_active: 1, display_order: 1, createdAt: -1 });
bannerSchema.index({ active: 1, display_order: 1, createdAt: -1 });

module.exports = mongoose.model('Banner', bannerSchema);
