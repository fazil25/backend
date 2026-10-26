const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    booking: { type: String, required: true, index: true },
    customer: { type: String },
    worker: { type: String },
    service: { type: String },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, maxlength: 1000 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Review', reviewSchema);
