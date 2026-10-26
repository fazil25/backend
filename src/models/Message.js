const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    messageId: { type: String, unique: true, sparse: true, index: true },
    clientMsgId: { type: String, index: true, sparse: true },
    bookingId: { type: String, required: true, index: true },
    senderId: { type: String, required: true, index: true },
    senderName: { type: String, default: 'User' },
    senderRole: { type: String, enum: ['customer', 'worker', 'admin', 'system'], default: 'customer' },
    text: { type: String, required: true, maxlength: 2000 },
    kind: { type: String, enum: ['text', 'photo', 'system'], default: 'text' },
    photoUrl: String,
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'delivered' },
    timestamp: { type: Date, default: Date.now },
    readBy: [{ type: String }],
  },
  { timestamps: true }
);

messageSchema.index(
  { bookingId: 1, clientMsgId: 1 },
  { unique: true, partialFilterExpression: { clientMsgId: { $type: 'string', $gt: '' } } }
);

module.exports = mongoose.model('Message', messageSchema);
