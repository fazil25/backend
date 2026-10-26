const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema(
  {
    customId: { type: String, unique: true, sparse: true, index: true },
    bookingId: { type: String, index: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    customerId: { type: String, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    customerName: String,
    workerId: { type: String, index: true },
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    subject: { type: String, required: true },
    description: String,
    body: String,
    status: {
      type: String,
      enum: ['New', 'Open', 'Pending', 'Assigned', 'Investigating', 'In Review', 'Under Review', 'Resolved', 'Closed', 'Rejected'],
      default: 'Open',
      index: true,
    },
    assignedTo: String,
    resolvedAt: Date,
    resolvedBy: String,
    history: [{ status: String, at: { type: Date, default: Date.now }, by: String, note: String }],
  },
  { timestamps: true }
);

complaintSchema.index({ customerId: 1, createdAt: -1 });

module.exports = mongoose.model('Complaint', complaintSchema);
