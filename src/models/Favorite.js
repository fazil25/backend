const mongoose = require('mongoose');

const favSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  },
  { timestamps: true },
);

favSchema.index({ user: 1, service: 1 }, { unique: true });

module.exports = mongoose.model('Favorite', favSchema);
