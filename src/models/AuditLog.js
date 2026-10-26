const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema(
  {
    actor: { type: String, index: true },
    role: String,
    action: { type: String, required: true, index: true },
    booking: { type: String, index: true },
    targetType: String,
    targetId: String,
    meta: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

auditSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditSchema);
