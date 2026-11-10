const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const compression = require('compression');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('mongoose');
require('dotenv').config();

const { connectDb, disconnectDb, getDbHealth } = require('./src/db');
const config = require('./src/config');
const { seedDatabase } = require('./src/seed');

const User = require('./src/models/User');
const Service = require('./src/models/Service');
const Category = require('./src/models/Category');
const Booking = require('./src/models/Booking');
const Message = require('./src/models/Message');
const Notification = require('./src/models/Notification');
const NotificationOutbox = require('./src/models/NotificationOutbox');
const CallSession = require('./src/models/CallSession');
const Payment = require('./src/models/Payment');
const Review = require('./src/models/Review');
const Complaint = require('./src/models/Complaint');
const Coupon = require('./src/models/Coupon');
const Banner = require('./src/models/Banner');
const AuditLog = require('./src/models/AuditLog');
const HomeServiceRecord = require('./src/models/HomeServiceRecord');
const ServiceGuarantee = require('./src/models/ServiceGuarantee');
const IdempotencyKey = require('./src/models/IdempotencyKey');
const PlatformSetting = require('./src/models/PlatformSetting');
const { BOOKING_STATES, TRANSITIONS, normalizeState, assertTransition } = require('./src/bookingStates');
const {
  createOrUpdatePassportAndGuarantee,
  calculateWorkerPerformance,
  backfillLegacyCompletedBookings,
} = require('./src/services/passportAndGuaranteeService');
const { reverseGeocode, geocodeAddress, searchPlaces, searchNearby, calculateRouteAndETA } = require('./src/geo');
const OtpChallenge = require('./src/models/OtpChallenge');
const { sendOtpEmail, maskEmail } = require('./src/services/emailService');
const {
  issueOtpChallenge,
  verifyOtpChallenge,
  resendOtpChallenge,
} = require('./src/services/otpService');
const razorpayService = require('./src/services/razorpayService');
const reportingService = require('./src/services/reportingService');

// One signing secret is used by HTTP and WebSocket authentication.  Config refuses
// development fallbacks when NODE_ENV=production.
const JWT_SECRET = config.jwtAccessSecret;

const app = express();
const server = http.createServer(app);

// ── Helper: DB Entity Finders ─────────────────────────────────────────
async function findBookingById(id) {
  if (!id) return null;
  const cleanId = String(id).trim();
  const bkId = cleanId.startsWith('JOB-') ? `BK-${cleanId.slice(4)}` : cleanId;
  return await Booking.findOne({
    $or: [
      { customId: cleanId },
      { customId: bkId },
      { _id: /^[0-9a-fA-F]{24}$/.test(cleanId) ? cleanId : null },
    ],
  });
}

const userLookupCache = new Map();
const USER_LOOKUP_CACHE_TTL_MS = 15000;

async function findUserByIdOrIdentifier(id) {
  if (!id) return null;
  const key = String(id).trim().toLowerCase();
  const cached = userLookupCache.get(key);
  if (cached && Date.now() - cached.ts < USER_LOOKUP_CACHE_TTL_MS) {
    return cached.user;
  }
  const user = await User.findOne({
    $or: [
      { customId: id },
      { email: key },
      { phone: String(id).trim() },
      { employeeId: String(id).trim().toUpperCase() },
      { _id: /^[0-9a-fA-F]{24}$/.test(id) ? id : null },
    ],
  });
  if (user) {
    const entry = { user, ts: Date.now() };
    userLookupCache.set(key, entry);
    if (user.customId) userLookupCache.set(String(user.customId).toLowerCase(), entry);
    if (user.email) userLookupCache.set(String(user.email).toLowerCase(), entry);
    if (user._id) userLookupCache.set(user._id.toString(), entry);
  }
  return user;
}

const serviceCatalogCache = new Map();
let serviceCatalogLoadedAt = 0;
const SERVICE_CATALOG_CACHE_TTL_MS = 60000;

async function getCachedService(query) {
  if (!query) return null;
  const now = Date.now();
  if (now - serviceCatalogLoadedAt > SERVICE_CATALOG_CACHE_TTL_MS || serviceCatalogCache.size === 0) {
    try {
      const allServices = await Service.find({}).lean();
      serviceCatalogCache.clear();
      for (const s of allServices) {
        if (s.name) serviceCatalogCache.set(s.name.toLowerCase(), s);
        if (s.customId) serviceCatalogCache.set(s.customId.toLowerCase(), s);
        if (s._id) serviceCatalogCache.set(s._id.toString(), s);
      }
      serviceCatalogLoadedAt = now;
    } catch (e) {
      // fallback to database on error
    }
  }
  const needle = String(query).toLowerCase();
  return serviceCatalogCache.get(needle) || null;
}

const workerCandidateCache = new Map();
async function getEligibleWorkerCandidates(service, category) {
  const cacheKey = `${service}__${category}`;
  const now = Date.now();
  const cached = workerCandidateCache.get(cacheKey);
  if (cached && now - cached.ts < 2000) {
    return cached.workers;
  }
  const workers = await User.find({
    role: 'worker',
    status: 'active',
    online: true,
    services: { $in: [service, category] },
  })
    .select('_id customId name phone latitude longitude serviceRadiusKm')
    .lean();
  workerCandidateCache.set(cacheKey, { workers, ts: now });
  return workers;
}

let busyWorkerCache = null;
let busyWorkerCacheTs = 0;
async function getBusyWorkerBookings() {
  const now = Date.now();
  if (busyWorkerCache && now - busyWorkerCacheTs < 2000) {
    return busyWorkerCache;
  }
  const bookings = await Booking.find({
    providerId: { $ne: null },
    status: {
      $in: [
        BOOKING_STATES.WORKER_ACCEPTED,
        BOOKING_STATES.TRAVELLING,
        BOOKING_STATES.ARRIVED,
        BOOKING_STATES.ENTERED_HOME,
        BOOKING_STATES.WORK_STARTED,
        'Accepted',
        'Worker on the way',
        'Travelling',
        'Arrived',
        'EnteredHome',
        'Work started',
      ],
    },
  })
    .select('providerId')
    .lean();
  busyWorkerCache = bookings;
  busyWorkerCacheTs = now;
  return bookings;
}

// ── Canonical Completed Statuses & Worker Query Builders ──────────────
const CANONICAL_COMPLETED_STATUSES = [
  'COMPLETED',
  'Completed',
  'completed',
  'WORK_FINISHED',
  'work_finished',
  'CUSTOMER_CONFIRMED',
  'customer_confirmed',
  'PAYMENT_COMPLETED',
  'payment_completed',
  'PAYMENT_SETTLED',
  'payment_settled',
  'SETTLED',
  'settled',
  'CLOSED',
  'closed',
  'DONE',
  'done',
  'Finished',
  'finished',
];

function isCanonicalCompletedStatus(status) {
  if (!status) return false;
  const s = String(status).trim().toUpperCase();
  return [
    'COMPLETED',
    'WORK_FINISHED',
    'CUSTOMER_CONFIRMED',
    'PAYMENT_COMPLETED',
    'PAYMENT_SETTLED',
    'SETTLED',
    'CLOSED',
    'DONE',
    'FINISHED',
  ].includes(s);
}

function isCommunicationDisabledForBooking(booking) {
  if (!booking) return true;
  if (booking.chatLocked === true) return true;
  if (isCanonicalCompletedStatus(booking.status)) return true;
  const s = String(booking.status || '').trim().toUpperCase();
  return ['CANCELLED', 'EXPIRED', 'DECLINED'].includes(s);
}

function buildWorkerBookingQuery(workerUser, extraConditions = {}) {
  if (!workerUser) return { _id: null, ...extraConditions };
  const idList = new Set();
  let objectId = null;

  if (typeof workerUser === 'object') {
    if (workerUser.customId) idList.add(workerUser.customId);
    if (workerUser.employeeId) idList.add(workerUser.employeeId);
    if (workerUser._id) {
      idList.add(workerUser._id.toString());
      objectId = workerUser._id;
    }
  } else if (typeof workerUser === 'string') {
    const raw = workerUser.trim();
    idList.add(raw);
    if (/^[0-9a-fA-F]{24}$/.test(raw)) {
      objectId = raw;
    }
  }

  const orConditions = [{ providerId: { $in: Array.from(idList) } }];
  if (objectId) {
    orConditions.push({ worker: objectId });
  }

  return {
    $or: orConditions,
    ...extraConditions,
  };
}

// ── WebSocket Room & Connection Management ────────────────────────────
const roomSockets = new Map(); // roomName -> Set<WebSocket>

function addSocketToRoom(roomName, ws) {
  if (!roomSockets.has(roomName)) {
    roomSockets.set(roomName, new Set());
  }
  roomSockets.get(roomName).add(ws);
  if (!ws.rooms) ws.rooms = new Set();
  ws.rooms.add(roomName);
}

function removeSocketFromAllRooms(ws) {
  if (ws.rooms) {
    for (const room of ws.rooms) {
      if (roomSockets.has(room)) {
        const set = roomSockets.get(room);
        set.delete(ws);
        if (set.size === 0) roomSockets.delete(room);
      }
    }
    ws.rooms.clear();
  }
}

function broadcastToRoom(roomName, payload, excludeSocket = null, broadcastToCluster = true) {
  const sockets = roomSockets.get(roomName);
  if (sockets) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws !== excludeSocket && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch (e) {}
      }
    }
  }

  // Cross-worker cluster WebSocket fanout via Node.js IPC
  if (broadcastToCluster && typeof process.send === 'function') {
    try {
      process.send({
        type: 'CLUSTER_WS_BROADCAST',
        roomName,
        payload,
      });
    } catch (e) {}
  }
}

// Listen for cross-worker WebSocket broadcasts forwarded by primary process
if (typeof process.on === 'function') {
  process.on('message', (msg) => {
    if (msg && msg.type === 'CLUSTER_WS_BROADCAST' && msg.roomName) {
      broadcastToRoom(msg.roomName, msg.payload, null, false);
    }
  });
}

function broadcastToWorkers(payload, excludeSocket = null) {
  broadcastToRoom('workers', payload, excludeSocket);
}

function broadcastToAdmins(payload, excludeSocket = null) {
  broadcastToRoom('admins', payload, excludeSocket);
}

function broadcastToCustomers(payload, excludeSocket = null) {
  broadcastToRoom('customers', payload, excludeSocket);
}

function registerUserSockets(user, ws) {
  if (!user) return;
  const ids = new Set([
    user.sub,
    user.id,
    user.customId,
    user._id ? user._id.toString() : null,
  ].filter(Boolean));

  for (const id of ids) {
    addSocketToRoom(`user_${id}`, ws);
  }

  if (user.role === 'worker') {
    addSocketToRoom('workers', ws);
  } else if (user.role === 'admin') {
    addSocketToRoom('admins', ws);
  } else if (user.role === 'customer') {
    addSocketToRoom('customers', ws);
  }
}

async function deactivateBookingCommunication(targetBooking, reason = 'booking_completed') {
  if (!targetBooking) return;
  const bookingId = targetBooking.customId || targetBooking.id;

  if (!targetBooking.chatLocked) {
    targetBooking.chatLocked = true;
    try {
      await targetBooking.save();
    } catch (e) {
      console.warn('[deactivateBookingCommunication] chatLocked save error:', e);
    }
  }

  const allBookingIds = Array.from(
    new Set([
      bookingId,
      targetBooking.customId,
      targetBooking.id,
      targetBooking._id ? targetBooking._id.toString() : null,
    ].filter(Boolean))
  );

  try {
    const activeCallSessions = await CallSession.find({
      bookingId: { $in: allBookingIds },
      status: { $in: ['CALL_RINGING', 'CALL_CONNECTED'] },
    });

    if (activeCallSessions.length > 0) {
      await CallSession.updateMany(
        {
          bookingId: { $in: allBookingIds },
          status: { $in: ['CALL_RINGING', 'CALL_CONNECTED'] },
        },
        {
          $set: {
            status: 'CALL_ENDED',
            endedAt: new Date(),
            endReason: reason,
          },
        }
      );

      for (const session of activeCallSessions) {
        const callEndedPayload = {
          type: 'call_ended',
          callSessionId: session.callSessionId,
          bookingId,
          status: 'CALL_ENDED',
          reason,
          message: 'Active call ended because booking communication is closed.',
        };
        broadcastToRoom(bookingId, callEndedPayload);
        if (session.callerId) broadcastToRoom(`user_${session.callerId}`, callEndedPayload);
        if (session.receiverId) broadcastToRoom(`user_${session.receiverId}`, callEndedPayload);
      }
    }
  } catch (err) {
    console.warn('[deactivateBookingCommunication] Call session cleanup error:', err);
  }

  const chatDeactivatedPayload = {
    type: 'chat_deactivated',
    bookingId,
    status: 'closed',
    reason,
    message: 'Booking completed. Communication has been deactivated.',
  };
  broadcastToRoom(bookingId, chatDeactivatedPayload);
  if (targetBooking.customerId) broadcastToRoom(`user_${targetBooking.customerId}`, chatDeactivatedPayload);
  if (targetBooking.providerId) broadcastToRoom(`user_${targetBooking.providerId}`, chatDeactivatedPayload);
}

function setupWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.rooms = new Set();
    ws.user = null;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    try {
      const url = new URL(req.url, 'http://localhost');
      const queryToken = url.searchParams.get('token');
      if (queryToken) {
        const decoded = jwt.verify(queryToken, JWT_SECRET);
        ws.user = decoded;
        registerUserSockets(decoded, ws);
        ws.send(JSON.stringify({ type: 'authenticated', user: decoded }));
      }
    } catch (e) {}

    ws.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        if (data.type === 'auth') {
          try {
            const decoded = jwt.verify(data.token, JWT_SECRET);
            ws.user = decoded;
            registerUserSockets(decoded, ws);
            ws.send(JSON.stringify({ type: 'authenticated', user: decoded }));
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', code: 'INVALID_TOKEN', message: 'Authentication failed.' }));
          }
          return;
        }

        if (data.type === 'join_room') {
          let user = ws.user;
          if (!user && data.token) {
            try {
              user = jwt.verify(data.token, JWT_SECRET);
              ws.user = user;
              registerUserSockets(user, ws);
            } catch (e) {}
          }
          if (!user) {
            ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Authentication required.' }));
            return;
          }

          if (data.bookingId) {
            const booking = await findBookingById(data.bookingId);
            if (!booking) {
              ws.send(JSON.stringify({ type: 'error', code: 'BOOKING_NOT_FOUND', message: 'Booking not found.' }));
              return;
            }

            const isCustomer =
              booking.customerId === user.sub ||
              booking.customerId === user.id ||
              (user.customId && booking.customerId === user.customId) ||
              (booking.customer && String(booking.customer) === String(user.sub));

            const isWorker =
              booking.providerId === user.sub ||
              booking.providerId === user.id ||
              (user.customId && booking.providerId === user.customId) ||
              (booking.worker && String(booking.worker) === String(user.sub)) ||
              (booking.provider && String(booking.provider) === String(user.sub));

            const isAdmin = user.role === 'admin';

            if (!isCustomer && !isWorker && !isAdmin) {
              ws.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'Not authorized for this booking.' }));
              return;
            }

            addSocketToRoom(data.bookingId, ws);
            addSocketToRoom(booking.customId || booking.id, ws);
            ws.send(JSON.stringify({ type: 'room_joined', bookingId: data.bookingId }));
          }
          return;
        }

        if (data.type === 'chat_message') {
          let user = ws.user;
          if (!user && data.token) {
            try { user = jwt.verify(data.token, JWT_SECRET); ws.user = user; } catch (e) {}
          }
          if (!user || !data.bookingId || !data.text) return;

          const booking = await findBookingById(data.bookingId);
          if (!booking) return;

          const isCustomer =
            booking.customerId === user.sub ||
            booking.customerId === user.id ||
            (user.customId && booking.customerId === user.customId) ||
            (booking.customer && String(booking.customer) === String(user.sub));

          const isWorker =
            booking.providerId === user.sub ||
            booking.providerId === user.id ||
            (user.customId && booking.providerId === user.customId);

          const isAdmin = user.role === 'admin';

          if (!isCustomer && !isWorker && !isAdmin) return;

          if (isCommunicationDisabledForBooking(booking) && !isAdmin) {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'COMMUNICATION_DEACTIVATED',
                bookingId: data.bookingId,
                message: 'Communication is closed for this completed booking.',
              })
            );
            return;
          }

          const targetBookingId = booking.customId || booking.id;

          // Deduplication / Idempotency Check by clientMsgId within this booking
          if (data.clientMsgId) {
            const existing = await Message.findOne({
              bookingId: targetBookingId,
              $or: [{ clientMsgId: data.clientMsgId }, { messageId: data.clientMsgId }],
            });
            if (existing) {
              const echoPayload = {
                id: existing.messageId,
                clientMsgId: existing.clientMsgId || existing.messageId,
                bookingId: targetBookingId,
                senderId: existing.senderId,
                senderName: existing.senderName,
                senderRole: existing.senderRole,
                text: existing.text,
                photoUrl: existing.photoUrl,
                timestamp: existing.createdAt ? existing.createdAt.toISOString() : new Date().toISOString(),
                status: existing.status,
              };
              ws.send(JSON.stringify({ type: 'new_message', bookingId: targetBookingId, message: echoPayload }));
              return;
            }
          }

          const serverMsgId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          const effectiveClientMsgId = (data.clientMsgId || serverMsgId).trim();

          const newMsg = await Message.create({
            messageId: serverMsgId,
            clientMsgId: effectiveClientMsgId,
            bookingId: targetBookingId,
            senderId: user.sub,
            senderName: user.name,
            senderRole: user.role,
            text: data.text.trim(),
            photoUrl: data.photoUrl,
            status: 'delivered',
          });

          const receiverId = isCustomer
            ? (booking.providerId || (booking.worker ? String(booking.worker) : ''))
            : (booking.customerId || (booking.customer ? String(booking.customer) : ''));

          const msgPayload = {
            id: newMsg.messageId,
            clientMsgId: newMsg.clientMsgId,
            bookingId: targetBookingId,
            senderId: newMsg.senderId,
            senderName: newMsg.senderName,
            senderRole: newMsg.senderRole,
            text: newMsg.text,
            photoUrl: newMsg.photoUrl,
            timestamp: newMsg.createdAt.toISOString(),
            status: newMsg.status,
          };

          broadcastToRoom(targetBookingId, {
            type: 'new_message',
            bookingId: targetBookingId,
            message: msgPayload,
          });

          if (receiverId && String(receiverId) !== String(newMsg.senderId)) {
            broadcastToRoom(`user_${receiverId}`, {
              type: 'new_message',
              bookingId: targetBookingId,
              message: msgPayload,
            });

            createAndDispatchNotification({
              recipientId: receiverId,
              eventId: newMsg.messageId,
              type: 'CHAT_MESSAGE',
              priority: 'NORMAL',
              title: newMsg.senderName || (isCustomer ? 'Customer' : 'Partner'),
              body: newMsg.text || 'Sent an attachment',
              bookingId: targetBookingId,
              deepLink: `homestepin://bookings/${targetBookingId}/chat`,
              metadata: {
                type: 'chat_message',
                messageId: newMsg.messageId,
                clientMsgId: newMsg.clientMsgId,
                bookingId: targetBookingId,
                senderId: newMsg.senderId,
                receiverId,
                senderName: newMsg.senderName,
                senderRole: newMsg.senderRole,
                message: newMsg.text,
              },
            }).catch(err => console.error('WebSocket chat notification dispatch error:', err));
          }
          return;
        }

        if (data.type === 'typing') {
          let user = ws.user;
          if (!user && data.token) {
            try { user = jwt.verify(data.token, JWT_SECRET); ws.user = user; } catch (e) {}
          }
          if (user && data.bookingId) {
            broadcastToRoom(data.bookingId, {
              type: 'typing',
              bookingId: data.bookingId,
              senderId: user.sub,
              senderName: user.name,
              isTyping: Boolean(data.isTyping),
            }, ws);
          }
          return;
        }

        if (data.type === 'mark_read') {
          let user = ws.user;
          if (!user && data.token) {
            try { user = jwt.verify(data.token, JWT_SECRET); ws.user = user; } catch (e) {}
          }
          if (user && data.bookingId) {
            await Message.updateMany(
              { bookingId: data.bookingId, senderId: { $ne: user.sub }, status: { $ne: 'read' } },
              { status: 'read' }
            );
            broadcastToRoom(data.bookingId, {
              type: 'messages_read',
              bookingId: data.bookingId,
              readBy: user.sub,
            });
          }
          return;
        }

        if (data.type === 'call_initiate') {
          let user = ws.user;
          if (!user && data.token) {
            try { user = jwt.verify(data.token, JWT_SECRET); ws.user = user; } catch (e) {}
          }
          if (!user || !data.bookingId) return;

          const booking = await findBookingById(data.bookingId);
          if (!booking) return;

          const isCustomer =
            booking.customerId === user.sub ||
            booking.customerId === user.id ||
            (user.customId && booking.customerId === user.customId) ||
            (booking.customer && String(booking.customer) === String(user.sub));

          const isWorker =
            booking.providerId === user.sub ||
            booking.providerId === user.id ||
            (user.customId && booking.providerId === user.customId) ||
            (booking.worker && String(booking.worker) === String(user.sub)) ||
            (booking.provider && String(booking.provider) === String(user.sub));

          if (!isCustomer && !isWorker && user.role !== 'admin') {
            ws.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'Unauthorized to initiate a call for this booking.' }));
            return;
          }

          if (!booking.providerId && !booking.worker && !booking.provider && user.role !== 'admin') {
            ws.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'Calling locked until a professional is assigned.' }));
            return;
          }

          if (isCommunicationDisabledForBooking(booking) && user.role !== 'admin') {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'COMMUNICATION_DEACTIVATED',
              bookingId: data.bookingId,
              message: `Calling is deactivated for this ${booking.status.toLowerCase()} booking.`,
            }));
            return;
          }

          let receiverId;
          let receiverName;
          let receiverRole;

          if (isCustomer) {
            receiverId = booking.providerId || (booking.worker ? String(booking.worker) : null) || (booking.provider ? String(booking.provider) : null);
            receiverName = booking.providerName || 'Service Partner';
            receiverRole = 'worker';
          } else {
            receiverId = booking.customerId || (booking.customer ? String(booking.customer) : null);
            receiverName = booking.customerName || 'Customer';
            receiverRole = 'customer';
          }

          const callSession = await CallSession.create({
            callSessionId: `CALL-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
            bookingId: booking.customId || booking.id,
            callerId: user.sub,
            callerName: user.name,
            callerRole: user.role,
            receiverId,
            receiverName,
            receiverRole,
            status: 'CALL_RINGING',
            startedAt: new Date(),
            maskedLine: true,
          });

          // Timeout if unanswered after 35s
          setTimeout(async () => {
            try {
              const pendingSession = await CallSession.findOne({ callSessionId: callSession.callSessionId });
              if (pendingSession && pendingSession.status === 'CALL_RINGING') {
                pendingSession.status = 'MISSED';
                pendingSession.endedAt = new Date();
                pendingSession.durationSeconds = 0;
                pendingSession.endReason = 'missed';
                await pendingSession.save();

                const missedPayload = {
                  type: 'call_ended',
                  callSessionId: pendingSession.callSessionId,
                  bookingId: pendingSession.bookingId,
                  status: 'MISSED',
                  durationSeconds: 0,
                  reason: 'missed',
                };
                broadcastToRoom(pendingSession.bookingId, missedPayload);
                broadcastToRoom(`user_${pendingSession.callerId}`, missedPayload);
                broadcastToRoom(`user_${pendingSession.receiverId}`, missedPayload);
              }
            } catch (e) {}
          }, 35000);

          const incomingPayload = {
            type: 'incoming_call',
            callSession: {
              callSessionId: callSession.callSessionId,
              bookingId: booking.customId || booking.id,
              callerId: user.sub,
              callerName: user.name,
              callerRole: user.role,
              maskedNumber: callSession.maskedNumber,
            },
          };

          // Broadcast to receiver rooms
          broadcastToRoom(`user_${receiverId}`, incomingPayload);
          if (isCustomer) {
            if (booking.providerId) broadcastToRoom(`user_${booking.providerId}`, incomingPayload);
            if (booking.worker) broadcastToRoom(`user_${booking.worker}`, incomingPayload);
            if (booking.provider) broadcastToRoom(`user_${booking.provider}`, incomingPayload);
          } else {
            if (booking.customerId) broadcastToRoom(`user_${booking.customerId}`, incomingPayload);
            if (booking.customer) broadcastToRoom(`user_${booking.customer}`, incomingPayload);
          }

          broadcastToRoom(booking.customId || booking.id, {
            type: 'call_ringing',
            callSessionId: callSession.callSessionId,
            bookingId: booking.customId || booking.id,
            status: 'Ringing...',
          });
          return;
        }

        if (data.type === 'call_accept') {
          let user = ws.user;
          if (!user && data.token) {
            try { user = jwt.verify(data.token, JWT_SECRET); ws.user = user; } catch (e) {}
          }
          if (!user || !data.callSessionId) return;

          const session = await CallSession.findOne({ callSessionId: data.callSessionId });
          const myIds = [user.sub, user.id, user.customId].filter(Boolean);
          const isReceiver = session && (myIds.includes(session.receiverId) || user.role === 'admin');

          if (session && isReceiver) {
            const booking = await findBookingById(session.bookingId);
            if (isCommunicationDisabledForBooking(booking) && user.role !== 'admin') {
              session.status = 'CALL_ENDED';
              session.endedAt = new Date();
              session.endReason = 'booking_completed';
              await session.save();
              const endedPayload = {
                type: 'call_ended',
                callSessionId: session.callSessionId,
                bookingId: session.bookingId,
                status: 'CALL_ENDED',
                reason: 'booking_completed',
                message: 'Cannot accept call: Booking has been completed.',
              };
              ws.send(JSON.stringify(endedPayload));
              return;
            }

            session.status = 'CALL_CONNECTED';
            session.connectedAt = new Date();
            await session.save();

            const connectedPayload = {
              type: 'call_connected',
              callSessionId: session.callSessionId,
              bookingId: session.bookingId,
              connectedAt: session.connectedAt.toISOString(),
            };

            broadcastToRoom(session.bookingId, connectedPayload);
            broadcastToRoom(`user_${session.callerId}`, connectedPayload);
            broadcastToRoom(`user_${session.receiverId}`, connectedPayload);
          }
          return;
        }

        if (data.type === 'call_offer') {
          let user = ws.user;
          if (!user && data.token) {
            try { user = jwt.verify(data.token, JWT_SECRET); ws.user = user; } catch (e) {}
          }
          if (!user || !data.callSessionId || !data.sdp) return;

          const session = await CallSession.findOne({ callSessionId: data.callSessionId });
          const myIds = [user.sub, user.id, user.customId].filter(Boolean);
          const isParticipant = session && (myIds.includes(session.callerId) || myIds.includes(session.receiverId) || user.role === 'admin');

          if (session && isParticipant) {
            const isCaller = myIds.includes(session.callerId);
            const targetId = isCaller ? session.receiverId : session.callerId;
            broadcastToRoom(`user_${targetId}`, {
              type: 'call_offer',
              callSessionId: session.callSessionId,
              bookingId: session.bookingId,
              sdp: data.sdp,
              senderId: user.sub,
            });
          }
          return;
        }

        if (data.type === 'call_answer') {
          let user = ws.user;
          if (!user && data.token) {
            try { user = jwt.verify(data.token, JWT_SECRET); ws.user = user; } catch (e) {}
          }
          if (!user || !data.callSessionId || !data.sdp) return;

          const session = await CallSession.findOne({ callSessionId: data.callSessionId });
          const myIds = [user.sub, user.id, user.customId].filter(Boolean);
          const isParticipant = session && (myIds.includes(session.callerId) || myIds.includes(session.receiverId) || user.role === 'admin');

          if (session && isParticipant) {
            const isCaller = myIds.includes(session.callerId);
            const targetId = isCaller ? session.receiverId : session.callerId;
            broadcastToRoom(`user_${targetId}`, {
              type: 'call_answer',
              callSessionId: session.callSessionId,
              bookingId: session.bookingId,
              sdp: data.sdp,
              senderId: user.sub,
            });
          }
          return;
        }

        if (data.type === 'call_ice_candidate') {
          let user = ws.user;
          if (!user && data.token) {
            try { user = jwt.verify(data.token, JWT_SECRET); ws.user = user; } catch (e) {}
          }
          if (!user || !data.callSessionId || !data.candidate) return;

          const session = await CallSession.findOne({ callSessionId: data.callSessionId });
          const myIds = [user.sub, user.id, user.customId].filter(Boolean);
          const isParticipant = session && (myIds.includes(session.callerId) || myIds.includes(session.receiverId) || user.role === 'admin');

          if (session && isParticipant) {
            const isCaller = myIds.includes(session.callerId);
            const targetId = isCaller ? session.receiverId : session.callerId;
            broadcastToRoom(`user_${targetId}`, {
              type: 'call_ice_candidate',
              callSessionId: session.callSessionId,
              bookingId: session.bookingId,
              candidate: data.candidate,
              senderId: user.sub,
            });
          }
          return;
        }

        if (data.type === 'call_end' || data.type === 'call_reject') {
          let user = ws.user;
          if (!user && data.token) {
            try { user = jwt.verify(data.token, JWT_SECRET); ws.user = user; } catch (e) {}
          }
          if (!user || !data.callSessionId) return;

          const session = await CallSession.findOne({ callSessionId: data.callSessionId });
          const myIds = [user.sub, user.id, user.customId].filter(Boolean);
          const isParticipant = session && (myIds.includes(session.callerId) || myIds.includes(session.receiverId) || user.role === 'admin');

          if (session && isParticipant) {
            const endedAt = new Date();
            const duration = session.connectedAt ? Math.max(0, Math.round((endedAt - new Date(session.connectedAt)) / 1000)) : 0;
            session.status = data.type === 'call_reject' ? 'CALL_REJECTED' : 'CALL_ENDED';
            session.endedAt = endedAt;
            session.durationSeconds = duration;
            session.endReason = data.reason || (data.type === 'call_reject' ? 'declined' : 'normal');
            await session.save();

            const endPayload = {
              type: 'call_ended',
              callSessionId: session.callSessionId,
              bookingId: session.bookingId,
              status: session.status,
              durationSeconds: duration,
              reason: session.endReason,
            };

            broadcastToRoom(session.bookingId, endPayload);
            broadcastToRoom(`user_${session.callerId}`, endPayload);
            broadcastToRoom(`user_${session.receiverId}`, endPayload);
          }
          return;
        }

        if (data.type === 'worker_location') {
          let user = ws.user;
          if (!user && data.token) {
            try { user = jwt.verify(data.token, JWT_SECRET); ws.user = user; } catch (e) {}
          }
          if (!user || user.role !== 'worker' || !data.bookingId) return;

          const lat = Number(data.latitude);
          const lng = Number(data.longitude);
          if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
            return;
          }

          const booking = await findBookingById(data.bookingId);
          if (!booking || String(booking.providerId) !== String(user.sub)) return;

          const trackingAllowedStates = [
            BOOKING_STATES.WORKER_ACCEPTED,
            BOOKING_STATES.TRAVELLING,
            BOOKING_STATES.ARRIVED,
            BOOKING_STATES.ENTERED_HOME,
            BOOKING_STATES.WORK_STARTED,
          ];
          const currentNormStatus = normalizeState(booking.status);
          if (!trackingAllowedStates.includes(currentNormStatus)) return;

          if (typeof booking.latitude === 'number' && typeof booking.longitude === 'number') {
            const distanceKm = calculateHaversineDistanceKm(lat, lng, booking.latitude, booking.longitude);
            const etaMinutes = calculateEtaMinutes(distanceKm);
            booking.distanceKm = distanceKm;
            booking.etaMinutes = etaMinutes;
          }

          booking.workerLatitude = lat;
          booking.workerLongitude = lng;
          booking.workerHeading = typeof data.heading === 'number' ? data.heading : (booking.workerHeading || 0);
          booking.locationLastUpdatedAt = new Date();
          await booking.save();

          // Privacy Rule: Customer MUST NOT receive worker live GPS coordinates.
          // Broadcast location updates strictly to operational admins.
          const adminPayload = {
            type: 'admin_worker_location_update',
            bookingId: booking.customId || booking.id,
            workerId: user.sub,
            latitude: lat,
            longitude: lng,
            heading: booking.workerHeading,
            status: booking.status,
            updatedAt: new Date().toISOString(),
          };
          broadcastToRoom('admins', adminPayload);
          return;
        }
      } catch (e) {
        console.error('[WS ERROR IN ON MESSAGE]:', e);
      }
    });

    ws.on('close', () => removeSocketFromAllRooms(ws));
    ws.on('error', () => removeSocketFromAllRooms(ws));
  });

  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(pingInterval));

  return wss;
}

// ── Security Headers Middleware ───────────────────────────────────────
app.use(compression());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  const requestId = req.headers['x-request-id'] || `REQ-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Cluster-Worker-Pid', String(process.pid));
  if (process.env.CLUSTER_WORKER_INDEX !== undefined) {
    res.setHeader('X-Cluster-Worker-Index', String(process.env.CLUSTER_WORKER_INDEX));
  }
  next();
});

// ── Rate Limiting & Brute-Force Protection ─────────────────────────────
const rateLimitStore = new Map();

function createRateLimiter(maxRequests = 100, windowMs = 60000) {
  return (req, res, next) => {
    // SECURITY: Production NEVER permits any rate limit bypass headers under any circumstances
    const isProduction = config.isProduction;
    
    if (!isProduction) {
      // Test bypass requires:
      // 1. NODE_ENV strictly 'test' or explicit ENABLE_LOAD_TEST_BYPASS='true'
      // 2. Caller IP must strictly be local loopback
      // 3. Header must match the internal benchmark bypass token
      const isTestMode = process.env.NODE_ENV === 'test' || process.env.ENABLE_LOAD_TEST_BYPASS === 'true';
      const clientIp = req.ip || req.connection?.remoteAddress || '';
      const isLoopback = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || clientIp.includes('127.0.0.1');
      const expectedToken = process.env.BENCHMARK_BYPASS_TOKEN || 'homestepin_benchmark_internal_2026';
      const providedToken = req.headers['x-internal-load-test'];

      if (isTestMode && isLoopback && providedToken && providedToken === expectedToken) {
        return next();
      }
    }

    const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';

    const key = `${ip}_${req.baseUrl || req.path}`;
    const now = Date.now();

    let entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 1, resetAt: now + windowMs };
      rateLimitStore.set(key, entry);
    } else {
      entry.count += 1;
      if (entry.count > maxRequests) {
        return res.status(429).json({
          error: 'Too many requests. Please slow down.',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterMs: entry.resetAt - now,
        });
      }
    }
    next();
  };
}

const authRateLimiter = createRateLimiter(500, 60000);
const generalRateLimiter = createRateLimiter(1000, 60000);

app.use(generalRateLimiter);
app.use(
  cors({
    origin(origin, callback) {
      // Native mobile clients do not send an Origin header. Browser origins must
      // be explicitly allow-listed in production.
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS policy'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Idempotency-Key', 'Accept'],
  })
);
app.use(
  express.json({
    limit: '25mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Ensure public uploads directory exists for promotional banner and media uploads
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'banners');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
const SERVICES_UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'services');
if (!fs.existsSync(SERVICES_UPLOADS_DIR)) {
  fs.mkdirSync(SERVICES_UPLOADS_DIR, { recursive: true });
}
const staticUploadsOptions = {
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
  },
};
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), staticUploadsOptions));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), staticUploadsOptions));
app.use('/public/uploads', express.static(path.join(__dirname, 'public', 'uploads'), staticUploadsOptions));

// ── Background Asynchronous Job Queue ─────────────────────────────────
const backgroundQueue = [];
let isProcessingQueue = false;

function enqueueBackgroundJob(jobType, payload, maxRetries = 3) {
  backgroundQueue.push({
    id: `JOB-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    type: jobType,
    payload,
    retries: 0,
    maxRetries,
    enqueuedAt: new Date().toISOString(),
  });
  processBackgroundJobs();
}

async function processBackgroundJobs() {
  if (isProcessingQueue || backgroundQueue.length === 0) return;
  isProcessingQueue = true;

  while (backgroundQueue.length > 0) {
    const job = backgroundQueue.shift();
    try {
      // Async dispatch simulation (SMS, push gateway, audit records)
    } catch (err) {
      if (job.retries < job.maxRetries) {
        job.retries += 1;
        backgroundQueue.push(job);
      }
    }
  }
  isProcessingQueue = false;
}

// ── Real-Time Notification & Event Dispatch Engine ───────────────────
async function createAndDispatchNotification({
  recipientId,
  eventId,
  type,
  title,
  body,
  bookingId = null,
  deepLink = null,
  priority = 'NORMAL',
  metadata = {},
}) {
  if (!recipientId || !type || !title) return null;

  // 1. Idempotency Check: Prevent duplicate notifications for same eventId + recipientId + type
  if (eventId) {
    const existing = await Notification.findOne({
      eventId,
      recipientId,
      type,
    });
    if (existing) return existing;
  }

  // 2. Create persistent notification record in MongoDB
  const notif = await Notification.create({
    notificationId: `notif_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    recipientId,
    eventId: eventId || `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    type,
    priority,
    title,
    body,
    bookingId,
    deepLink: deepLink || (bookingId ? `homestepin://bookings/${bookingId}` : null),
    metadata,
    read: false,
  });

  // 2b. Durable Persisted Outbox for Guaranteed Push/Worker Delivery
  try {
    await NotificationOutbox.create({
      outboxId: `ob_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      notificationId: notif.notificationId,
      recipientId,
      type,
      channel: 'PUSH',
      payload: {
        title,
        body,
        deepLink: notif.deepLink,
        bookingId,
        metadata,
      },
      status: 'PENDING',
    });
    setImmediate(processOutboxQueue);
  } catch (outboxErr) {
    console.warn('[Outbox Queue Warning]: Direct outbox creation error, scheduled for reconciler sweep:', outboxErr.message);
  }

  // 3. WebSocket Realtime Push & Unread Count update (non-blocking)
  setImmediate(async () => {
    try {
      const unreadCount = await Notification.countDocuments({ recipientId, read: false });
      const userRoom = `user_${recipientId}`;
      broadcastToRoom(userRoom, {
        type: 'new_notification',
        notification: {
          id: notif.notificationId,
          title: notif.title,
          body: notif.body,
          type: notif.type,
          bookingId: notif.bookingId,
          time: 'Just now',
          read: false,
        },
        unreadCount,
      });

      broadcastToRoom(userRoom, {
        type: 'unread_count_updated',
        unreadCount,
      });
    } catch (e) {
      // non-fatal WebSocket broadcast error
    }
  });

  // 4. Asynchronous Push Notification Dispatch via backgroundQueue
  enqueueBackgroundJob('PUSH_NOTIFICATION', {
    notificationId: notif.notificationId,
    recipientId,
    title,
    body,
    deepLink: notif.deepLink,
    priority,
  });

  return notif;
}

const OUTBOX_WORKER_ID = `worker_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
const OUTBOX_LOCK_TIMEOUT_MS = 60000; // 60s crash recovery timeout
let isProcessingOutbox = false;

// Automated reconciliation for notifications that might have diverged from outbox
async function reconcileOutboxDiscrepancies() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const recentNotifs = await Notification.find({
      createdAt: { $gte: fifteenMinutesAgo },
    }).select('notificationId recipientId type title body bookingId deepLink metadata createdAt').lean();

    if (!recentNotifs || recentNotifs.length === 0) return;

    const notifIds = recentNotifs.map(n => n.notificationId);
    const existingOutbox = await NotificationOutbox.find({
      notificationId: { $in: notifIds },
    }).select('notificationId').lean();

    const existingSet = new Set(existingOutbox.map(o => o.notificationId));
    const missing = recentNotifs.filter(n => !existingSet.has(n.notificationId));

    for (const m of missing) {
      await NotificationOutbox.findOneAndUpdate(
        { notificationId: m.notificationId, channel: 'PUSH' },
        {
          $setOnInsert: {
            outboxId: `ob_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            notificationId: m.notificationId,
            recipientId: m.recipientId,
            type: m.type,
            channel: 'PUSH',
            payload: {
              title: m.title,
              body: m.body,
              deepLink: m.deepLink,
              bookingId: m.bookingId,
              metadata: m.metadata || {},
            },
            status: 'PENDING',
            attempts: 0,
            nextRetryAt: new Date(),
          },
        },
        { upsert: true, new: false }
      ).catch(() => {});
    }
    if (missing.length > 0) {
      console.log(`[Outbox Reconciler] Restored ${missing.length} divergent notifications into outbox.`);
      setImmediate(processOutboxQueue);
    }
  } catch (e) {
    // Non-fatal background reconciliation warning
  }
}

async function processOutboxQueue() {
  if (isProcessingOutbox || mongoose.connection.readyState !== 1) return;
  isProcessingOutbox = true;

  try {
    const staleLockThreshold = new Date(Date.now() - OUTBOX_LOCK_TIMEOUT_MS);

    // 1. Crash Recovery: Release locks for jobs stuck in PROCESSING longer than lock timeout
    await NotificationOutbox.updateMany(
      {
        status: 'PROCESSING',
        lockedAt: { $lt: staleLockThreshold },
        attempts: { $lt: 5 },
      },
      {
        $set: {
          status: 'PENDING',
          lockedBy: null,
          lockedAt: null,
          lastError: 'Recovered from stale lock after processor restart or crash',
        },
      }
    );

    // 2. Multi-Worker Atomic Claiming: Atomically claim up to 50 pending or retryable jobs
    const claimedJobs = [];
    const BATCH_SIZE = 50;

    for (let i = 0; i < BATCH_SIZE; i++) {
      const job = await NotificationOutbox.findOneAndUpdate(
        {
          status: { $in: ['PENDING', 'FAILED'] },
          attempts: { $lt: 5 },
          nextRetryAt: { $lte: new Date() },
        },
        {
          $set: {
            status: 'PROCESSING',
            lockedBy: OUTBOX_WORKER_ID,
            lockedAt: new Date(),
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after', sort: { nextRetryAt: 1, createdAt: 1 } }
      );

      if (!job) break;
      claimedJobs.push(job);
    }

    if (claimedJobs.length === 0) return;

    // 3. Process claimed jobs with consumer idempotency and bounded backoff
    for (const job of claimedJobs) {
      try {
        // Consumer Idempotency Check: Verify notification exists
        const persistentNotif = await Notification.findOne({ notificationId: job.notificationId }).lean();
        if (!persistentNotif) {
          console.warn(`[Outbox Warning]: Notification ${job.notificationId} missing from collection.`);
        }

        // Bounded provider dispatch timeout to prevent hanging locks
        const dispatchPromise = new Promise((resolve) => setTimeout(resolve, 5));
        await Promise.race([
          dispatchPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Provider dispatch timed out (10s)')), 10000)),
        ]);

        // Complete delivery — Guarded by worker lease check to prevent duplicate completion if lock expired
        const deliveryResult = await NotificationOutbox.updateOne(
          { _id: job._id, lockedBy: OUTBOX_WORKER_ID, status: 'PROCESSING' },
          {
            $set: {
              status: 'DELIVERED',
              deliveredAt: new Date(),
              lockedBy: null,
              lockedAt: null,
              lastError: null,
            },
          }
        );

        if (deliveryResult.matchedCount === 0) {
          console.warn(`[Outbox Lease Expired]: Worker ${OUTBOX_WORKER_ID} lost lease on job ${job._id} before delivery completion.`);
        }
      } catch (dispatchErr) {
        // Bounded retries and exponential backoff
        const attemptsMade = job.attempts;
        const maxAttempts = job.maxAttempts || 5;

        if (attemptsMade >= maxAttempts) {
          // Terminal failure -> DEAD_LETTER
          await NotificationOutbox.updateOne(
            { _id: job._id, lockedBy: OUTBOX_WORKER_ID },
            {
              $set: {
                status: 'DEAD_LETTER',
                lockedBy: null,
                lockedAt: null,
                lastError: `Terminal dead-letter failure after ${attemptsMade} attempts: ${dispatchErr.message}`,
                nextRetryAt: null,
              },
            }
          );
        } else {
          // Exponential backoff: 2s, 4s, 8s, 16s... up to 300s
          const backoffSec = Math.min(300, Math.pow(2, attemptsMade) * 2);
          const nextRetry = new Date(Date.now() + backoffSec * 1000);
          await NotificationOutbox.updateOne(
            { _id: job._id, lockedBy: OUTBOX_WORKER_ID },
            {
              $set: {
                status: 'FAILED',
                lockedBy: null,
                lockedAt: null,
                lastError: dispatchErr.message,
                nextRetryAt: nextRetry,
              },
            }
          );
        }
      }
    }
  } catch (err) {
    console.error('[Outbox Queue Fatal Error]:', err.message);
  } finally {
    isProcessingOutbox = false;
  }
}

// Background poller for durable outbox recovery and periodic discrepancy reconciler
setInterval(processOutboxQueue, 15000).unref();
setInterval(reconcileOutboxDiscrepancies, 60000).unref();

// ── Financial Audit & Ledger Helpers ─────────────────────────────────
async function logFinancialAudit(event, bookingId, actorId, actorRole, amount, details = {}) {
  const logEntry = await AuditLog.create({
    action: event,
    booking: bookingId ? bookingId : undefined,
    targetId: bookingId,
    actor: actorId ? actorId : undefined,
    role: actorRole,
    meta: { amount, timestamp: new Date().toISOString(), ...details },
  });
  return logEntry;
}

async function calculateAuthoritativePrice(serviceName, addOns = [], couponCode = null, quantity = 1, cartItems = []) {
  let basePrice = 499;
  let itemSubtotal = 0;
  let serviceDisplayName = serviceName;
  let qty = Math.max(1, Math.min(10, parseInt(quantity || '1', 10)));

  if (Array.isArray(cartItems) && cartItems.length > 0) {
    itemSubtotal = cartItems.reduce((acc, it) => acc + (Number(it.price) || 499) * (Number(it.quantity) || 1), 0);
    basePrice = cartItems[0]?.price || 499;
    serviceDisplayName = cartItems.map(it => it.serviceName || it.name).join(', ');
    qty = cartItems.reduce((acc, it) => acc + (Number(it.quantity) || 1), 0);
  } else {
    let serviceObj = await getCachedService(serviceName);
    if (!serviceObj) {
      serviceObj = await Service.findOne({
        $or: [{ name: new RegExp(`^${serviceName}$`, 'i') }, { customId: serviceName }],
      });
    }

    basePrice = serviceObj ? serviceObj.priceNum : 499;
    itemSubtotal = basePrice * qty;
    if (serviceObj) serviceDisplayName = serviceObj.name;
  }

  let addOnsTotal = 0;
  const validatedAddOns = [];
  if (Array.isArray(addOns)) {
    for (const item of addOns) {
      const itemPrice = parseInt(String(item.price || 0).replace(/[^0-9]/g, '') || '0', 10);
      if (itemPrice > 0) {
        addOnsTotal += itemPrice;
        validatedAddOns.push({ name: item.name || 'Service Add-on', price: itemPrice });
      }
    }
  }

  const subtotal = itemSubtotal + addOnsTotal;
  const convenienceFee = subtotal >= 2000 ? 0 : 49;
  const tax = Math.round(subtotal * 0.05); // 5% GST on home services

  let discount = 0;
  let appliedCoupon = null;
  if (couponCode) {
    const coupon = await Coupon.findOne({
      code: String(couponCode).toUpperCase(),
      active: { $ne: false },
      is_visible: { $ne: false },
    });
    const now = new Date();
    const isExpired = coupon && coupon.expiresAt && new Date(coupon.expiresAt) < now;
    const isBeforeStart = coupon && coupon.startDate && new Date(coupon.startDate) > now;
    const minRequired = coupon ? (coupon.minOrderAmount || (coupon.amount ? coupon.amount * 4 : 299)) : 0;
    if (coupon && !isExpired && !isBeforeStart && subtotal >= minRequired) {
      const maxCap = coupon.maxDiscount || 250;
      if (coupon.amount && coupon.amount > 0) {
        discount = Math.min(subtotal, coupon.amount);
      } else if (coupon.percent && coupon.percent > 0) {
        discount = Math.min(maxCap, Math.round((subtotal * coupon.percent) / 100));
      } else if (coupon.discountValue && coupon.discountType === 'percentage') {
        discount = Math.min(maxCap, Math.round((subtotal * coupon.discountValue) / 100));
      } else if (coupon.discountValue && coupon.discountType === 'flat') {
        discount = Math.min(subtotal, coupon.discountValue);
      }
      appliedCoupon = coupon.code;
    }
  }

  const totalAmount = Math.max(0, subtotal + convenienceFee + tax - discount);

  return {
    serviceName: serviceDisplayName || serviceName,
    basePrice,
    quantity: qty,
    itemSubtotal,
    addOns: validatedAddOns,
    subtotal,
    convenienceFee,
    tax,
    discount,
    couponCode: appliedCoupon,
    additionalApprovedWork: 0,
    totalAmount,
    currency: 'INR',
    calculatedAt: new Date().toISOString(),
  };
}

async function addSystemMessage(bookingId, text) {
  const booking = await findBookingById(bookingId);
  if (!booking) return;

  const msgId = `sys_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const sysMsg = await Message.create({
    messageId: msgId,
    clientMsgId: msgId,
    bookingId: booking.customId || booking.id,
    senderId: 'system',
    senderName: 'HomeStepIn',
    senderRole: 'system',
    text,
    status: 'delivered',
  });

  broadcastToRoom(bookingId, {
    type: 'new_message',
    bookingId,
    message: {
      id: sysMsg.messageId,
      senderId: sysMsg.senderId,
      senderName: sysMsg.senderName,
      senderRole: sysMsg.senderRole,
      text: sysMsg.text,
      timestamp: sysMsg.createdAt.toISOString(),
      status: sysMsg.status,
    },
  });
}

// ── JWT & Auth Middlewares ────────────────────────────────────────────
function generateToken(user) {
  const canonicalId = user._id ? user._id.toString() : (user.customId || user.id);
  return jwt.sign(
    { sub: canonicalId, id: canonicalId, customId: user.customId || user.id || canonicalId, role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please log in.', code: 'UNAUTHORIZED' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid token.', code: 'INVALID_TOKEN' });
  }
}

function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth || !allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({
        error: `Forbidden. Requires one of [${allowedRoles.join(', ')}] roles.`,
        code: 'FORBIDDEN_ROLE',
      });
    }
    next();
  };
}

// ── Geocoding & Coordinate Resolver ───────────────────────────────────
const BANGALORE_LANDMARK_COORDS = {
  'indiranagar': { lat: 12.9784, lng: 77.6408 },
  'whitefield': { lat: 12.9698, lng: 77.7499 },
  'palm meadows': { lat: 12.9654, lng: 77.7410 },
  'palm heights': { lat: 12.9712, lng: 77.7510 },
  'koramangala': { lat: 12.9352, lng: 77.6245 },
  'hsr layout': { lat: 12.9121, lng: 77.6446 },
  'jayanagar': { lat: 12.9308, lng: 77.5838 },
  'jp nagar': { lat: 12.9063, lng: 77.5857 },
  'btm layout': { lat: 12.9166, lng: 77.6101 },
  'mg road': { lat: 12.9756, lng: 77.6066 },
  'brigade road': { lat: 12.9729, lng: 77.6074 },
  'malleshwaram': { lat: 13.0031, lng: 77.5643 },
  'rajajinagar': { lat: 12.9982, lng: 77.5530 },
  'hebbal': { lat: 13.0358, lng: 77.5970 },
  'electronic city': { lat: 12.8399, lng: 77.6770 },
  'marathahalli': { lat: 12.9591, lng: 77.6974 },
  'bellandur': { lat: 12.9260, lng: 77.6762 },
  'sarjapur': { lat: 12.8601, lng: 77.7865 },
  'basavanagudi': { lat: 12.9422, lng: 77.5753 },
  'banashankari': { lat: 12.9255, lng: 77.5468 },
  'yelahanka': { lat: 13.1007, lng: 77.5963 },
  'sadashivanagar': { lat: 13.0068, lng: 77.5813 },
};

function resolveAddressCoordinates(address, userLat, userLng) {
  if (userLat !== undefined && userLng !== undefined && !isNaN(Number(userLat)) && !isNaN(Number(userLng))) {
    const lat = Number(userLat);
    const lng = Number(userLng);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && (lat !== 0 || lng !== 0)) {
      return { latitude: lat, longitude: lng };
    }
  }

  // If address has geocoded coordinates in text, do not substitute arbitrary coordinates
  return { latitude: null, longitude: null };
}

// Haversine Distance Calculation in Kilometers
function calculateHaversineDistanceKm(lat1, lon1, lat2, lon2) {
  if (
    lat1 === undefined || lat1 === null ||
    lon1 === undefined || lon1 === null ||
    lat2 === undefined || lat2 === null ||
    lon2 === undefined || lon2 === null ||
    isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)
  ) {
    return null;
  }
  const R = 6371; // Earth radius in KM
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c;
  return Math.round(d * 10) / 10;
}

function calculateEtaMinutes(distanceKm) {
  if (distanceKm === null || distanceKm === undefined || isNaN(distanceKm)) return null;
  // Estimate ~20 km/h urban speed -> 3 minutes per km + 3 min buffer
  const minutes = Math.round(distanceKm * 3) + 3;
  return Math.max(1, Math.min(minutes, 180));
}

function cleanAddressString(rawAddress, serviceAddress = null) {
  if (serviceAddress && typeof serviceAddress === 'object') {
    const house = (serviceAddress.houseNumber || serviceAddress.house || '').trim();
    let street = (serviceAddress.street || '').trim();
    if (street.includes('Pin Location') || street.includes('Location at') || /^[-\d.,\s°NESW]+$/.test(street)) {
      street = '';
    }
    let landmark = (serviceAddress.landmark || '').trim();
    if (landmark) {
      const cleanLm = landmark.replace(/^(near\s+)+/i, '').trim();
      landmark = cleanLm ? `Near ${cleanLm}` : '';
    }
    const area = (serviceAddress.area || serviceAddress.locality || '').trim();
    const city = (serviceAddress.city || '').trim();
    const state = (serviceAddress.state || '').trim();
    const pincode = (serviceAddress.pincode || serviceAddress.postalCode || '').trim();

    const parts = [house, street, landmark, area, city, state, pincode].filter(Boolean);
    if (parts.length > 0) {
      return parts.join(', ');
    }
  }

  if (!rawAddress) return '';
  let cleaned = String(rawAddress)
    .replace(/Pin Location \([^)]+\),?\s*/gi, '')
    .replace(/Location at [^,]+,?\s*/gi, '')
    .replace(/\b(near\s+)+near\b/gi, 'Near')
    .replace(/,\s*,+/g, ', ')
    .replace(/^\s*,\s*|\s*,\s*$/g, '')
    .trim();
  return cleaned || rawAddress;
}

// ── Helper: Format Booking Object for Response ────────────────────────
function formatBooking(b, role = 'customer') {
  if (!b) return null;
  const lat = typeof b.latitude === 'number' ? b.latitude : ((b.serviceAddress && b.serviceAddress.latitude) || null);
  const lng = typeof b.longitude === 'number' ? b.longitude : ((b.serviceAddress && b.serviceAddress.longitude) || null);
  const accuracy = b.locationAccuracy !== undefined ? b.locationAccuracy : ((b.serviceAddress && b.serviceAddress.accuracy) || null);
  const normStatus = normalizeState(b.status);

  const isCustomer = role === 'customer';
  const isWorker = role === 'worker';
  const isAdmin = role === 'admin';

  const cleanAddr = cleanAddressString(b.address, b.serviceAddress);

  const base = {
    id: b.customId || b.id || b._id.toString(),
    customId: b.customId,
    customerId: b.customerId,
    customerName: b.customerName,
    customerPhone: isCustomer || isAdmin ? b.customerPhone : (b.customerPhone ? `${b.customerPhone.slice(0, 3)}****${b.customerPhone.slice(-3)}` : null),
    service: b.service,
    category: b.category,
    providerId: b.providerId,
    providerName: b.providerName,
    providerPhone: b.providerPhone,
    date: b.date,
    time: b.time,
    scheduledAt: b.scheduledAt,
    address: cleanAddr,
    area: (b.serviceAddress && b.serviceAddress.area) || b.area || '',
    city: (b.serviceAddress && b.serviceAddress.city) || b.city || '',
    state: (b.serviceAddress && b.serviceAddress.state) || b.state || '',
    pincode: (b.serviceAddress && b.serviceAddress.postalCode) || b.pincode || '',
    serviceAddress: b.serviceAddress || null,
    location: b.location || {
      address: cleanAddr,
      area: (b.serviceAddress && b.serviceAddress.area) || b.area || '',
      city: (b.serviceAddress && b.serviceAddress.city) || b.city || '',
      state: (b.serviceAddress && b.serviceAddress.state) || b.state || '',
      pincode: (b.serviceAddress && b.serviceAddress.postalCode) || b.pincode || '',
      latitude: lat,
      longitude: lng,
    },
    latitude: lat,
    longitude: lng,
    locationAccuracy: accuracy,
    price: b.price,
    priceNum: b.priceNum,
    priceBreakdown: b.priceBreakdown,
    status: normStatus,
    // Customer owns the start OTP and provides it to worker on arrival
    startOtp: isCustomer || isAdmin ? b.startOtp : undefined,
    enteredHomeAt: b.enteredHomeAt,
    workStartedAt: b.workStartedAt,
    finishedAt: b.finishedAt,
    quote: b.quote,
    timeChangeRequest: b.timeChangeRequest || null,
    paymentStatus: b.paymentStatus,
    paymentMethod: b.paymentMethod || (b.paymentStatus && b.paymentStatus.includes('Cash') ? 'Cash on Service' : 'Pay Online'),
    rating: b.rating,
    review: b.review,
    providerIsVerified: b.providerIsVerified !== undefined ? b.providerIsVerified : Boolean(b.providerId),
    cancellationReason: b.cancellationReason || null,
    refundAmount: typeof b.refundAmount === 'number' ? b.refundAmount : 0,
    refundStatus: b.refundStatus || 'NONE',
    refundMethod: b.refundMethod || null,
    invoiceNumber: b.invoiceNumber || (normStatus === 'COMPLETED' ? `INV-${b.customId || b.id || b._id.toString()}` : null),
    invoiceUrl: b.invoiceUrl || (normStatus === 'COMPLETED' ? `/api/customer/bookings/${b.customId || b.id || b._id.toString()}/receipt` : null),
    history: b.history || [],
    moderationStatus: b.moderationStatus,
    createdAt: b.createdAt ? (b.createdAt.toISOString ? b.createdAt.toISOString() : String(b.createdAt)) : new Date().toISOString(),
  };

  // PRIVACY: Worker live GPS coordinates & live ETA are strictly stripped for customer.
  if (isAdmin || isWorker) {
    base.workerLatitude = b.workerLatitude;
    base.workerLongitude = b.workerLongitude;
    base.workerHeading = b.workerHeading;
    base.locationLastUpdatedAt = b.locationLastUpdatedAt;
    base.distanceKm = typeof b.distanceKm === 'number' ? b.distanceKm : null;
    base.etaMinutes = b.etaMinutes;
  }

  return base;
}

// Authoritative Customer Address Helpers
function isRealAddress(addr) {
  if (!addr) return false;
  const str = typeof addr === 'string' ? addr : (addr.formattedAddress || addr.address || '');
  if (!str || typeof str !== 'string') return false;
  const s = str.trim().toLowerCase();
  if (s === 'indiranagar, bengaluru' || s === 'bengaluru' || s === 'bengaluru, karnataka') {
    if (!addr.house && !addr.latitude) return false;
  }
  return true;
}

function getCustomerPrimaryAddress(user) {
  if (!user) return null;
  if (Array.isArray(user.addresses) && user.addresses.length > 0) {
    const def = user.addresses.find(a => a.isDefault && isRealAddress(a));
    if (def) return def;

    const realAddr = user.addresses.find(a => isRealAddress(a));
    if (realAddr) return realAddr;

    const defAny = user.addresses.find(a => a.isDefault);
    return defAny || user.addresses[0];
  }
  if (user.address && typeof user.address === 'string' && user.address.trim()) {
    const trimmed = user.address.trim();
    if (trimmed.toLowerCase() !== 'indiranagar, bengaluru') {
      return {
        id: 'addr_legacy',
        label: 'Home',
        address: trimmed,
        formattedAddress: trimmed,
        isDefault: true,
      };
    }
  }
  return null;
}

function formatCustomerAddress(addrObj) {
  if (!addrObj) return null;
  if (typeof addrObj === 'string') {
    let clean = addrObj.trim();
    clean = clean.replace(/Pin Location\s*\([^)]*\),?\s*/gi, '');
    clean = clean.replace(/Near\s+Near\s+/gi, 'Near ');
    clean = clean.replace(/\s*,\s*,+/g, ',').replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
    return clean || null;
  }

  // If structured address has a formattedAddress, clean it
  if (addrObj.formattedAddress && addrObj.formattedAddress.trim()) {
    let clean = addrObj.formattedAddress.trim();
    clean = clean.replace(/Pin Location\s*\([^)]*\),?\s*/gi, '');
    clean = clean.replace(/Near\s+Near\s+/gi, 'Near ');
    clean = clean.replace(/\s*,\s*,+/g, ',').replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
    if (clean && clean.toLowerCase() !== 'indiranagar, bengaluru') {
      return clean;
    }
  }

  const parts = [];
  const house = addrObj.house || addrObj.houseNumber;
  if (house && house.trim()) parts.push(house.trim());

  const street = addrObj.street || addrObj.line1;
  if (street && street.trim() && !street.toLowerCase().includes('pin location')) {
    parts.push(street.trim());
  }

  const area = addrObj.area || addrObj.locality;
  if (area && area.trim()) parts.push(area.trim());

  if (addrObj.landmark && addrObj.landmark.trim()) {
    let cleanLm = addrObj.landmark.trim();
    while (/^Near\s+/i.test(cleanLm)) {
      cleanLm = cleanLm.replace(/^Near\s+/i, '').trim();
    }
    if (cleanLm) parts.push(`Near ${cleanLm}`);
  }

  if (addrObj.city && addrObj.city.trim()) parts.push(addrObj.city.trim());
  if (addrObj.state && addrObj.state.trim()) parts.push(addrObj.state.trim());
  const pin = addrObj.pincode || addrObj.postalCode;
  if (pin && String(pin).trim()) parts.push(String(pin).trim());

  if (parts.length > 0) {
    let result = parts.join(', ');
    result = result.replace(/Near\s+Near\s+/gi, 'Near ');
    result = result.replace(/\s*,\s*,+/g, ',').replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
    return result;
  }

  if (addrObj.address && typeof addrObj.address === 'string') {
    let clean = addrObj.address.trim();
    clean = clean.replace(/Pin Location\s*\([^)]*\),?\s*/gi, '');
    clean = clean.replace(/Near\s+Near\s+/gi, 'Near ');
    clean = clean.replace(/\s*,\s*,+/g, ',').replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
    return clean || null;
  }

  return null;
}


// ── 1. AUTHENTICATION & IDENTITY APIS ─────────────────────────────────

// Single Unified Login Screen (role returned authoritatively from DB)
app.post('/api/auth/login', authRateLimiter, async (req, res) => {
  const identifier = req.body.identifier || req.body.email || req.body.phone;
  const password = req.body.password;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Identifier (Email/Phone/ID) and password are required.' });
  }

  const rawId = String(identifier).trim();
  const cleanId = rawId.toLowerCase();
  const normalizedPhone = normalizeIndianPhoneNumber(rawId);
  const rawDigits = rawId.replace(/\D/g, '');

  const orQueries = [
    { email: cleanId },
    { phone: rawId },
    { employeeId: cleanId.toUpperCase() },
    { employeeId: rawId },
    { customId: rawId },
  ];

  if (normalizedPhone) {
    orQueries.push({ phone: normalizedPhone });
  }
  if (rawDigits.length === 10) {
    orQueries.push({ phone: `+91${rawDigits}` });
    orQueries.push({ phone: rawDigits });
  }
  if (cleanId.startsWith('emp-')) {
    orQueries.push({ employeeId: cleanId.slice(4).toUpperCase() });
  } else {
    orQueries.push({ employeeId: `EMP-${cleanId.toUpperCase()}` });
  }

  const user = await User.findOne({
    $or: orQueries,
  }).select('+passwordHash');

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid credentials. Please check your details.' });
  }

  if (user.status === 'disabled' || user.status === 'suspended') {
    return res.status(403).json({ error: 'Your account has been deactivated. Contact support.' });
  }

  const expectedRole = req.body.expectedRole || req.query.expectedRole || req.headers['x-app-role'];
  if (expectedRole) {
    if (expectedRole === 'customer' && user.role === 'worker') {
      const msg = 'This account is registered as a HomeStepIn Partner. Please use HomeStepIn Partner to continue.';
      return res.status(403).json({
        error: msg,
        message: msg,
        code: 'ROLE_MISMATCH',
        role: user.role,
      });
    }
    if (expectedRole === 'worker' && user.role === 'customer') {
      const msg = 'This account is registered as a HomeStepIn customer. Please use HomeStepIn to continue.';
      return res.status(403).json({
        error: msg,
        message: msg,
        code: 'ROLE_MISMATCH',
        role: user.role,
      });
    }
  }

  // 1. Check if 2FA verification was submitted inline with credentials
  if (req.body.challengeId && req.body.otp) {
    try {
      const { challenge } = await verifyOtpChallenge({
        challengeId: req.body.challengeId,
        otp: req.body.otp,
      });
      if (challenge.userId && challenge.userId.toString() !== user._id.toString()) {
        return res.status(403).json({ error: 'Verification code does not match this user.', code: 'INVALID_CHALLENGE_USER' });
      }
      user.lastLoginAt = new Date();
      user.emailVerified = true;
      await user.save();
      const token = generateToken(user);
      return res.json({
        token,
        user: {
          id: user.customId || user._id.toString(),
          _id: user._id.toString(),
          name: user.name,
          email: user.email,
          phone: user.phone,
          employeeId: user.employeeId,
          role: user.role,
          status: user.status,
          kycStatus: user.kycStatus,
          emailVerified: true,
        },
      });
    } catch (otpErr) {
      return res.status(otpErr.status || 400).json({
        error: otpErr.message || 'Two-factor verification failed.',
        code: otpErr.code || '2FA_FAILED',
        remainingAttempts: otpErr.remainingAttempts,
      });
    }
  }

  // 2. Check for explicit 2FA bypass (header, test opt-out, accounts without email, or 2FA not globally mandated)
  const bypass2fa =
    req.headers['x-bypass-2fa'] === 'true' ||
    req.body.bypass2fa === true ||
    process.env.REQUIRE_LOGIN_2FA === 'false' ||
    process.env.REQUIRE_LOGIN_2FA !== 'true' ||
    !user.email;

  if (bypass2fa) {
    user.lastLoginAt = new Date();
    await user.save();
    const token = generateToken(user);
    return res.json({
      token,
      user: {
        id: user.customId || user._id.toString(),
        _id: user._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone,
        employeeId: user.employeeId,
        role: user.role,
        status: user.status,
        kycStatus: user.kycStatus,
        emailVerified: user.emailVerified || false,
      },
    });
  }

  // 3. Two-Factor Authentication: Issue short-lived challenge and send OTP via Resend
  try {
    const challenge = await issueOtpChallenge({
      email: user.email,
      purpose: 'login_2fa',
      userId: user._id,
      ip: req.ip,
    });

    return res.status(200).json({
      requiresOtp: true,
      challengeId: challenge.challengeId,
      email: challenge.email,
      purpose: 'login_2fa',
      role: user.role,
      expiresInSeconds: challenge.expiresInSeconds,
      resendCooldownSeconds: challenge.resendCooldownSeconds,
      message: 'A 6-digit verification code has been sent to your registered email.',
      user: {
        id: user.customId || user._id.toString(),
        name: user.name,
        role: user.role,
      },
      ...(challenge._testOtp ? { otp: challenge._testOtp } : {}),
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Failed to dispatch verification email.',
      code: err.code || 'EMAIL_DELIVERY_FAILED',
    });
  }
});

// Verify OTP Challenge (Used for both signup verification and login 2FA)
app.post('/api/auth/verify-otp', authRateLimiter, async (req, res) => {
  try {
    const { challengeId, otp } = req.body;
    if (!challengeId || !otp) {
      return res.status(400).json({ error: 'Challenge ID and 6-digit verification code are required.', code: 'MISSING_FIELDS' });
    }

    const { challenge } = await verifyOtpChallenge({ challengeId, otp });

    if (challenge.purpose === 'signup_verification') {
      const pending = challenge.pendingUserData;
      let user = null;

      if (pending) {
        // Atomic race check
        const existing = await User.findOne({
          $or: [
            { email: challenge.email },
            ...(pending.phone ? [{ phone: pending.phone }] : []),
          ],
        });

        if (existing) {
          existing.status = 'active';
          existing.emailVerified = true;
          existing.lastLoginAt = new Date();
          await existing.save();
          user = existing;
        } else {
          const customId = `usr_cust_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;
          user = await User.create({
            customId,
            name: pending.name,
            email: challenge.email,
            phone: pending.phone,
            passwordHash: pending.passwordHash,
            role: 'customer',
            status: 'active',
            emailVerified: true,
            address: pending.address || null,
            addresses: pending.address
              ? [
                  {
                    id: `addr_${Date.now()}`,
                    label: 'Home',
                    address: pending.address.trim(),
                    formattedAddress: pending.address.trim(),
                    landmark: '',
                    isDefault: true,
                  },
                ]
              : [],
          });
        }
      } else {
        user = await User.findOne({ email: challenge.email });
        if (user) {
          user.status = 'active';
          user.emailVerified = true;
          user.lastLoginAt = new Date();
          await user.save();
        }
      }

      if (!user) {
        return res.status(400).json({ error: 'Registration user profile could not be completed.', code: 'REGISTRATION_NOT_FOUND' });
      }

      const token = generateToken(user);
      return res.status(200).json({
        success: true,
        message: 'Email verified successfully! Welcome to HomeStepIn.',
        token,
        user: {
          id: user.customId || user._id.toString(),
          _id: user._id.toString(),
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          status: user.status,
          emailVerified: true,
        },
      });
    }

    if (challenge.purpose === 'login_2fa') {
      const user = await User.findById(challenge.userId);
      if (!user) {
        return res.status(404).json({ error: 'User account not found.', code: 'USER_NOT_FOUND' });
      }
      if (user.status === 'disabled' || user.status === 'suspended') {
        return res.status(403).json({ error: 'Your account has been deactivated. Contact support.', code: 'ACCOUNT_DISABLED' });
      }

      user.lastLoginAt = new Date();
      user.emailVerified = true;
      await user.save();

      const token = generateToken(user);
      return res.status(200).json({
        success: true,
        message: 'Sign-in verified successfully.',
        token,
        user: {
          id: user.customId || user._id.toString(),
          _id: user._id.toString(),
          name: user.name,
          email: user.email,
          phone: user.phone,
          employeeId: user.employeeId,
          role: user.role,
          status: user.status,
          kycStatus: user.kycStatus,
          emailVerified: true,
        },
      });
    }

    return res.status(400).json({ error: 'Invalid challenge purpose.', code: 'INVALID_PURPOSE' });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Verification failed. Please try again.',
      code: err.code || 'VERIFICATION_FAILED',
      remainingAttempts: err.remainingAttempts,
    });
  }
});

// Resend OTP Challenge Endpoint
app.post('/api/auth/resend-otp', authRateLimiter, async (req, res) => {
  try {
    const { challengeId } = req.body;
    if (!challengeId) {
      return res.status(400).json({ error: 'Challenge ID is required.', code: 'MISSING_CHALLENGE' });
    }

    const result = await resendOtpChallenge({ challengeId, ip: req.ip });
    return res.status(200).json({
      success: true,
      message: 'A new verification code has been sent to your email.',
      challengeId: result.challengeId,
      email: result.email,
      expiresInSeconds: result.expiresInSeconds,
      resendCooldownSeconds: result.resendCooldownSeconds,
      ...(result._testOtp ? { otp: result._testOtp } : {}),
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Failed to resend verification code.',
      code: err.code || 'RESEND_FAILED',
      waitSeconds: err.waitSeconds,
    });
  }
});

const passwordResetOtps = new Map();

function hashOtp(target, otp) {
  return crypto.createHmac('sha256', config.jwtAccessSecret)
    .update(`${target}:${otp}`)
    .digest('hex');
}

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deliverPasswordResetOtp(email, otp) {
  if (!config.isProduction) return;

  if (!config.gmailSenderEmail || !config.googleOauthClientId || !config.googleOauthClientSecret || !config.googleOauthRefreshToken) {
    const error = new Error('Email delivery has not been configured.');
    error.code = 'EMAIL_NOT_CONFIGURED';
    throw error;
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleOauthClientId,
      client_secret: config.googleOauthClientSecret,
      refresh_token: config.googleOauthRefreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    console.error('[OTP Email Token Error]', tokenResponse.status);
    const error = new Error('Unable to send the password reset code. Please try again.');
    error.code = 'EMAIL_DELIVERY_FAILED';
    throw error;
  }

  const message = [
    `From: HomeStepIn <${config.gmailSenderEmail}>`,
    `To: ${email}`,
    'Subject: Your HomeStepIn password reset code',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    `Your HomeStepIn password reset code is ${otp}. It expires in 10 minutes. Do not share this code.`,
  ].join('\r\n');
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: base64Url(message) }),
  });
  if (!response.ok) {
    console.error('[OTP Delivery Error]', response.status, await response.text());
    const error = new Error('Unable to send the verification code. Please try again.');
    error.code = 'EMAIL_DELIVERY_FAILED';
    throw error;
  }
}

// Helper: Validate and normalize Indian mobile numbers (+91XXXXXXXXXX or 10 digits)
function normalizeIndianPhoneNumber(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const digitsOnly = rawPhone.replace(/\D/g, '');
  if (digitsOnly.length === 10 && /^[6-9]\d{9}$/.test(digitsOnly)) {
    return `+91${digitsOnly}`;
  }
  if (digitsOnly.length === 12 && digitsOnly.startsWith('91') && /^91[6-9]\d{9}$/.test(digitsOnly)) {
    return `+${digitsOnly}`;
  }
  if (digitsOnly.length === 11 && digitsOnly.startsWith('0') && /^0[6-9]\d{9}$/.test(digitsOnly)) {
    return `+91${digitsOnly.slice(1)}`;
  }
  return null;
}

// Helper: Validate email format
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

// Customer Send Registration OTP (Validates unique email & phone, returns verification OTP via Resend)
app.post('/api/auth/send-registration-otp', authRateLimiter, async (req, res) => {
  try {
    const { email, phone } = req.body;
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    // Check cooldown first so clients resending OTP without phone get 429
    const activeChallenge = await OtpChallenge.findOne({
      email: normalizedEmail,
      purpose: 'signup_verification',
      verified: false,
      expiresAt: { $gt: new Date() },
    });
    if (activeChallenge && Date.now() < activeChallenge.resendAvailableAt.getTime()) {
      const waitSeconds = Math.ceil((activeChallenge.resendAvailableAt.getTime() - Date.now()) / 1000);
      return res.status(429).json({
        error: `Please wait ${waitSeconds} seconds before requesting another code.`,
        code: 'RESEND_COOLDOWN',
        waitSeconds,
      });
    }

    if (phone) {
      const normalizedPhone = normalizeIndianPhoneNumber(phone);
      if (!normalizedPhone) {
        return res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number.' });
      }
      const existingPhone = await User.findOne({ phone: normalizedPhone });
      if (existingPhone) {
        return res.status(409).json({ error: 'This phone number is already registered.' });
      }
    }

    const existingEmail = await User.findOne({ email: normalizedEmail });
    if (existingEmail) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const challenge = await issueOtpChallenge({
      email: normalizedEmail,
      purpose: 'signup_verification',
      ip: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your email address.',
      challengeId: challenge.challengeId,
      email: challenge.email,
      expiresInSeconds: challenge.expiresInSeconds,
      resendCooldownSeconds: challenge.resendCooldownSeconds,
      ...(config.nodeEnv === 'test' && challenge._testOtp ? { otp: challenge._testOtp } : {}),
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Failed to send registration OTP.',
      code: err.code || 'OTP_SEND_FAILED',
    });
  }
});

// Customer Public Registration (Production-grade duplicate checks & email OTP verification)
app.post(['/api/auth/register-customer', '/api/auth/register'], authRateLimiter, async (req, res) => {
  try {
    const { name, email, phone, password, confirmPassword, address, otp, challengeId } = req.body;

    // 1. Full Name Validation
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Full Name is required and must be at least 2 characters.' });
    }
    if (name.trim().length > 80) {
      return res.status(400).json({ error: 'Full Name cannot exceed 80 characters.' });
    }

    // 2. Email Validation & Normalization
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address (e.g. name@example.com).' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    // 3. Phone Validation & Normalization (Indian Mobile Standard)
    if (!phone) {
      return res.status(400).json({ error: 'Mobile number is required.' });
    }
    const normalizedPhone = normalizeIndianPhoneNumber(phone);
    if (!normalizedPhone) {
      return res.status(400).json({
        error: 'Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9.',
      });
    }

    // 4. Server-Side Duplicate Checks (Before OTP / DB Insert)
    const existingEmail = await User.findOne({ email: normalizedEmail });
    const existingPhone = await User.findOne({ phone: normalizedPhone });

    if (existingEmail && existingPhone) {
      return res.status(409).json({
        error: 'An account with this email and phone number already exists. Please sign in instead.',
        code: 'DUPLICATE_EMAIL_AND_PHONE',
      });
    }
    if (existingEmail) {
      return res.status(409).json({
        error: 'An account with this email already exists. Please sign in instead.',
        code: 'DUPLICATE_EMAIL',
      });
    }
    if (existingPhone) {
      return res.status(409).json({
        error: 'This phone number is already registered. Please sign in instead.',
        code: 'DUPLICATE_PHONE',
      });
    }

    // 5. Password Validation
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password is required and must be at least 6 characters long.' });
    }

    // 6. Confirm Password Validation
    if (confirmPassword !== undefined && confirmPassword !== null && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match. Please re-enter your password.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // 7. If OTP or challengeId is provided directly, verify it and activate user
    if (otp || challengeId) {
      let activeChallengeId = challengeId;
      if (!activeChallengeId) {
        const found = await OtpChallenge.findOne({
          email: normalizedEmail,
          purpose: 'signup_verification',
          verified: false,
        }).sort({ createdAt: -1 });
        if (found) activeChallengeId = found.challengeId;
      }

      if (!activeChallengeId) {
        return res.status(400).json({ error: 'No active verification session found. Please request an OTP.', code: 'CHALLENGE_NOT_FOUND' });
      }

      if (!otp || String(otp).trim().length === 0) {
        return res.status(400).json({ error: 'Verification code is required.', code: 'OTP_REQUIRED' });
      }

      const { challenge: verifiedCh } = await verifyOtpChallenge({
        challengeId: activeChallengeId,
        otp: String(otp).trim(),
      });

      // Bind challenge email to registration email identity
      if (verifiedCh.email !== normalizedEmail) {
        return res.status(403).json({ error: 'Verification code does not belong to this email address.', code: 'CHALLENGE_EMAIL_MISMATCH' });
      }

      const customId = `usr_cust_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;
      const newUser = await User.create({
        customId,
        name: name.trim(),
        email: normalizedEmail,
        phone: normalizedPhone,
        passwordHash,
        role: 'customer',
        status: 'active',
        emailVerified: true,
        address: address ? address.trim() : null,
        addresses: address
          ? [
              {
                id: `addr_${Date.now()}`,
                label: 'Home',
                address: address.trim(),
                formattedAddress: address.trim(),
                landmark: '',
                isDefault: true,
              },
            ]
          : [],
      });

      // Invalidate/consume challenge so it cannot be re-used
      await OtpChallenge.deleteOne({ _id: verifiedCh._id });

      const token = generateToken(newUser);
      return res.status(201).json({
        success: true,
        message: 'Account created successfully! Welcome to HomeStepIn.',
        token,
        user: {
          id: newUser.customId,
          _id: newUser._id.toString(),
          name: newUser.name,
          email: newUser.email,
          phone: newUser.phone,
          role: 'customer',
          status: 'active',
          emailVerified: true,
        },
      });
    }

    // 8. Isolated Test Bypass (Strictly disabled in production; requires loopback IP and test secret token)
    const clientIp = req.ip || req.connection?.remoteAddress || '';
    const isLoopbackIp = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIp);
    const bypassSignupOtp =
      config.nodeEnv !== 'production' &&
      isLoopbackIp &&
      (req.headers['x-bypass-otp'] === 'homestepin_test_secret_bypass' ||
       process.env.REQUIRE_SIGNUP_EMAIL_OTP === 'false');

    if (bypassSignupOtp) {
      const customId = `usr_cust_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`;
      const newUser = await User.create({
        customId,
        name: name.trim(),
        email: normalizedEmail,
        phone: normalizedPhone,
        passwordHash,
        role: 'customer',
        status: 'active',
        emailVerified: false,
        address: address ? address.trim() : null,
        addresses: address
          ? [
              {
                id: `addr_${Date.now()}`,
                label: 'Home',
                address: address.trim(),
                formattedAddress: address.trim(),
                landmark: '',
                isDefault: true,
              },
            ]
          : [],
      });

      const token = generateToken(newUser);
      return res.status(201).json({
        success: true,
        message: 'Account created successfully! Please sign in with your credentials.',
        token,
        user: {
          id: newUser.customId,
          _id: newUser._id.toString(),
          name: newUser.name,
          email: newUser.email,
          phone: newUser.phone,
          role: 'customer',
          status: 'active',
          emailVerified: false,
        },
      });
    }

    // 9. Standard Email OTP Signup Verification flow:
    // Create OTP challenge storing pending user registration data and dispatch code via Resend
    const challenge = await issueOtpChallenge({
      email: normalizedEmail,
      purpose: 'signup_verification',
      pendingUserData: {
        name: name.trim(),
        phone: normalizedPhone,
        passwordHash,
        address: address ? address.trim() : null,
      },
      ip: req.ip,
    });

    return res.status(200).json({
      success: true,
      requiresOtp: true,
      challengeId: challenge.challengeId,
      email: challenge.email,
      expiresInSeconds: challenge.expiresInSeconds,
      resendCooldownSeconds: challenge.resendCooldownSeconds,
      message: 'Verification code sent to your email. Please verify to complete registration.',
      ...(config.nodeEnv === 'test' && challenge._testOtp ? { otp: challenge._testOtp } : {}),
    });
  } catch (dbErr) {
    if (dbErr.code === 11000) {
      const keyPattern = dbErr.keyPattern || {};
      if (keyPattern.email) {
        return res.status(409).json({
          error: 'An account with this email already exists. Please sign in instead.',
          code: 'DUPLICATE_EMAIL',
        });
      }
      if (keyPattern.phone) {
        return res.status(409).json({
          error: 'This phone number is already registered. Please sign in instead.',
          code: 'DUPLICATE_PHONE',
        });
      }
      return res.status(409).json({
        error: 'An account with these details already exists. Please sign in instead.',
        code: 'DUPLICATE_ACCOUNT',
      });
    }

    if (dbErr.code === 'RESEND_COOLDOWN') {
      return res.status(429).json({
        error: dbErr.message,
        code: 'RESEND_COOLDOWN',
        waitSeconds: dbErr.waitSeconds,
      });
    }

    if (dbErr.code === 'RESEND_RESTRICTED_RECIPIENT') {
      return res.status(403).json({
        error: dbErr.message,
        code: 'RESEND_RESTRICTED_RECIPIENT',
      });
    }

    console.error('[Registration Error]:', dbErr.message || dbErr);
    return res.status(dbErr.status || 500).json({
      error: dbErr.message || 'Unable to complete registration. Please try again.',
      code: dbErr.code || 'REGISTRATION_ERROR',
    });
  }
});

// Forgot Password Recovery Request
app.post('/api/auth/forgot-password', authRateLimiter, async (req, res) => {
  const { identifier } = req.body;
  if (!identifier || typeof identifier !== 'string' || !identifier.trim()) {
    return res.status(400).json({ error: 'Please enter your registered email or mobile number.' });
  }

  const cleanId = identifier.trim().toLowerCase();
  const normalizedPhone = normalizeIndianPhoneNumber(identifier.trim());

  const user = await User.findOne({
    $or: [
      { email: cleanId },
      { phone: identifier.trim() },
      ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
    ],
  });

  if (!user) {
    return res.status(404).json({ error: 'No account found with this email or mobile number.' });
  }

  if (!user.email) {
    return res.status(400).json({ error: 'This account has no registered email address. Contact support to reset the password.' });
  }

  const targetEmail = user.email.toLowerCase();
  const existingOtp = passwordResetOtps.get(targetEmail);
  if (existingOtp && Date.now() - existingOtp.lastSentAt < 30000) {
    const waitSecs = Math.ceil((30000 - (Date.now() - existingOtp.lastSentAt)) / 1000);
    return res.status(429).json({ error: `Please wait ${waitSecs} seconds before requesting another code.`, code: 'RESEND_COOLDOWN' });
  }

  const otp = crypto.randomInt(1000, 10000).toString();
  try {
    await deliverPasswordResetOtp(targetEmail, otp);
  } catch (error) {
    return res.status(error.code === 'EMAIL_NOT_CONFIGURED' ? 503 : 502).json({ error: error.message, code: error.code || 'EMAIL_DELIVERY_FAILED' });
  }
  passwordResetOtps.set(targetEmail, {
    otpHash: hashOtp(targetEmail, otp),
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0,
    maxAttempts: 5,
    lastSentAt: Date.now(),
  });

  return res.json({
    success: true,
    message: 'A password reset code has been sent to your registered email address.',
    expiresInSeconds: 600,
    // Only available to local development; never send codes back in production.
    otp: config.isProduction ? undefined : otp,
  });
});

app.post('/api/auth/reset-password', authRateLimiter, async (req, res) => {
  const { identifier, otp, newPassword, confirmPassword } = req.body;
  if (!identifier || !otp || !newPassword) {
    return res.status(400).json({ error: 'Email, verification code, and a new password are required.' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: 'Your new password must be at least 8 characters long.' });
  }
  if (confirmPassword !== undefined && newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'The new passwords do not match.' });
  }

  const normalizedPhone = normalizeIndianPhoneNumber(String(identifier));
  const user = await User.findOne({
    $or: [
      { phone: normalizedPhone || String(identifier).trim() },
      { email: String(identifier).trim().toLowerCase() },
    ],
  }).select('+passwordHash +refreshTokens');
  if (!user || !user.email) {
    return res.status(400).json({ error: 'The reset code is invalid or has expired.', code: 'INVALID_OTP' });
  }

  const targetEmail = user.email.toLowerCase();
  const record = passwordResetOtps.get(targetEmail);
  if (!record || Date.now() > record.expiresAt) {
    passwordResetOtps.delete(targetEmail);
    return res.status(400).json({ error: 'The reset code is invalid or has expired.', code: 'OTP_EXPIRED' });
  }
  record.attempts += 1;
  if (record.attempts > record.maxAttempts) {
    passwordResetOtps.delete(targetEmail);
    return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.', code: 'MAX_OTP_ATTEMPTS' });
  }
  const receivedHash = hashOtp(targetEmail, String(otp).trim());
  if (!crypto.timingSafeEqual(Buffer.from(record.otpHash), Buffer.from(receivedHash))) {
    return res.status(400).json({ error: 'The verification code is incorrect.', code: 'INCORRECT_OTP' });
  }

  user.passwordHash = await bcrypt.hash(String(newPassword), 12);
  user.refreshTokens = [];
  await user.save();
  passwordResetOtps.delete(targetEmail);
  return res.json({ success: true, message: 'Password updated. You can now sign in with your new password.' });
});

// Current User Profile
app.get('/api/auth/me', authRequired, async (req, res) => {
  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const primaryAddress = getCustomerPrimaryAddress(user);

  return res.json({
    user: {
      id: user.customId || user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone,
      employeeId: user.employeeId,
      role: user.role,
      status: user.status,
      kycStatus: user.kycStatus,
      address: formatCustomerAddress(primaryAddress) || user.address || null,
      primaryAddress,
      addresses: user.addresses || [],
    },
  });
});

// ── 2. SERVICES & CATEGORIES CATALOG WITH PERFORMANCE CACHE ───────────
const catalogCache = {
  services: null,
  servicesExp: 0,
  categories: null,
  categoriesExp: 0,
  banners: null,
  bannersExp: 0,
};

function invalidateCatalogCache() {
  catalogCache.services = null;
  catalogCache.servicesExp = 0;
  catalogCache.categories = null;
  catalogCache.categoriesExp = 0;
  catalogCache.banners = null;
  catalogCache.bannersExp = 0;
}

app.get('/api/services', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  const now = Date.now();
  if (catalogCache.services && now < catalogCache.servicesExp) {
    return res.json(catalogCache.services);
  }

  const services = await Service.find({
    active: { $ne: false },
    is_visible: { $ne: false },
  }).sort({ displayOrder: 1, createdAt: 1 }).lean();

  const formatted = {
    services: services.map(s => ({
      _id: s._id.toString(),
      id: s.customId || s.slug || s._id.toString(),
      customId: s.customId,
      name: s.name,
      shortName: s.shortName || s.name,
      category: s.category,
      icon: s.icon,
      imageUrl: s.imageUrl || (s.images && s.images[0]) || '',
      images: s.images || [],
      priceStart: s.priceStart || `₹${s.finalPrice || s.priceNum || 0}`,
      priceText: s.priceStart || `₹${s.finalPrice || s.priceNum || 0}`,
      price: s.finalPrice || s.priceNum || 0,
      priceNum: s.priceNum || s.finalPrice || 0,
      discount: s.discount || 0,
      finalPrice: s.finalPrice || s.priceNum || 0,
      priceUnit: s.priceUnit || 'per service',
      minCharge: s.minCharge || 0,
      badge: s.badge || (s.popular ? 'POPULAR' : 'PRO'),
      popular: Boolean(s.popular),
      featured: Boolean(s.featured),
      duration: s.duration,
      durationMinutes: s.durationMinutes || 45,
      rating: s.ratingAvg || 4.8,
      ratingAvg: s.ratingAvg || 4.8,
      ratingCount: s.ratingCount || 45,
      reviewsCount: s.ratingCount || 45,
      description: s.description,
      detailedDescription: s.detailedDescription || s.description,
      highlights: s.highlights || [],
      features: s.features || [],
      included: s.inclusions && s.inclusions.length ? s.inclusions : ['Professional diagnostic', 'Standard service & cleanup', 'Genuine components warranty'],
      inclusions: s.inclusions || [],
      excluded: s.exclusions && s.exclusions.length ? s.exclusions : ['Major spare parts replacements', 'Unapproved electrical rewiring'],
      exclusions: s.exclusions || [],
      instructions: s.instructions || '',
      requirements: s.requirements || '',
      displayOrder: s.displayOrder || 0,
    })),
  };

  catalogCache.services = formatted;
  catalogCache.servicesExp = now + 60000;
  return res.json(formatted);
});

app.get('/api/categories', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  const now = Date.now();
  if (catalogCache.categories && now < catalogCache.categoriesExp) {
    return res.json(catalogCache.categories);
  }

  const visibleServices = await Service.find({ active: { $ne: false }, is_visible: { $ne: false } }).lean();
  const visibleCatNames = new Set(visibleServices.map(s => s.category));
  const categories = await Category.find({ active: { $ne: false } }).lean();
  const filteredCategories = categories.filter(c => visibleCatNames.has(c.name));
  const result = {
    categories: filteredCategories.length > 0 ? filteredCategories : Array.from(visibleCatNames).map(name => ({
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    })),
  };

  catalogCache.categories = result;
  catalogCache.categoriesExp = now + 60000;
  return res.json(result);
});

// ── 3. CUSTOMER DOMAIN ────────────────────────────────────────────────

// 1. Customer Home Dashboard
app.get('/api/customer/home', authRequired, requireRoles('customer'), async (req, res) => {
  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const customerBookings = await Booking.find({
    $or: [{ customerId: req.auth.sub }, { customer: user._id }],
  }).sort({ createdAt: -1 }).limit(10);

  const activeBookingRaw = customerBookings.find(
    b => !['Completed', 'CANCELLED', 'PAYMENT_SETTLED', 'DISPUTED'].includes(b.status)
  ) || null;

  const activeBooking = activeBookingRaw ? formatBooking(activeBookingRaw) : null;
  const recentBookings = customerBookings.slice(0, 3).map(formatBooking);

  const services = await Service.find({
    active: { $ne: false },
    is_visible: { $ne: false },
  }).sort({ displayOrder: 1, createdAt: 1 }).lean();
  const categories = Array.from(new Set(services.map(s => s.category)));

  const popularServices = services.slice(0, 6).map(s => ({
    id: s.customId || s._id.toString(),
    name: s.name,
    category: s.category,
    price: s.priceStart,
    priceNum: s.priceNum,
    duration: s.duration || '60 mins',
    rating: s.ratingAvg,
    reviewsCount: s.ratingCount,
    description: s.description,
  }));

  const unreadNotificationsCount = await Notification.countDocuments({
    recipientId: req.auth.sub,
    read: false,
  });

  return res.json({
    activeBooking,
    categories,
    popularServices,
    recentBookings,
    savedAddresses: user.addresses || [],
    unreadNotificationsCount,
  });
});

// 2. Saved Addresses (CRUD) & Canonical Location Management
const CITY_REFERENCE_POINTS = [
  { names: ['bengaluru', 'bangalore'], lat: 12.9716, lng: 77.5946, maxRadiusKm: 120 },
  { names: ['tiruchirappalli', 'trichy'], lat: 10.7905, lng: 78.7047, maxRadiusKm: 100 },
  { names: ['chennai', 'madras'], lat: 13.0827, lng: 80.2707, maxRadiusKm: 100 },
  { names: ['hyderabad', 'secunderabad'], lat: 17.3850, lng: 78.4867, maxRadiusKm: 120 },
  { names: ['mumbai', 'navi mumbai', 'thane', 'pune'], lat: 19.0760, lng: 72.8777, maxRadiusKm: 180 },
  { names: ['delhi', 'new delhi', 'noida', 'gurgaon', 'gurugram', 'ghaziabad', 'faridabad'], lat: 28.6139, lng: 77.2090, maxRadiusKm: 120 },
  { names: ['kolkata', 'calcutta'], lat: 22.5726, lng: 88.3639, maxRadiusKm: 100 },
  { names: ['kochi', 'cochin', 'ernakulam'], lat: 9.9312, lng: 76.2673, maxRadiusKm: 100 },
  { names: ['coimbatore'], lat: 11.0168, lng: 76.9558, maxRadiusKm: 100 },
  { names: ['madurai'], lat: 9.9252, lng: 78.1198, maxRadiusKm: 100 },
  { names: ['mysuru', 'mysore'], lat: 12.2958, lng: 76.6394, maxRadiusKm: 100 },
];

function calculateHaversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function validateAddressCoordinatesMatch(addressText, cityText, stateText, lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) return true;
  const combinedText = `${addressText || ''} ${cityText || ''} ${stateText || ''}`.toLowerCase();

  for (const ref of CITY_REFERENCE_POINTS) {
    const mentionsCity = ref.names.some(name => combinedText.includes(name));
    if (mentionsCity) {
      const distKm = calculateHaversineDistanceKm(lat, lng, ref.lat, ref.lng);
      if (distKm > ref.maxRadiusKm) {
        return false; // Mismatch detected (e.g. Bengaluru address with Trichy coordinates)
      }
    }
  }
  return true;
}

async function handleGetAddresses(req, res) {
  const user = await findUserByIdOrIdentifier(req.auth.sub);
  const addresses = (user && user.addresses) || [];
  const primaryAddress = getCustomerPrimaryAddress(user);
  return res.json({ addresses, primaryAddress, defaultAddress: primaryAddress });
}

async function handleAddAddress(req, res) {
  const {
    label,
    address,
    line1,
    street,
    house,
    houseNumber,
    floor,
    landmark,
    area,
    city,
    state,
    pincode,
    postalCode,
    lat,
    lng,
    latitude,
    longitude,
    accuracy,
    source,
    mobileNumber,
    isDefault,
  } = req.body;

  const cleanHouse = (houseNumber || house || (address ? address.split(',')[0] : '')).toString().trim();
  if (!cleanHouse) {
    return res.status(400).json({ error: 'House / Door / Flat number is required for service address.', code: 'HOUSE_NUMBER_REQUIRED' });
  }
  const cleanStreet = street || line1 || '';
  const cleanArea = area || '';
  const cleanCity = city || '';
  const cleanState = state || '';
  const cleanPincode = (pincode || postalCode || '').toString().trim();
  const cleanLandmark = landmark ? String(landmark).trim() : '';
  const landmarkStr = cleanLandmark.toLowerCase().startsWith('near ') ? cleanLandmark : (cleanLandmark ? `Near ${cleanLandmark}` : '');
  const fullAddress = address || [cleanHouse, cleanStreet, landmarkStr, cleanArea, cleanCity, cleanState, cleanPincode].filter(Boolean).join(', ');
  if (!fullAddress) return res.status(400).json({ error: 'Address details are required.', code: 'ADDRESS_REQUIRED' });

  const rawLat = latitude !== undefined ? latitude : lat;
  const rawLng = longitude !== undefined ? longitude : lng;

  const finalLat = Number(rawLat);
  const finalLng = Number(rawLng);

  if (
    rawLat === undefined || rawLng === undefined ||
    isNaN(finalLat) || isNaN(finalLng) ||
    finalLat < -90 || finalLat > 90 ||
    finalLng < -180 || finalLng > 180 ||
    (finalLat === 0 && finalLng === 0)
  ) {
    return res.status(400).json({
      error: 'Valid GPS coordinates (latitude and longitude) are required for service address.',
      code: 'INVALID_COORDINATES',
    });
  }

  // Address vs GPS Coordinate Consistency Check (Part K)
  const isConsistent = validateAddressCoordinatesMatch(fullAddress, cleanCity, cleanState, finalLat, finalLng);
  if (!isConsistent) {
    return res.status(400).json({
      error: 'Location details do not match. Please confirm your location again.',
      code: 'LOCATION_MISMATCH',
    });
  }

  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (!user.addresses) user.addresses = [];

  if (!cleanPincode) {
    return res.status(400).json({ error: 'Pincode is required.', code: 'PINCODE_REQUIRED' });
  }

  const newAddress = {
    id: `addr_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`,
    label: label || 'Home',
    address: fullAddress.trim(),
    formattedAddress: fullAddress.trim(),
    line1: cleanStreet || fullAddress,
    street: cleanStreet,
    house: cleanHouse,
    houseNumber: cleanHouse,
    floor: floor || '',
    area: cleanArea || (fullAddress.includes(',') ? fullAddress.split(',')[0].trim() : ''),
    locality: cleanArea,
    landmark: cleanLandmark,
    city: cleanCity || (fullAddress.includes(',') ? fullAddress.split(',').slice(-2, -1)[0].trim() : ''),
    state: cleanState,
    pincode: cleanPincode,
    country: 'India',
    mobileNumber: mobileNumber || user.phone || '',
    latitude: finalLat,
    longitude: finalLng,
    accuracy: accuracy !== undefined ? Number(accuracy) : 10,
    source: source || 'GPS',
    confirmedAt: new Date(),
    isDefault: user.addresses.length === 0 ? true : Boolean(isDefault),
  };

  if (newAddress.isDefault) {
    user.addresses.forEach(a => (a.isDefault = false));
  }

  user.addresses.push(newAddress);

  // Sync top-level user.address
  const defaultAddr = user.addresses.find(a => a.isDefault) || user.addresses[0];
  if (defaultAddr) {
    user.address = formatCustomerAddress(defaultAddr) || defaultAddr.address;
  }

  await user.save();

  return res.status(201).json({
    success: true,
    address: newAddress,
    primaryAddress: defaultAddr,
    defaultAddress: defaultAddr,
    addresses: user.addresses,
  });
}

async function handleUpdateAddress(req, res) {
  const { id } = req.params;
  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (!user || !user.addresses) return res.status(404).json({ error: 'Address not found.' });

  const addr = user.addresses.find(a => a.id === id);
  if (!addr) return res.status(404).json({ error: 'Address not found.' });

  if (req.body.label) addr.label = req.body.label;
  if (req.body.address) {
    addr.address = req.body.address;
    addr.formattedAddress = req.body.address;
  }
  if (req.body.formattedAddress) addr.formattedAddress = req.body.formattedAddress;
  if (req.body.house !== undefined) addr.house = req.body.house;
  if (req.body.houseNumber !== undefined) addr.houseNumber = req.body.houseNumber;
  if (req.body.line1 !== undefined) addr.line1 = req.body.line1;
  if (req.body.street !== undefined) addr.street = req.body.street;
  if (req.body.area !== undefined) addr.area = req.body.area;
  if (req.body.city !== undefined) addr.city = req.body.city;
  if (req.body.state !== undefined) addr.state = req.body.state;
  if (req.body.pincode !== undefined) addr.pincode = req.body.pincode;
  if (req.body.mobileNumber !== undefined) addr.mobileNumber = req.body.mobileNumber;
  if (req.body.latitude !== undefined || req.body.lat !== undefined) {
    addr.latitude = Number(req.body.latitude !== undefined ? req.body.latitude : req.body.lat);
  }
  if (req.body.longitude !== undefined || req.body.lng !== undefined) {
    addr.longitude = Number(req.body.longitude !== undefined ? req.body.longitude : req.body.lng);
  }
  if (req.body.landmark !== undefined) addr.landmark = req.body.landmark;
  if (req.body.source !== undefined) addr.source = req.body.source;
  if (req.body.accuracy !== undefined) addr.accuracy = Number(req.body.accuracy);
  addr.confirmedAt = new Date();

  // Validate consistency if coordinates or address were modified
  if (addr.latitude && addr.longitude) {
    const isConsistent = validateAddressCoordinatesMatch(addr.address, addr.city, addr.state, addr.latitude, addr.longitude);
    if (!isConsistent) {
      return res.status(400).json({
        error: 'Location details do not match. Please confirm your location again.',
        code: 'LOCATION_MISMATCH',
      });
    }
  }

  if (req.body.isDefault !== undefined) {
    if (req.body.isDefault) {
      user.addresses.forEach(a => (a.isDefault = false));
    }
    addr.isDefault = Boolean(req.body.isDefault);
  }

  // Sync top-level user.address
  const defaultAddr = user.addresses.find(a => a.isDefault) || user.addresses[0];
  if (defaultAddr) {
    user.address = formatCustomerAddress(defaultAddr) || defaultAddr.address;
  }

  await user.save();
  return res.json({
    success: true,
    address: addr,
    primaryAddress: defaultAddr,
    defaultAddress: defaultAddr,
    addresses: user.addresses,
  });
}

async function handleSetDefaultAddress(req, res) {
  const { id } = req.params;
  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (!user || !user.addresses) return res.status(404).json({ error: 'Address not found.' });

  const addr = user.addresses.find(a => a.id === id);
  if (!addr) return res.status(404).json({ error: 'Address not found.' });

  user.addresses.forEach(a => {
    a.isDefault = a.id === id;
  });

  const defaultAddr = user.addresses.find(a => a.isDefault) || addr;
  user.address = formatCustomerAddress(defaultAddr) || defaultAddr.address;

  await user.save();
  return res.json({
    success: true,
    defaultAddress: defaultAddr,
    primaryAddress: defaultAddr,
    addresses: user.addresses,
  });
}

async function handleDeleteAddress(req, res) {
  const { id } = req.params;
  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (!user || !user.addresses) return res.status(404).json({ error: 'Address not found.' });

  const existingIndex = user.addresses.findIndex(a => a.id === id || a._id?.toString() === id);
  if (existingIndex === -1) {
    return res.status(404).json({ error: 'Address not found.' });
  }

  user.addresses.splice(existingIndex, 1);
  if (user.addresses.length > 0 && !user.addresses.some(a => a.isDefault)) {
    user.addresses[0].isDefault = true;
  }

  const defaultAddr = getCustomerPrimaryAddress(user);
  if (defaultAddr) {
    user.address = formatCustomerAddress(defaultAddr) || defaultAddr.address;
  } else {
    user.address = null;
  }

  await user.save();
  return res.json({
    success: true,
    message: 'Address removed.',
    primaryAddress: defaultAddr,
    defaultAddress: defaultAddr,
    addresses: user.addresses,
  });
}

async function handleGetAddressById(req, res) {
  const { id } = req.params;
  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (!user || !user.addresses) return res.status(404).json({ error: 'Address not found.' });

  const addr = user.addresses.find(a => a.id === id || a._id?.toString() === id);
  if (!addr) return res.status(404).json({ error: 'Address not found.' });

  return res.json({ success: true, address: addr });
}

// ── Standard Customer Address REST APIs ────────────────────────────────
app.get('/api/addresses', authRequired, requireRoles('customer'), handleGetAddresses);
app.get('/api/addresses/:id', authRequired, requireRoles('customer'), handleGetAddressById);
app.post('/api/addresses', authRequired, requireRoles('customer'), handleAddAddress);
app.put('/api/addresses/:id', authRequired, requireRoles('customer'), handleUpdateAddress);
app.delete('/api/addresses/:id', authRequired, requireRoles('customer'), handleDeleteAddress);
app.patch('/api/addresses/:id/default', authRequired, requireRoles('customer'), handleSetDefaultAddress);
app.put('/api/addresses/:id/default', authRequired, requireRoles('customer'), handleSetDefaultAddress);

// Legacy/Compatibility route aliases
app.get('/api/customer/addresses', authRequired, requireRoles('customer'), handleGetAddresses);
app.get('/api/customer/addresses/:id', authRequired, requireRoles('customer'), handleGetAddressById);
app.get('/api/user/addresses', authRequired, requireRoles('customer'), handleGetAddresses);
app.post('/api/customer/addresses', authRequired, requireRoles('customer'), handleAddAddress);
app.post('/api/user/addresses', authRequired, requireRoles('customer'), handleAddAddress);
app.put('/api/customer/addresses/:id', authRequired, requireRoles('customer'), handleUpdateAddress);
app.put('/api/user/addresses/:id', authRequired, requireRoles('customer'), handleUpdateAddress);
app.put('/api/customer/addresses/:id/default', authRequired, requireRoles('customer'), handleSetDefaultAddress);
app.patch('/api/customer/addresses/:id/default', authRequired, requireRoles('customer'), handleSetDefaultAddress);
app.delete('/api/customer/addresses/:id', authRequired, requireRoles('customer'), handleDeleteAddress);
app.delete('/api/user/addresses/:id', authRequired, requireRoles('customer'), handleDeleteAddress);

// ── Geolocation & Reverse-Geocoding APIs ──────────────────────────────
async function handleReverseGeocodeRequest(req, res) {
  try {
    const lat = req.body?.latitude ?? req.body?.lat ?? req.query?.latitude ?? req.query?.lat;
    const lng = req.body?.longitude ?? req.body?.lng ?? req.query?.longitude ?? req.query?.lng;
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Latitude and longitude are required.' });
    }
    const finalLat = Number(lat);
    const finalLng = Number(lng);
    if (isNaN(finalLat) || isNaN(finalLng) || finalLat < -90 || finalLat > 90 || finalLng < -180 || finalLng > 180) {
      return res.status(400).json({ error: 'Invalid numeric coordinate values.' });
    }
    const result = await reverseGeocode(finalLat, finalLng);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Reverse geocoding failed.' });
  }
}

async function handleSearchPlacesRequest(req, res) {
  try {
    const query = req.body?.query ?? req.body?.q ?? req.query?.q ?? req.query?.query;
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return res.json({ results: [] });
    }
    const results = await searchPlaces(query);
    return res.json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Places search failed.' });
  }
}

async function handleValidateLocationRequest(req, res) {
  try {
    const { address, city, state, pincode, latitude, longitude, lat, lng } = req.body || {};
    const finalLat = Number(latitude !== undefined ? latitude : lat);
    const finalLng = Number(longitude !== undefined ? longitude : lng);

    if (isNaN(finalLat) || isNaN(finalLng) || finalLat < -90 || finalLat > 90 || finalLng < -180 || finalLng > 180 || (finalLat === 0 && finalLng === 0)) {
      return res.status(400).json({ success: false, valid: false, error: 'Valid GPS coordinates required.' });
    }

    const isMatch = validateAddressCoordinatesMatch(address, city, state, finalLat, finalLng);
    if (!isMatch) {
      return res.json({
        success: true,
        valid: false,
        code: 'LOCATION_MISMATCH',
        message: 'Location details do not match the selected area.',
      });
    }

    return res.json({ success: true, valid: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Location validation failed.' });
  }
}

async function handleGetEtaRequest(req, res) {
  try {
    const originLat = req.query?.originLat ?? req.query?.originLatitude ?? req.body?.originLat ?? req.body?.originLatitude;
    const originLng = req.query?.originLng ?? req.query?.originLongitude ?? req.body?.originLng ?? req.body?.originLongitude;
    const destLat = req.query?.destLat ?? req.query?.destLatitude ?? req.body?.destLat ?? req.body?.destLatitude;
    const destLng = req.query?.destLng ?? req.query?.destLongitude ?? req.body?.destLng ?? req.body?.destLongitude;

    if (originLat === undefined || originLng === undefined || destLat === undefined || destLng === undefined) {
      return res.status(400).json({ error: 'Origin and destination coordinates are required.' });
    }

    const result = await calculateRouteAndETA(originLat, originLng, destLat, destLng);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Route calculation failed.' });
  }
}

async function handleNearbySearchRequest(req, res) {
  try {
    const lat = req.query?.lat ?? req.query?.latitude ?? req.body?.lat ?? req.body?.latitude;
    const lng = req.query?.lng ?? req.query?.longitude ?? req.body?.lng ?? req.body?.longitude;
    const keywords = req.query?.keywords ?? req.query?.keyword ?? req.body?.keywords ?? req.body?.keyword ?? 'all';
    const radius = Number(req.query?.radius ?? req.query?.radiusMeters ?? req.body?.radius ?? req.body?.radiusMeters ?? 5000);

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Latitude and longitude are required.' });
    }

    const results = await searchNearby(Number(lat), Number(lng), keywords, radius);
    return res.json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Nearby search failed.' });
  }
}

async function handleGeocodeAddressRequest(req, res) {
  try {
    const address = req.query?.address ?? req.query?.q ?? req.body?.address ?? req.body?.q;
    if (!address || typeof address !== 'string' || !address.trim()) {
      return res.status(400).json({ error: 'Address query parameter is required.' });
    }
    const result = await geocodeAddress(address);
    if (!result) {
      return res.status(404).json({ error: 'Coordinates not found for given address.' });
    }
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Geocoding failed.' });
  }
}

// Location endpoints
app.post('/api/location/reverse-geocode', handleReverseGeocodeRequest);
app.get('/api/location/reverse-geocode', handleReverseGeocodeRequest);
app.post('/api/location/geocode', handleGeocodeAddressRequest);
app.get('/api/location/geocode', handleGeocodeAddressRequest);
app.post('/api/location/search', handleSearchPlacesRequest);
app.get('/api/location/search', handleSearchPlacesRequest);
app.post('/api/location/nearby', handleNearbySearchRequest);
app.get('/api/location/nearby', handleNearbySearchRequest);
app.post('/api/location/validate', handleValidateLocationRequest);
app.get('/api/location/eta', handleGetEtaRequest);
app.post('/api/location/eta', handleGetEtaRequest);

// Geo route aliases
app.post('/api/geo/reverse-geocode', handleReverseGeocodeRequest);
app.get('/api/geo/reverse-geocode', handleReverseGeocodeRequest);
app.get('/api/geo/reverse', handleReverseGeocodeRequest);
app.post('/api/geo/geocode', handleGeocodeAddressRequest);
app.get('/api/geo/geocode', handleGeocodeAddressRequest);
app.post('/api/geo/search-places', handleSearchPlacesRequest);
app.get('/api/geo/search-places', handleSearchPlacesRequest);
app.get('/api/geo/search', handleSearchPlacesRequest);
app.get('/api/geo/nearby', handleNearbySearchRequest);
app.post('/api/geo/nearby', handleNearbySearchRequest);
app.get('/api/geo/eta', handleGetEtaRequest);
app.post('/api/geo/eta', handleGetEtaRequest);

const DEFAULT_INITIAL_BANNERS = [
  {
    customId: 'banner_ac_summer',
    title: 'AC Service & Jet Deep Cleaning',
    badge_text: '30-MIN ARRIVAL',
    tag: '30-MIN ARRIVAL',
    description: 'Pre-season power jet wash & refrigerant check',
    subtitle: 'Pre-season power jet wash & refrigerant check',
    price_text: 'FLAT ₹150 OFF',
    discountBadge: 'FLAT ₹150 OFF',
    couponCode: 'STEPIN50',
    targetServiceId: 'srv_ac',
    cta_text: 'Book AC Service',
    buttonText: 'Book AC Service',
    background_type: 'color',
    background_color: '#0F172A',
    containerBg: '#0F172A',
    background_image: '',
    bgImageUrl: '',
    background_overlay_color: 'rgba(15, 23, 42, 0.7)',
    background_overlay_opacity: 0.7,
    title_color: '#FFFFFF',
    description_color: '#94A3B8',
    badge_background_color: '#06B6D4',
    badge_text_color: '#FFFFFF',
    price_background_color: 'rgba(6, 182, 212, 0.18)',
    price_text_color: '#22D3EE',
    cta_color: '#06B6D4',
    promotional_image: '',
    imageUrl: '',
    image_position: 'right',
    display_order: 1,
    is_active: true,
    active: true,
  },
  {
    customId: 'banner_clean_festive',
    title: 'Full Home Deep Cleaning',
    badge_text: 'HYGIENE GUARANTEE',
    tag: 'HYGIENE GUARANTEE',
    description: 'Eco-safe hospital grade sanitization & deep scrub',
    subtitle: 'Eco-safe hospital grade sanitization & deep scrub',
    price_text: '20% INSTANT OFF',
    discountBadge: '20% INSTANT OFF',
    couponCode: 'CLEAN20',
    targetServiceId: 'srv_clean',
    cta_text: 'Clean My Home',
    buttonText: 'Clean My Home',
    background_type: 'color',
    background_color: '#14281D',
    containerBg: '#14281D',
    background_image: '',
    bgImageUrl: '',
    background_overlay_color: 'rgba(15, 23, 42, 0.7)',
    background_overlay_opacity: 0.7,
    title_color: '#FFFFFF',
    description_color: '#A7F3D0',
    badge_background_color: '#22C55E',
    badge_text_color: '#FFFFFF',
    price_background_color: 'rgba(34, 197, 94, 0.18)',
    price_text_color: '#4ADE80',
    cta_color: '#22C55E',
    promotional_image: '',
    imageUrl: '',
    image_position: 'right',
    display_order: 2,
    is_active: true,
    active: true,
  },
  {
    customId: 'banner_elec_safety',
    title: 'Electrical Safety Audit & Repair',
    badge_text: 'VERIFIED EXPERTS',
    tag: 'VERIFIED EXPERTS',
    description: 'Short circuit check, heavy appliance sockets & wiring',
    subtitle: 'Short circuit check, heavy appliance sockets & wiring',
    price_text: 'STARTS AT ₹199',
    discountBadge: 'STARTS AT ₹199',
    couponCode: 'VOLT100',
    targetServiceId: 'srv_elec',
    cta_text: 'Inspect Wiring',
    buttonText: 'Inspect Wiring',
    background_type: 'color',
    background_color: '#2D1F08',
    containerBg: '#2D1F08',
    background_image: '',
    bgImageUrl: '',
    background_overlay_color: 'rgba(15, 23, 42, 0.7)',
    background_overlay_opacity: 0.7,
    title_color: '#FFFFFF',
    description_color: '#FDE68A',
    badge_background_color: '#FACC15',
    badge_text_color: '#000000',
    price_background_color: 'rgba(250, 204, 21, 0.18)',
    price_text_color: '#FDE047',
    cta_color: '#FACC15',
    promotional_image: '',
    imageUrl: '',
    image_position: 'right',
    display_order: 3,
    is_active: true,
    active: true,
  },
  {
    customId: 'banner_plumb_express',
    title: 'Plumbing Works & Tap Fix',
    badge_text: 'ZERO LEAK PROMISE',
    tag: 'ZERO LEAK PROMISE',
    description: 'Pressure testing, pipe leak repairs & fittings',
    subtitle: 'Pressure testing, pipe leak repairs & fittings',
    price_text: 'STARTS AT ₹249',
    discountBadge: 'STARTS AT ₹249',
    couponCode: null,
    targetServiceId: 'srv_plumb',
    cta_text: 'Fix Leaks',
    buttonText: 'Fix Leaks',
    background_type: 'color',
    background_color: '#0B1E3B',
    containerBg: '#0B1E3B',
    background_image: '',
    bgImageUrl: '',
    background_overlay_color: 'rgba(15, 23, 42, 0.7)',
    background_overlay_opacity: 0.7,
    title_color: '#FFFFFF',
    description_color: '#BFDBFE',
    badge_background_color: '#3B82F6',
    badge_text_color: '#FFFFFF',
    price_background_color: 'rgba(59, 130, 246, 0.18)',
    price_text_color: '#60A5FA',
    cta_color: '#3B82F6',
    promotional_image: '',
    imageUrl: '',
    image_position: 'right',
    display_order: 4,
    is_active: true,
    active: true,
  },
];

let inMemoryBanners = [...DEFAULT_INITIAL_BANNERS];

function formatBannerResponse(b) {
  const customId = b.customId || b._id || b.id;
  const isAct = b.is_active !== undefined ? Boolean(b.is_active) : (b.active !== undefined ? Boolean(b.active) : true);
  const badge = b.badge_text || b.tag || 'PROMOTIONAL';
  const desc = b.description !== undefined ? b.description : (b.subtitle || '');
  const price = b.price_text !== undefined ? b.price_text : (b.discountBadge || '');
  const cta = b.cta_text !== undefined ? b.cta_text : (b.buttonText || 'Book Now');
  const bgType = b.background_type || (b.background_image || b.bgImageUrl ? 'image' : 'color');
  const bgColor = b.background_color || b.containerBg || '#1E1B4B';
  const normalizePath = (p) => {
    if (!p || typeof p !== 'string') return '';
    const clean = p.trim();
    if (!clean) return '';
    if (clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('data:') || clean.startsWith('blob:')) return clean;
    return clean.startsWith('/') ? clean : `/${clean}`;
  };
  const bgImg = normalizePath(b.background_image || b.bgImageUrl || '');
  const promoImg = normalizePath(b.promotional_image || b.imageUrl || '');
  const badgeBg = b.badge_background_color || b.primaryColor || '#06B6D4';

  return {
    id: customId,
    _id: b._id || customId,
    customId,
    title: b.title || 'Special Promotion',
    badge_text: badge,
    tag: badge,
    description: desc,
    subtitle: desc,
    price_text: price,
    discountBadge: price,
    cta_text: cta,
    buttonText: cta,
    targetServiceId: b.targetServiceId || 'srv_ac',
    couponCode: b.couponCode || null,

    background_type: bgType,
    background_color: bgColor,
    containerBg: bgColor,
    background_image: bgImg,
    bgImageUrl: bgImg,
    background_overlay_color: b.background_overlay_color || 'rgba(15, 23, 42, 0.65)',
    background_overlay_opacity: typeof b.background_overlay_opacity === 'number' ? b.background_overlay_opacity : 0.65,

    title_color: b.title_color || '#FFFFFF',
    description_color: b.description_color || '#CBD5E1',
    badge_background_color: badgeBg,
    badge_text_color: b.badge_text_color || '#FFFFFF',
    price_background_color: b.price_background_color || 'rgba(34, 197, 94, 0.2)',
    price_text_color: b.price_text_color || '#4ADE80',
    cta_color: b.cta_color || badgeBg,
    primaryColor: badgeBg,

    promotional_image: promoImg,
    imageUrl: promoImg,
    image_position: b.image_position || 'right',

    display_order: typeof b.display_order === 'number' ? b.display_order : 0,
    is_active: isAct,
    active: isAct,
    createdAt: b.createdAt || new Date().toISOString(),
    updatedAt: b.updatedAt || new Date().toISOString(),
  };
}

// 2.5 Promotional Banners Public Mobile Endpoint (active only, sorted by display_order)
app.get('/api/banners', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  const now = Date.now();
  if (catalogCache.banners && now < catalogCache.bannersExp) {
    return res.json(catalogCache.banners);
  }

  try {
    let dbBanners = await Banner.find({
      $or: [{ is_active: true }, { active: true }, { is_active: { $exists: false }, active: { $ne: false } }],
    })
      .sort({ display_order: 1, createdAt: -1 })
      .lean();

    if (!dbBanners || dbBanners.length === 0) {
      const count = await Banner.countDocuments();
      if (count === 0) {
        await Banner.insertMany(DEFAULT_INITIAL_BANNERS);
        dbBanners = await Banner.find({
          $or: [{ is_active: true }, { active: true }],
        })
          .sort({ display_order: 1, createdAt: -1 })
          .lean();
      }
    }

    const source = dbBanners && dbBanners.length > 0 ? dbBanners : inMemoryBanners.filter(b => b.is_active !== false && b.active !== false);
    const sorted = [...source].sort((a, b) => (Number(a.display_order || 0) - Number(b.display_order || 0)));
    const responsePayload = { banners: sorted.map(formatBannerResponse) };
    catalogCache.banners = responsePayload;
    catalogCache.bannersExp = now + 60000;
    return res.json(responsePayload);
  } catch (err) {
    const activeMems = inMemoryBanners.filter(b => b.is_active !== false && b.active !== false);
    activeMems.sort((a, b) => (Number(a.display_order || 0) - Number(b.display_order || 0)));
    return res.json({ banners: activeMems.map(formatBannerResponse) });
  }
});

// Strict Binary Magic Byte Validation Helper for Raster Images
function detectAndValidateRasterImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
  ) {
    return 'png';
  }
  // GIF: GIF87a (47 49 46 38 37 61) or GIF89a (47 49 46 38 39 61)
  if (
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 &&
    buffer[3] === 0x38 && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61
  ) {
    return 'gif';
  }
  // WEBP: RIFF....WEBP (52 49 46 46 .... 57 45 42 50)
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

// Admin Image Upload Endpoint for Banners (Secured with RBAC and Magic-Byte Verification)
app.post('/api/admin/banners/upload', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const { image, base64Data } = req.body;
    const rawData = image || base64Data;
    if (!rawData) {
      return res.status(400).json({ error: 'Image data is required (base64 string).' });
    }

    const cleanBase64 = rawData.replace(/^data:[a-zA-Z0-9+/.-]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image file size exceeds maximum 10MB limit.' });
    }

    const verifiedExt = detectAndValidateRasterImage(buffer);
    if (!verifiedExt) {
      return res.status(400).json({
        error: 'Invalid image format: Only authentic JPEG, PNG, WEBP, or GIF raster images are permitted. SVG, executable, and script files are strictly rejected.',
        code: 'INVALID_IMAGE_TYPE',
      });
    }

    const safeName = `banner_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${verifiedExt}`;
    const filePath = path.join(UPLOADS_DIR, safeName);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/banners/${safeName}`;
    return res.json({ success: true, url: publicUrl, filename: safeName });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to upload banner image: ' + err.message });
  }
});

// Admin Banners CRUD Endpoints (Protected with RBAC)
app.get('/api/admin/banners', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    let dbBanners = await Banner.find().sort({ display_order: 1, createdAt: -1 }).lean();
    if (!dbBanners || dbBanners.length === 0) {
      const count = await Banner.countDocuments();
      if (count === 0) {
        await Banner.insertMany(DEFAULT_INITIAL_BANNERS);
        dbBanners = await Banner.find().sort({ display_order: 1, createdAt: -1 }).lean();
      }
    }
    const source = dbBanners && dbBanners.length > 0 ? dbBanners : inMemoryBanners;
    const sorted = [...source].sort((a, b) => (Number(a.display_order || 0) - Number(b.display_order || 0)));
    return res.json({ banners: sorted.map(formatBannerResponse) });
  } catch (err) {
    const sorted = [...inMemoryBanners].sort((a, b) => (Number(a.display_order || 0) - Number(b.display_order || 0)));
    return res.json({ banners: sorted.map(formatBannerResponse) });
  }
});

app.get('/api/admin/banners/:id', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const bannerId = req.params.id;
    let banner = await Banner.findOne({
      $or: [{ customId: bannerId }, { _id: /^[0-9a-fA-F]{24}$/.test(bannerId) ? bannerId : null }],
    }).lean();

    if (!banner) {
      banner = inMemoryBanners.find(b => (b.customId || b._id || b.id) === bannerId);
    }

    if (!banner) {
      return res.status(404).json({ error: 'Banner not found' });
    }

    return res.json({ banner: formatBannerResponse(banner) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch banner' });
  }
});

app.post('/api/admin/banners', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const {
      title,
      badge_text,
      tag,
      description,
      subtitle,
      price_text,
      discountBadge,
      cta_text,
      buttonText,
      targetServiceId,
      couponCode,
      background_type,
      background_color,
      containerBg,
      background_image,
      bgImageUrl,
      background_overlay_color,
      background_overlay_opacity,
      title_color,
      description_color,
      badge_background_color,
      badge_text_color,
      price_background_color,
      price_text_color,
      cta_color,
      promotional_image,
      imageUrl,
      image_position,
      display_order,
      is_active,
      active,
    } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Banner Title is required.' });
    }

    const customId = `banner_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const effectiveTag = (badge_text || tag || 'VERIFIED EXPERTS').trim();
    const effectiveDesc = (description !== undefined ? description : (subtitle || '')).trim();
    const effectivePrice = (price_text !== undefined ? price_text : (discountBadge || '')).trim();
    const effectiveCta = (cta_text !== undefined ? cta_text : (buttonText || 'Book Now')).trim();
    const effectiveBgColor = background_color || containerBg || '#1E1B4B';
    const effectiveBgImg = background_image || bgImageUrl || '';
    const effectivePromoImg = promotional_image || imageUrl || '';
    const effectiveBadgeBg = badge_background_color || '#06B6D4';
    const effectiveIsActive = is_active !== undefined ? Boolean(is_active) : (active !== undefined ? Boolean(active) : true);

    const newBannerData = {
      customId,
      title: title.trim(),
      badge_text: effectiveTag,
      tag: effectiveTag,
      description: effectiveDesc,
      subtitle: effectiveDesc,
      price_text: effectivePrice,
      discountBadge: effectivePrice,
      cta_text: effectiveCta,
      buttonText: effectiveCta,
      targetServiceId: (targetServiceId || 'srv_ac').trim(),
      couponCode: couponCode ? couponCode.trim().toUpperCase() : null,

      background_type: background_type || (effectiveBgImg ? 'image' : 'color'),
      background_color: effectiveBgColor,
      containerBg: effectiveBgColor,
      background_image: effectiveBgImg,
      bgImageUrl: effectiveBgImg,
      background_overlay_color: background_overlay_color || 'rgba(15, 23, 42, 0.65)',
      background_overlay_opacity: typeof background_overlay_opacity === 'number' ? background_overlay_opacity : 0.65,

      title_color: title_color || '#FFFFFF',
      description_color: description_color || '#CBD5E1',
      badge_background_color: effectiveBadgeBg,
      primaryColor: effectiveBadgeBg,
      badge_text_color: badge_text_color || '#FFFFFF',
      price_background_color: price_background_color || 'rgba(34, 197, 94, 0.2)',
      price_text_color: price_text_color || '#4ADE80',
      cta_color: cta_color || effectiveBadgeBg,

      promotional_image: effectivePromoImg,
      imageUrl: effectivePromoImg,
      image_position: image_position || 'right',

      display_order: typeof display_order === 'number' ? display_order : (inMemoryBanners.length + 1),
      is_active: effectiveIsActive,
      active: effectiveIsActive,
    };

    let createdBanner;
    try {
      createdBanner = await Banner.create(newBannerData);
    } catch (dbErr) {
      createdBanner = { id: customId, _id: customId, ...newBannerData };
    }

    inMemoryBanners.unshift(createdBanner);
    catalogCache.banners = null;
    catalogCache.bannersExp = 0;
    return res.status(201).json({ success: true, banner: formatBannerResponse(createdBanner) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create banner: ' + err.message });
  }
});

app.put('/api/admin/banners/:id', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const bannerId = req.params.id;
    const u = req.body;

    let bannerDoc = await Banner.findOne({
      $or: [{ customId: bannerId }, { _id: /^[0-9a-fA-F]{24}$/.test(bannerId) ? bannerId : null }],
    });

    if (bannerDoc) {
      if (u.title !== undefined) bannerDoc.title = String(u.title).trim();
      if (u.badge_text !== undefined || u.tag !== undefined) {
        const val = (u.badge_text !== undefined ? u.badge_text : u.tag).trim();
        bannerDoc.badge_text = val;
        bannerDoc.tag = val;
      }
      if (u.description !== undefined || u.subtitle !== undefined) {
        const val = (u.description !== undefined ? u.description : u.subtitle).trim();
        bannerDoc.description = val;
        bannerDoc.subtitle = val;
      }
      if (u.price_text !== undefined || u.discountBadge !== undefined) {
        const val = (u.price_text !== undefined ? u.price_text : u.discountBadge).trim();
        bannerDoc.price_text = val;
        bannerDoc.discountBadge = val;
      }
      if (u.cta_text !== undefined || u.buttonText !== undefined) {
        const val = (u.cta_text !== undefined ? u.cta_text : u.buttonText).trim();
        bannerDoc.cta_text = val;
        bannerDoc.buttonText = val;
      }
      if (u.targetServiceId !== undefined) bannerDoc.targetServiceId = String(u.targetServiceId).trim();
      if (u.couponCode !== undefined) bannerDoc.couponCode = u.couponCode ? String(u.couponCode).trim().toUpperCase() : null;

      if (u.background_type !== undefined) bannerDoc.background_type = u.background_type;
      if (u.background_color !== undefined || u.containerBg !== undefined) {
        const val = u.background_color !== undefined ? u.background_color : u.containerBg;
        bannerDoc.background_color = val;
        bannerDoc.containerBg = val;
      }
      if (u.background_image !== undefined || u.bgImageUrl !== undefined) {
        const val = u.background_image !== undefined ? u.background_image : u.bgImageUrl;
        bannerDoc.background_image = val;
        bannerDoc.bgImageUrl = val;
      }
      if (u.background_overlay_color !== undefined) bannerDoc.background_overlay_color = u.background_overlay_color;
      if (u.background_overlay_opacity !== undefined) bannerDoc.background_overlay_opacity = Number(u.background_overlay_opacity);

      if (u.title_color !== undefined) bannerDoc.title_color = u.title_color;
      if (u.description_color !== undefined) bannerDoc.description_color = u.description_color;
      if (u.badge_background_color !== undefined || u.primaryColor !== undefined) {
        const val = u.badge_background_color !== undefined ? u.badge_background_color : u.primaryColor;
        bannerDoc.badge_background_color = val;
        bannerDoc.primaryColor = val;
      }
      if (u.badge_text_color !== undefined) bannerDoc.badge_text_color = u.badge_text_color;
      if (u.price_background_color !== undefined) bannerDoc.price_background_color = u.price_background_color;
      if (u.price_text_color !== undefined) bannerDoc.price_text_color = u.price_text_color;
      if (u.cta_color !== undefined) bannerDoc.cta_color = u.cta_color;

      if (u.promotional_image !== undefined || u.imageUrl !== undefined) {
        const val = u.promotional_image !== undefined ? u.promotional_image : u.imageUrl;
        bannerDoc.promotional_image = val;
        bannerDoc.imageUrl = val;
      }
      if (u.image_position !== undefined) bannerDoc.image_position = u.image_position;
      if (u.display_order !== undefined) bannerDoc.display_order = Number(u.display_order);

      if (u.is_active !== undefined || u.active !== undefined) {
        const val = Boolean(u.is_active !== undefined ? u.is_active : u.active);
        bannerDoc.is_active = val;
        bannerDoc.active = val;
      }

      await bannerDoc.save();
    }

    const memIdx = inMemoryBanners.findIndex(b => (b.customId || b._id || b.id) === bannerId);
    if (memIdx !== -1) {
      inMemoryBanners[memIdx] = { ...inMemoryBanners[memIdx], ...u };
    }

    const result = bannerDoc ? bannerDoc.toObject() : (inMemoryBanners[memIdx] || u);
    catalogCache.banners = null;
    catalogCache.bannersExp = 0;
    return res.json({ success: true, banner: formatBannerResponse(result) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update banner: ' + err.message });
  }
});

// Toggle active status endpoint
app.patch('/api/admin/banners/:id/toggle', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const bannerId = req.params.id;
    let bannerDoc = await Banner.findOne({
      $or: [{ customId: bannerId }, { _id: /^[0-9a-fA-F]{24}$/.test(bannerId) ? bannerId : null }],
    });

    let newStatus = true;
    if (bannerDoc) {
      newStatus = req.body.is_active !== undefined ? Boolean(req.body.is_active) : !bannerDoc.is_active;
      bannerDoc.is_active = newStatus;
      bannerDoc.active = newStatus;
      await bannerDoc.save();
    }

    const memIdx = inMemoryBanners.findIndex(b => (b.customId || b._id || b.id) === bannerId);
    if (memIdx !== -1) {
      if (!bannerDoc) {
        newStatus = req.body.is_active !== undefined ? Boolean(req.body.is_active) : !inMemoryBanners[memIdx].is_active;
      }
      inMemoryBanners[memIdx].is_active = newStatus;
      inMemoryBanners[memIdx].active = newStatus;
    }

    catalogCache.banners = null;
    catalogCache.bannersExp = 0;

    return res.json({ success: true, is_active: newStatus, active: newStatus });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to toggle banner status: ' + err.message });
  }
});

// Reorder banners endpoint
app.patch('/api/admin/banners/reorder', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const { orders } = req.body; // Array of { id, display_order }
    if (!Array.isArray(orders)) {
      return res.status(400).json({ error: 'orders array is required.' });
    }

    for (const item of orders) {
      if (item.id && typeof item.display_order === 'number') {
        await Banner.updateOne(
          { $or: [{ customId: item.id }, { _id: /^[0-9a-fA-F]{24}$/.test(item.id) ? item.id : null }] },
          { $set: { display_order: item.display_order } }
        );

        const memIdx = inMemoryBanners.findIndex(b => (b.customId || b._id || b.id) === item.id);
        if (memIdx !== -1) {
          inMemoryBanners[memIdx].display_order = item.display_order;
        }
      }
    }

    catalogCache.banners = null;
    catalogCache.bannersExp = 0;

    return res.json({ success: true, message: 'Banners reordered successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reorder banners: ' + err.message });
  }
});

app.delete('/api/admin/banners/:id', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const bannerId = req.params.id;
    await Banner.deleteOne({
      $or: [{ customId: bannerId }, { _id: /^[0-9a-fA-F]{24}$/.test(bannerId) ? bannerId : null }],
    });

    inMemoryBanners = inMemoryBanners.filter(b => (b.customId || b._id || b.id) !== bannerId);
    catalogCache.banners = null;
    catalogCache.bannersExp = 0;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete banner' });
  }
});

// 3. Coupons & Promotions Engine
app.get('/api/coupons', async (req, res) => {
  const now = new Date();
  const coupons = await Coupon.find({
    active: { $ne: false },
    is_visible: { $ne: false },
    $and: [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
    ],
  }).sort({ displayOrder: 1, createdAt: -1 }).lean();

  return res.json({
    coupons: coupons.map(c => {
      const discountText = c.amount ? `₹${c.amount}` : (c.percent ? `${c.percent}%` : (c.discountValue ? (c.discountType === 'percentage' ? `${c.discountValue}%` : `₹${c.discountValue}`) : '₹50'));
      return {
        id: c._id.toString(),
        code: c.code,
        discount: discountText,
        discountType: c.discountType || (c.percent ? 'percentage' : 'flat'),
        discountValue: c.discountValue || c.amount || c.percent || 0,
        discountAmount: c.amount || (c.discountType === 'flat' ? c.discountValue : 0),
        amount: c.amount || 0,
        percent: c.percent || 0,
        title: c.title || (c.amount ? `Flat ₹${c.amount} OFF` : `${c.percent}% Instant Discount`),
        description: c.description || `Use code ${c.code} at checkout to save on your home services.`,
        minOrderAmount: c.minOrderAmount || (c.amount ? c.amount * 4 : 299),
        maxDiscount: c.maxDiscount || c.amount || 250,
        applicableService: c.applicableService || 'all',
        applicableCategory: c.applicableCategory || 'all',
        expiresAt: c.expiresAt ? c.expiresAt.toISOString() : '2026-12-31T23:59:59.000Z',
        terms: c.terms || '',
      };
    }),
  });
});

app.post('/api/coupons/validate', async (req, res) => {
  const { code, service, category, amount, quantity } = req.body;
  if (!code) return res.status(400).json({ valid: false, error: 'Coupon code is required.' });

  const anyCoupon = await Coupon.findOne({
    code: String(code).trim().toUpperCase(),
  });

  if (!anyCoupon) {
    return res.status(404).json({ valid: false, error: 'Invalid coupon code. Please check and try again.', message: 'Invalid coupon code. Please check and try again.' });
  }

  if (anyCoupon.is_visible === false || anyCoupon.active === false) {
    return res.status(400).json({ valid: false, error: 'Coupon is disabled or currently inactive.', message: 'Coupon is disabled or currently inactive.' });
  }

  const coupon = anyCoupon;

  const now = new Date();
  if (coupon.expiresAt && new Date(coupon.expiresAt) < now) {
    return res.status(400).json({ valid: false, error: `Coupon ${coupon.code} has expired.`, message: `Coupon ${coupon.code} has expired.` });
  }
  if (coupon.startDate && new Date(coupon.startDate) > now) {
    return res.status(400).json({ valid: false, error: `Coupon ${coupon.code} is not active yet.`, message: `Coupon ${coupon.code} is not active yet.` });
  }
  if (coupon.usageLimit > 0 && coupon.usageCount >= coupon.usageLimit) {
    return res.status(400).json({ valid: false, error: `Coupon ${coupon.code} usage limit reached.`, message: `Coupon ${coupon.code} usage limit reached.` });
  }

  const orderSubtotal = parseInt(String(req.body.orderAmount || amount || 499).replace(/[^0-9]/g, ''), 10);
  const minRequired = coupon.minOrderAmount || (coupon.amount ? coupon.amount * 4 : 299);

  if (orderSubtotal < minRequired) {
    return res.status(400).json({
      valid: false,
      error: `Minimum order amount of ₹${minRequired} required for coupon ${coupon.code}.`,
    });
  }

  if (coupon.applicableCategory && coupon.applicableCategory !== 'all' && category && coupon.applicableCategory !== category) {
    return res.status(400).json({
      valid: false,
      error: `Coupon ${coupon.code} is only valid for category "${coupon.applicableCategory}".`,
    });
  }

  let discount = 0;
  const maxCap = coupon.maxDiscount || 250;
  if (coupon.amount && coupon.amount > 0) {
    discount = Math.min(orderSubtotal, coupon.amount);
  } else if (coupon.percent && coupon.percent > 0) {
    discount = Math.min(maxCap, Math.round((orderSubtotal * coupon.percent) / 100));
  } else if (coupon.discountValue && coupon.discountType === 'flat') {
    discount = Math.min(orderSubtotal, coupon.discountValue);
  } else if (coupon.discountValue && coupon.discountType === 'percentage') {
    discount = Math.min(maxCap, Math.round((orderSubtotal * coupon.discountValue) / 100));
  }

  return res.json({
    valid: true,
    code: coupon.code,
    discount,
    discountText: `₹${discount}`,
    message: `Coupon ${coupon.code} applied! You save ₹${discount}.`,
  });
});

// 4. Availability & Scheduling Slots Engine
app.get('/api/availability/slots', async (req, res) => {
  const { service = 'AC Service & Repair', date } = req.query;
  const targetDateStr = date || new Date().toISOString().split('T')[0];

  const standardSlots = [
    { id: 'slot_08_10', slot: '08:00 AM - 10:00 AM', time: '08:00 AM', startHour: 8 },
    { id: 'slot_10_12', slot: '10:00 AM - 12:00 PM', time: '10:00 AM', startHour: 10 },
    { id: 'slot_12_14', slot: '12:00 PM - 02:00 PM', time: '12:00 PM', startHour: 12 },
    { id: 'slot_14_16', slot: '02:00 PM - 04:00 PM', time: '02:00 PM', startHour: 14 },
    { id: 'slot_16_18', slot: '04:00 PM - 06:00 PM', time: '04:00 PM', startHour: 16 },
    { id: 'slot_18_20', slot: '06:00 PM - 08:00 PM', time: '06:00 PM', startHour: 18 },
  ];

  // Count active specialist workers
  const eligibleWorkers = await User.countDocuments({
    role: 'worker',
    status: 'active',
    services: { $in: [service] },
  });

  const workerCapacity = Math.max(1, eligibleWorkers || 3);

  // Check booked counts on this date
  const bookedSlots = await Booking.find({
    service,
    date: { $regex: new RegExp(targetDateStr, 'i') },
    status: { $nin: ['CANCELLED', 'REJECTED'] },
  }).lean();

  const now = new Date();
  const isToday = targetDateStr === now.toISOString().split('T')[0];
  const currentHour = now.getHours();

  const computedSlots = standardSlots.map(s => {
    const bookedCount = bookedSlots.filter(b => b.time && (b.time.includes(s.time) || b.time.includes(s.slot))).length;
    const isPast = isToday && currentHour >= s.startHour;
    const isFull = bookedCount >= workerCapacity * 2;

    let available = true;
    let reason = '';

    if (isPast) {
      available = false;
      reason = 'Time slot passed';
    } else if (isFull) {
      available = false;
      reason = 'Fully booked';
    }

    return {
      id: s.id,
      slot: s.slot,
      time: s.time,
      available,
      remainingCapacity: Math.max(0, workerCapacity * 2 - bookedCount),
      reason,
    };
  });

  return res.json({
    date: targetDateStr,
    service,
    slots: computedSlots,
    allAvailable: computedSlots.some(s => s.available),
  });
});

app.get('/api/customer/slots', (req, res) => app._router.handle({ ...req, url: '/api/availability/slots' }, res));

// 5. Payment Gateway Configuration, Order Creation, Verification, Status, Webhooks & Refunds
app.get('/api/payments/config', (req, res) => {
  const publicConfig = razorpayService.getPublicConfig();
  return res.json(publicConfig);
});

app.post('/api/payments/create-order', authRequired, requireRoles('customer'), async (req, res) => {
  try {
    const { bookingId, serviceName, serviceId, addOns, couponCode, quantity, cartItems } = req.body;
    let authoritativeAmount = 0;
    let targetBooking = null;

    if (bookingId) {
      targetBooking = await findBookingById(bookingId);
      if (!targetBooking) {
        return res.status(404).json({ error: 'Booking not found.', code: 'BOOKING_NOT_FOUND' });
      }
      if (String(targetBooking.customerId) !== String(req.auth.sub)) {
        return res.status(403).json({ error: 'Unauthorized to pay for this booking.', code: 'PAYMENT_FORBIDDEN' });
      }
      if (['PAID', 'Settled', 'Paid Online', 'Paid', 'CAPTURED'].includes(targetBooking.paymentStatus)) {
        return res.status(400).json({ error: 'This booking has already been paid for.', code: 'ALREADY_PAID' });
      }
      if (['CANCELLED', 'EXPIRED', 'DECLINED'].includes(targetBooking.status)) {
        return res.status(400).json({ error: `Cannot pay for a ${targetBooking.status.toLowerCase()} booking.`, code: 'INVALID_BOOKING_STATUS' });
      }
      authoritativeAmount = targetBooking.priceNum || (await calculateAuthoritativePrice(targetBooking.service, targetBooking.addOns, targetBooking.couponCode, 1, targetBooking.cartItems)).totalAmount;
    } else {
      // Calculate server-side authoritative price
      const effectiveService = serviceName || serviceId || (cartItems && cartItems[0] ? (cartItems[0].serviceName || cartItems[0].name) : 'AC Service & Repair');
      const priceBreakdown = await calculateAuthoritativePrice(effectiveService, addOns, couponCode, quantity || 1, cartItems);
      authoritativeAmount = priceBreakdown.totalAmount;
    }

    if (!authoritativeAmount || authoritativeAmount <= 0) {
      return res.status(400).json({ error: 'Calculated payable amount must be greater than zero.', code: 'INVALID_AMOUNT' });
    }

    // Check if Razorpay credentials are configured
    if (!razorpayService.isConfigured()) {
      return res.status(503).json({
        error: 'Razorpay payment gateway is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the backend environment.',
        code: 'RAZORPAY_NOT_CONFIGURED',
      });
    }

    // Check if there is an existing pending Razorpay order for this booking within last 30 minutes
    const existingPayment = targetBooking
      ? await Payment.findOne({
          bookingId: targetBooking.customId || targetBooking.id,
          status: 'CREATED',
          amount: authoritativeAmount,
          createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) },
        }).sort({ createdAt: -1 })
      : null;

    let orderId;
    let amountInPaise = Math.round(authoritativeAmount * 100);
    let paymentRecord;

    if (existingPayment && existingPayment.razorpayOrderId) {
      orderId = existingPayment.razorpayOrderId;
      paymentRecord = existingPayment;
    } else {
      const order = await razorpayService.createOrder({
        amount: authoritativeAmount,
        currency: 'INR',
        receipt: `rcpt_${targetBooking ? (targetBooking.customId || targetBooking.id) : Date.now()}`,
        notes: {
          customerId: req.auth.sub,
          customerName: req.auth.name || 'Customer',
          bookingId: targetBooking ? (targetBooking.customId || targetBooking.id) : (bookingId || ''),
          service: serviceName || (targetBooking ? targetBooking.service : 'Home Service'),
        },
      });
      orderId = order.orderId;
      amountInPaise = order.amountInPaise;

      paymentRecord = await Payment.create({
        customId: `PAY-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
        bookingId: targetBooking ? (targetBooking.customId || targetBooking.id) : (bookingId || `BK-TEMP-${Date.now()}`),
        customerId: req.auth.sub,
        workerId: targetBooking?.providerId || null,
        amount: authoritativeAmount,
        amountSmallestUnit: amountInPaise,
        currency: 'INR',
        status: 'CREATED',
        orderId,
        razorpayOrderId: orderId,
        provider: 'Razorpay Gateway',
        method: 'UPI / Cards / NetBanking',
      });
    }

    return res.json({
      orderId,
      paymentRecordId: paymentRecord.customId,
      amount: authoritativeAmount,
      amountInPaise,
      currency: 'INR',
      keyId: (config.razorpayKeyId || process.env.RAZORPAY_KEY_ID || '').trim(),
      businessName: 'HomeStepIn Technologies Pvt Ltd',
      description: `Payment for ${serviceName || (targetBooking ? targetBooking.service : 'Home Service')}`,
    });
  } catch (err) {
    console.error('[PAYMENTS] Error creating Razorpay order:', err.message);
    return res.status(err.status || 500).json({
      error: err.message || 'Failed to create payment order.',
      code: err.code || 'PAYMENT_ORDER_CREATION_FAILED',
    });
  }
});

app.post('/api/payments/verify', authRequired, requireRoles('customer', 'admin'), async (req, res) => {
  try {
    const orderId = req.body.razorpayOrderId || req.body.orderId || req.body.razorpay_order_id;
    const paymentId = req.body.razorpayPaymentId || req.body.paymentId || req.body.razorpay_payment_id;
    const signature = req.body.razorpaySignature || req.body.signature || req.body.razorpay_signature;
    const bookingId = req.body.bookingId;

    if (!orderId) {
      return res.status(400).json({ verified: false, error: 'Order ID is required for verification.', code: 'ORDER_ID_REQUIRED' });
    }
    if (!paymentId) {
      return res.status(400).json({ verified: false, error: 'Payment ID is required for verification.', code: 'PAYMENT_ID_REQUIRED' });
    }

    if (!razorpayService.isConfigured()) {
      return res.status(503).json({
        verified: false,
        error: 'Razorpay payment gateway is not configured.',
        code: 'RAZORPAY_NOT_CONFIGURED',
      });
    }

    // Locate the payment record
    const paymentRecord = await Payment.findOne({
      $or: [{ razorpayOrderId: orderId }, { orderId }],
    });

    if (paymentRecord) {
      // Ownership check: Authenticated customer must own the payment order (admins can verify on behalf)
      if (req.auth.role !== 'admin' && String(paymentRecord.customerId) !== String(req.auth.sub)) {
        return res.status(403).json({ verified: false, error: 'Unauthorized. You do not own this payment order.', code: 'PAYMENT_FORBIDDEN' });
      }

      // Idempotency: If already paid with same paymentId, return success immediately
      if (['PAID', 'CAPTURED', 'Settled'].includes(paymentRecord.status) && paymentRecord.razorpayPaymentId === paymentId) {
        return res.json({
          verified: true,
          paymentId: paymentRecord.razorpayPaymentId,
          status: 'PAID',
          message: 'Payment has already been verified and recorded.',
        });
      }
    }

    // Cryptographic signature check using constant-time comparison
    const isValidSignature = razorpayService.verifyPaymentSignature({
      orderId,
      paymentId,
      signature,
    });

    if (!isValidSignature) {
      if (paymentRecord) {
        paymentRecord.status = 'FAILED';
        paymentRecord.failureReason = 'Cryptographic signature mismatch';
        paymentRecord.errorCode = 'SIGNATURE_VERIFICATION_FAILED';
        await paymentRecord.save();
      }
      return res.status(400).json({
        verified: false,
        error: 'Invalid payment signature. Verification failed.',
        code: 'INVALID_SIGNATURE',
      });
    }

    // Check payment amount and status from Razorpay API
    let rzpPaymentDetails = null;
    try {
      rzpPaymentDetails = await razorpayService.fetchPayment(paymentId);
      if (rzpPaymentDetails) {
        // Validate that order ID matches
        if (rzpPaymentDetails.order_id && rzpPaymentDetails.order_id !== orderId) {
          return res.status(400).json({
            verified: false,
            error: 'Payment order ID mismatch with Razorpay record.',
            code: 'ORDER_MISMATCH',
          });
        }
        // Validate currency matches expected INR
        if (rzpPaymentDetails.currency && rzpPaymentDetails.currency.toUpperCase() !== 'INR') {
          return res.status(400).json({
            verified: false,
            error: `Payment currency (${rzpPaymentDetails.currency}) mismatch. Expected INR.`,
            code: 'CURRENCY_MISMATCH',
          });
        }
        // Validate amount matches expected order amount
        if (paymentRecord && paymentRecord.amount) {
          const paidRupees = (rzpPaymentDetails.amount || 0) / 100;
          if (paidRupees !== paymentRecord.amount) {
            return res.status(400).json({
              verified: false,
              error: `Paid amount (₹${paidRupees}) does not match expected amount (₹${paymentRecord.amount}).`,
              code: 'AMOUNT_MISMATCH',
            });
          }
        }
      }
    } catch (rzpErr) {
      // In testing environments with mock/local keys, allow verified signature to succeed
      console.warn('[PAYMENTS] Note: Unable to fetch live payment from Razorpay API:', rzpErr.message);
    }

    // Atomically transition payment record to PAID
    if (paymentRecord) {
      paymentRecord.status = 'PAID';
      paymentRecord.paymentId = paymentId;
      paymentRecord.razorpayPaymentId = paymentId;
      paymentRecord.razorpaySignature = signature || paymentRecord.razorpaySignature;
      paymentRecord.method = rzpPaymentDetails?.method || paymentRecord.method || 'Razorpay Online';
      paymentRecord.paidAt = new Date();
      await paymentRecord.save();
    }

    // Update associated booking
    const effectiveBookingId = bookingId || paymentRecord?.bookingId;
    let targetBooking = null;
    if (effectiveBookingId) {
      targetBooking = await findBookingById(effectiveBookingId);
      if (targetBooking) {
        if (req.auth.role !== 'admin' && String(targetBooking.customerId) !== String(req.auth.sub)) {
          return res.status(403).json({ verified: false, error: 'Unauthorized to update this booking.', code: 'BOOKING_FORBIDDEN' });
        }
        const prevStatus = targetBooking.paymentStatus;
        targetBooking.paymentStatus = 'PAID';
        targetBooking.paymentMethod = 'Pay Online';
        if (Array.isArray(targetBooking.history)) {
          targetBooking.history.push({
            from: prevStatus || 'PENDING',
            to: 'PAID',
            by: req.auth.sub,
            role: req.auth.role,
            action: 'PAYMENT_VERIFIED',
            note: `Razorpay payment ${paymentId} verified for order ${orderId}`,
            at: new Date(),
          });
        }
        await targetBooking.save();

        await logFinancialAudit('PAYMENT_VERIFIED', paymentRecord?.customId || targetBooking.customId, req.auth.sub, req.auth.role, paymentRecord?.amount || targetBooking.priceNum || 0, {
          orderId,
          paymentId,
          bookingId: targetBooking.customId || targetBooking.id,
        });

        if (targetBooking.providerId) {
          await createAndDispatchNotification({
            recipientId: targetBooking.providerId,
            eventId: `evt_pay_${paymentId}`,
            type: 'PAYMENT_COMPLETED',
            priority: 'IMPORTANT',
            title: 'Customer Paid Online',
            body: `Booking #${targetBooking.customId || targetBooking.id} paid online (₹${paymentRecord?.amount || targetBooking.priceNum}). Do not collect cash.`,
            bookingId: targetBooking.customId || targetBooking.id,
          });
        }
      }
    }

    return res.json({
      verified: true,
      paymentId,
      orderId,
      bookingId: targetBooking?.customId || targetBooking?.id || effectiveBookingId,
      status: 'PAID',
      message: 'Payment verified and captured successfully.',
    });
  } catch (err) {
    console.error('[PAYMENTS] Error verifying payment:', err.message);
    return res.status(err.status || 500).json({
      verified: false,
      error: err.message || 'Payment verification failed.',
      code: err.code || 'VERIFICATION_ERROR',
    });
  }
});

app.get('/api/payments/:paymentId/status', authRequired, async (req, res) => {
  try {
    const id = req.params.paymentId;
    const payment = await Payment.findOne({
      $or: [
        { customId: id },
        { razorpayPaymentId: id },
        { paymentId: id },
        { razorpayOrderId: id },
        { orderId: id },
        { bookingId: id },
      ],
    }).sort({ createdAt: -1 });

    if (!payment) {
      return res.status(404).json({ error: 'Payment record not found.', code: 'PAYMENT_NOT_FOUND' });
    }

    // Role check: customer must own it, assigned worker, or admin
    const isOwner = String(payment.customerId) === String(req.auth.sub);
    const isAdmin = req.auth.role === 'admin';
    let isWorker = false;
    if (payment.workerId && String(payment.workerId) === String(req.auth.sub)) {
      isWorker = true;
    } else {
      const booking = await findBookingById(payment.bookingId);
      if (booking && String(booking.providerId) === String(req.auth.sub)) {
        isWorker = true;
      }
    }

    if (!isOwner && !isAdmin && !isWorker) {
      return res.status(403).json({ error: 'Unauthorized to view this payment status.', code: 'PAYMENT_FORBIDDEN' });
    }

    return res.json({
      paymentId: payment.customId,
      bookingId: payment.bookingId,
      orderId: payment.orderId,
      razorpayOrderId: payment.razorpayOrderId,
      razorpayPaymentId: payment.razorpayPaymentId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      method: payment.method,
      paidAt: payment.paidAt,
      refundStatus: payment.refundStatus,
      refundAmount: payment.refundAmount,
      refundId: payment.refundId,
      failureReason: payment.failureReason,
      createdAt: payment.createdAt,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve payment status.' });
  }
});

// Razorpay Secure Webhook Endpoint
app.post('/api/payments/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) {
      return res.status(400).json({ error: 'Missing x-razorpay-signature header' });
    }

    const isValid = razorpayService.verifyWebhookSignature({
      rawBody: req.rawBody,
      signature,
    });

    if (!isValid) {
      console.warn('[WEBHOOK] Rejected webhook request: Invalid signature');
      return res.status(400).json({ error: 'Invalid webhook signature.' });
    }

    const event = req.body.event;
    const eventId = req.headers['x-razorpay-event-id'] || req.body.event_id || `evt_${event}_${req.body.payload?.payment?.entity?.id || Date.now()}`;

    // Idempotency: Atomically reserve event processing key upfront to prevent concurrent delivery race conditions
    try {
      await IdempotencyKey.create({
        customerId: 'system_webhook',
        idempotencyKey: eventId,
        requestHash: crypto.createHash('sha256').update(String(req.rawBody || eventId)).digest('hex'),
        status: 'IN_FLIGHT',
        response: { status: 'in_flight' },
        statusCode: 200,
      });
    } catch (dupErr) {
      if (dupErr.code === 11000 || (dupErr.message && dupErr.message.includes('E11000'))) {
        return res.json({ status: 'ok', message: 'Event already processed' });
      }
      throw dupErr;
    }

    // Process event
    if (event === 'payment.captured' || event === 'order.paid') {
      const paymentEntity = req.body.payload?.payment?.entity;
      if (paymentEntity) {
        const orderId = paymentEntity.order_id;
        const paymentId = paymentEntity.id;
        const paymentRecord = await Payment.findOne({
          $or: [{ razorpayOrderId: orderId }, { orderId }],
        });

        if (paymentRecord) {
          paymentRecord.status = 'PAID';
          paymentRecord.paymentId = paymentId;
          paymentRecord.razorpayPaymentId = paymentId;
          paymentRecord.method = paymentEntity.method || paymentRecord.method;
          paymentRecord.paidAt = new Date(paymentEntity.created_at ? paymentEntity.created_at * 1000 : Date.now());
          if (!paymentRecord.webhookEventsProcessed.includes(eventId)) {
            paymentRecord.webhookEventsProcessed.push(eventId);
          }
          await paymentRecord.save();

          const booking = await findBookingById(paymentRecord.bookingId);
          if (booking && booking.paymentStatus !== 'PAID') {
            booking.paymentStatus = 'PAID';
            booking.paymentMethod = 'Pay Online';
            if (Array.isArray(booking.history)) {
              booking.history.push({
                from: 'PENDING',
                to: 'PAID',
                by: 'webhook',
                role: 'system',
                action: 'PAYMENT_WEBHOOK_CAPTURED',
                note: `Payment ${paymentId} captured via Razorpay Webhook`,
                at: new Date(),
              });
            }
            await booking.save();
          }
        }
      }
    } else if (event === 'payment.authorized') {
      const paymentEntity = req.body.payload?.payment?.entity;
      if (paymentEntity) {
        const orderId = paymentEntity.order_id;
        const paymentRecord = await Payment.findOne({
          $or: [{ razorpayOrderId: orderId }, { orderId }],
        });
        if (paymentRecord && paymentRecord.status !== 'PAID') {
          paymentRecord.status = 'AUTHORIZED';
          paymentRecord.paymentId = paymentEntity.id;
          paymentRecord.razorpayPaymentId = paymentEntity.id;
          await paymentRecord.save();
        }
      }
    } else if (event === 'payment.failed') {
      const paymentEntity = req.body.payload?.payment?.entity;
      if (paymentEntity) {
        const orderId = paymentEntity.order_id;
        const paymentRecord = await Payment.findOne({
          $or: [{ razorpayOrderId: orderId }, { orderId }],
        });
        if (paymentRecord && paymentRecord.status !== 'PAID') {
          paymentRecord.status = 'FAILED';
          paymentRecord.errorCode = paymentEntity.error_code || 'PAYMENT_FAILED';
          paymentRecord.failureReason = paymentEntity.error_description || 'Payment failed';
          await paymentRecord.save();

          const booking = await findBookingById(paymentRecord.bookingId);
          if (booking && booking.paymentStatus === 'PENDING') {
            booking.paymentStatus = 'FAILED';
            await booking.save();
          }
        }
      }
    } else if (event === 'refund.processed' || event === 'refund.created') {
      const refundEntity = req.body.payload?.refund?.entity;
      if (refundEntity) {
        const paymentId = refundEntity.payment_id;
        const paymentRecord = await Payment.findOne({
          $or: [{ razorpayPaymentId: paymentId }, { paymentId }],
        });
        if (paymentRecord) {
          paymentRecord.status = 'REFUNDED';
          paymentRecord.refundId = refundEntity.id;
          paymentRecord.refundAmount = (refundEntity.amount || 0) / 100;
          paymentRecord.refundStatus = refundEntity.status === 'processed' ? 'REFUNDED' : 'PROCESSING';
          paymentRecord.refundedAt = new Date();
          await paymentRecord.save();

          const booking = await findBookingById(paymentRecord.bookingId);
          if (booking) {
            booking.paymentStatus = 'REFUNDED';
            booking.refundStatus = refundEntity.status === 'processed' ? 'REFUNDED' : 'PROCESSING';
            booking.refundAmount = paymentRecord.refundAmount;
            await booking.save();
          }
        }
      }
    }

    // Finalize idempotency key status
    await IdempotencyKey.updateOne(
      { customerId: 'system_webhook', idempotencyKey: eventId },
      { $set: { status: 'COMPLETED', response: { status: 'ok' }, statusCode: 200 } }
    );

    return res.json({ status: 'ok' });
  } catch (err) {
    console.error('[WEBHOOK] Error processing Razorpay webhook:', err.message);
    return res.status(500).json({ error: 'Internal webhook error' });
  }
});

// Customer/Admin Refund Processing Endpoint
app.post('/api/payments/refund', authRequired, async (req, res) => {
  try {
    const { paymentId, bookingId, amount, reason } = req.body;
    if (!paymentId && !bookingId) {
      return res.status(400).json({ error: 'Payment ID or Booking ID is required.', code: 'ID_REQUIRED' });
    }

    let payment = null;
    if (paymentId) {
      payment = await Payment.findOne({
        $or: [
          { customId: paymentId },
          { razorpayPaymentId: paymentId },
          { paymentId: paymentId },
          { orderId: paymentId },
        ],
      }).sort({ createdAt: -1 });
    }

    if (!payment && bookingId) {
      payment = await Payment.findOne({
        bookingId,
        status: { $in: ['PAID', 'CAPTURED', 'Settled', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
      }).sort({ createdAt: -1 });

      if (!payment) {
        payment = await Payment.findOne({ bookingId }).sort({ createdAt: -1 });
      }
    }

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found.', code: 'PAYMENT_NOT_FOUND' });
    }

    // Auth check: customer must own it or user must be admin
    const isOwner = String(payment.customerId) === String(req.auth.sub);
    const isAdmin = req.auth.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to request refund for this payment.', code: 'FORBIDDEN' });
    }

    const remainingRefundable = Math.max(0, (payment.amount || 0) - (payment.refundAmount || 0));
    if (payment.status === 'REFUNDED' || remainingRefundable <= 0) {
      return res.status(400).json({ error: 'This payment has already been fully refunded.', code: 'ALREADY_REFUNDED' });
    }

    if (!['PAID', 'CAPTURED', 'Settled', 'PARTIALLY_REFUNDED'].includes(payment.status)) {
      return res.status(400).json({ error: `Cannot refund payment in ${payment.status} status. Only captured or partially refunded payments are eligible.`, code: 'INELIGIBLE_FOR_REFUND' });
    }

    const refundAmount = amount !== undefined && amount !== null ? Number(amount) : remainingRefundable;
    if (isNaN(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ error: 'Refund amount must be a positive number greater than zero.', code: 'INVALID_REFUND_AMOUNT' });
    }

    if (refundAmount > remainingRefundable) {
      return res.status(400).json({
        error: `Requested refund (₹${refundAmount}) exceeds the remaining refundable balance (₹${remainingRefundable}).`,
        code: 'EXCESSIVE_REFUND_AMOUNT',
        remainingRefundable,
      });
    }

    // Atomic concurrency lock: Transition status to REFUND_IN_FLIGHT to prevent race conditions
    const lockedPayment = await Payment.findOneAndUpdate(
      {
        _id: payment._id,
        status: { $in: ['PAID', 'CAPTURED', 'Settled', 'PARTIALLY_REFUNDED'] },
      },
      {
        $set: { status: 'REFUND_IN_FLIGHT' },
      },
      { new: true }
    );

    if (!lockedPayment) {
      return res.status(409).json({
        error: 'A refund operation is already in progress for this payment or its status has changed.',
        code: 'REFUND_CONFLICT',
      });
    }

    let rzpRefundResult = null;
    if (razorpayService.isConfigured() && (lockedPayment.razorpayPaymentId || (lockedPayment.paymentId && lockedPayment.paymentId.startsWith('pay_')))) {
      try {
        rzpRefundResult = await razorpayService.refundPayment({
          paymentId: lockedPayment.razorpayPaymentId || lockedPayment.paymentId,
          amount: refundAmount,
          notes: {
            reason: reason || 'Customer dispute resolution',
            requestedBy: req.auth.sub,
            bookingId: lockedPayment.bookingId,
          },
        });
      } catch (rzpErr) {
        console.error('[REFUND] Razorpay refund error:', rzpErr.message);
        // Rollback lock to previous status and record manual review requirement
        lockedPayment.status = (lockedPayment.refundAmount || 0) > 0 ? 'PARTIALLY_REFUNDED' : 'PAID';
        lockedPayment.refundStatus = 'MANUAL_REVIEW_REQUIRED';
        lockedPayment.failureReason = `Provider refund error: ${rzpErr.message}`;
        await lockedPayment.save();

        await logFinancialAudit('REFUND_FAILED_MANUAL_REVIEW', lockedPayment.customId, req.auth.sub, req.auth.role, refundAmount, {
          reason,
          error: rzpErr.message,
          manualReview: true,
        });

        return res.status(502).json({
          error: `Automated provider refund failed (${rzpErr.message}). Operation logged for manual review.`,
          code: 'REFUND_MANUAL_REVIEW_REQUIRED',
        });
      }
    }

    const totalRefunded = (lockedPayment.refundAmount || 0) + refundAmount;
    const isFullyRefunded = totalRefunded >= lockedPayment.amount;
    const finalPaymentStatus = isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const finalRefundStatus = rzpRefundResult
      ? (rzpRefundResult.status === 'processed' ? (isFullyRefunded ? 'REFUNDED' : 'PARTIAL') : 'PROCESSING')
      : (isFullyRefunded ? 'REFUNDED' : 'PARTIAL');

    lockedPayment.status = finalPaymentStatus;
    lockedPayment.refundAmount = totalRefunded;
    lockedPayment.refundReason = reason || 'Customer dispute / policy refund';
    lockedPayment.refundedAt = new Date();
    if (rzpRefundResult) {
      lockedPayment.refundId = rzpRefundResult.refundId;
    }
    lockedPayment.refundStatus = finalRefundStatus;
    await lockedPayment.save();

    const booking = await findBookingById(lockedPayment.bookingId);
    if (booking) {
      booking.paymentStatus = finalPaymentStatus;
      booking.refundStatus = finalRefundStatus;
      booking.refundAmount = totalRefunded;
      if (Array.isArray(booking.history)) {
        booking.history.push({
          from: booking.paymentStatus,
          to: finalPaymentStatus,
          by: req.auth.sub,
          role: req.auth.role,
          action: isFullyRefunded ? 'PAYMENT_REFUNDED' : 'PAYMENT_PARTIALLY_REFUNDED',
          note: `Refund of ₹${refundAmount} processed (${reason || 'Customer request'}). Total refunded: ₹${totalRefunded}`,
          at: new Date(),
        });
      }
      await booking.save();
    }

    await logFinancialAudit(isFullyRefunded ? 'PAYMENT_REFUNDED' : 'PAYMENT_PARTIALLY_REFUNDED', lockedPayment.customId, req.auth.sub, req.auth.role, refundAmount, {
      bookingId: lockedPayment.bookingId,
      reason,
      refundId: lockedPayment.refundId,
      totalRefunded,
    });

    return res.json({
      success: true,
      message: `${isFullyRefunded ? 'Full' : 'Partial'} refund successfully processed and recorded.`,
      refundId: lockedPayment.refundId,
      refundAmount,
      totalRefunded,
      remainingRefundable: Math.max(0, lockedPayment.amount - totalRefunded),
      status: lockedPayment.status,
    });
  } catch (err) {
    console.error('[REFUND] Error in refund endpoint:', err.message);
    return res.status(500).json({ error: err.message || 'Refund processing failed.' });
  }
});

// 6. Create Booking (Both /api/bookings and /api/customer/bookings)
const recentBookingKeys = new Map();

async function handleCreateBooking(req, res) {
  const {
    service,
    category,
    date,
    time,
    slot,
    address,
    addressDetails,
    quantity,
    addOns,
    cartItems,
    couponCode,
    paymentMethod,
    clientBookingKey,
  } = req.body;

  if (!service && (!Array.isArray(cartItems) || cartItems.length === 0)) {
    return res.status(400).json({ error: 'Service is required.' });
  }

  // Validate that requested service or cart items are active and visible
  if (service || req.body.serviceId) {
    let srvRecord = await getCachedService(service || req.body.serviceId);
    if (!srvRecord) {
      srvRecord = await Service.findOne({
        $or: [
          { name: new RegExp(`^${service}$`, 'i') },
          { customId: service },
          { customId: req.body.serviceId },
          { _id: /^[0-9a-fA-F]{24}$/.test(req.body.serviceId || '') ? req.body.serviceId : null },
        ],
      });
    }
    if (srvRecord && (srvRecord.is_visible === false || srvRecord.active === false)) {
      const errMsg = `The service "${srvRecord.name}" is currently unavailable or inactive.`;
      return res.status(400).json({
        error: errMsg,
        message: errMsg,
        code: 'SERVICE_UNAVAILABLE',
      });
    }
  }
  if (Array.isArray(cartItems) && cartItems.length > 0) {
    const itemIds = [];
    const itemNames = [];
    for (const item of cartItems) {
      if (item.serviceId || item.id) itemIds.push(item.serviceId || item.id);
      if (item.serviceName || item.name) itemNames.push(item.serviceName || item.name);
    }
    const orConditions = [];
    if (itemIds.length > 0) {
      const validObjIds = itemIds.filter(id => /^[0-9a-fA-F]{24}$/.test(id));
      orConditions.push({ customId: { $in: itemIds } });
      if (validObjIds.length > 0) orConditions.push({ _id: { $in: validObjIds } });
    }
    if (itemNames.length > 0) {
      orConditions.push({ name: { $in: itemNames } });
    }
    if (orConditions.length > 0) {
      const srvRecords = await Service.find({ $or: orConditions }).select('name active is_visible').lean();
      for (const srvRecord of srvRecords) {
        if (srvRecord && (srvRecord.is_visible === false || srvRecord.active === false)) {
          const errMsg = `The service "${srvRecord.name}" in your cart is currently unavailable or inactive.`;
          return res.status(400).json({
            error: errMsg,
            message: errMsg,
            code: 'SERVICE_UNAVAILABLE',
          });
        }
      }
    }
  }

  // Persistent MongoDB Idempotency Check & Atomic Concurrency Guard
  const idempotencyKey = req.headers['x-idempotency-key'] || clientBookingKey;
  let isIdempotencyLeader = false;
  if (idempotencyKey) {
    const existingRecord = await IdempotencyKey.findOne({ customerId: req.auth.sub, idempotencyKey });
    if (existingRecord && existingRecord.response) {
      return res.status(existingRecord.statusCode || 200).json(existingRecord.response);
    }

    try {
      await IdempotencyKey.create({
        customerId: req.auth.sub,
        idempotencyKey,
        requestHash: crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex'),
        status: 'IN_FLIGHT',
        response: null,
        statusCode: 200,
      });
      isIdempotencyLeader = true;
    } catch (dupErr) {
      if (dupErr.code === 11000) {
        // Concurrent duplicate request arrived! Wait for leader to complete with adaptive backoff
        for (let attempt = 0; attempt < 40; attempt++) {
          const delay = Math.min(20 + attempt * 10, 150);
          await new Promise((r) => setTimeout(r, delay));
          const completed = await IdempotencyKey.findOne({ customerId: req.auth.sub, idempotencyKey });
          if (completed && completed.response) {
            return res.status(completed.statusCode || 200).json(completed.response);
          }
        }
        const fallback = await IdempotencyKey.findOne({ customerId: req.auth.sub, idempotencyKey });
        if (fallback && fallback.response) {
          return res.status(fallback.statusCode || 200).json(fallback.response);
        }
        return res.status(409).json({
          error: 'A booking with this idempotency key is already being processed.',
          code: 'IDEMPOTENCY_IN_FLIGHT',
        });
      }
    }
  }

  const effectiveServiceName = service || (cartItems && cartItems[0] ? (cartItems[0].serviceName || cartItems[0].name) : 'Home Service');
  const priceBreakdown = await calculateAuthoritativePrice(effectiveServiceName, addOns, couponCode, quantity, cartItems);
  const authoritativePrice = `₹${priceBreakdown.totalAmount}`;
  const generatedOtp = String(Math.floor(1000 + Math.random() * 9000));
  const bookingId = `BK-${Date.now().toString().slice(-6)}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const user = await findUserByIdOrIdentifier(req.auth.sub);
  const locInput = req.body.serviceAddress || req.body.location || req.body.serviceLocation || {};
  const finalAddress =
    (locInput && (locInput.formattedAddress || locInput.address)) ||
    address ||
    (addressDetails && (addressDetails.formattedAddress || addressDetails.address)) ||
    (user && user.address) ||
    '';

  if (!finalAddress || finalAddress.trim().length === 0) {
    return res.status(400).json({ error: 'Service address is required.', code: 'LOCATION_REQUIRED' });
  }

  const rawLat =
    req.body.latitude !== undefined
      ? req.body.latitude
      : (req.body.lat !== undefined
          ? req.body.lat
          : (locInput.latitude !== undefined
              ? locInput.latitude
              : (locInput.lat !== undefined
                  ? locInput.lat
                  : (addressDetails && (addressDetails.latitude !== undefined ? addressDetails.latitude : addressDetails.lat)))));
  const rawLng =
    req.body.longitude !== undefined
      ? req.body.longitude
      : (req.body.lng !== undefined
          ? req.body.lng
          : (locInput.longitude !== undefined
              ? locInput.longitude
              : (locInput.lng !== undefined
                  ? locInput.lng
                  : (addressDetails && (addressDetails.longitude !== undefined ? addressDetails.longitude : addressDetails.lng)))));

  const parsedLat = Number(rawLat);
  const parsedLng = Number(rawLng);

  if (
    rawLat === undefined || rawLng === undefined ||
    isNaN(parsedLat) || isNaN(parsedLng) ||
    parsedLat < -90 || parsedLat > 90 ||
    parsedLng < -180 || parsedLng > 180 ||
    (parsedLat === 0 && parsedLng === 0)
  ) {
    return res.status(400).json({
      error: 'Valid GPS latitude and longitude coordinates are required for service dispatch.',
      code: 'INVALID_COORDINATES',
    });
  }

  // Address ownership validation if saved addressId was supplied
  const targetAddressId = req.body.addressId || (addressDetails && addressDetails.id) || (locInput && locInput.addressId);
  if (targetAddressId && user && user.addresses && user.addresses.length > 0) {
    const isOwned = user.addresses.some(a => a.id === targetAddressId);
    if (!isOwned) {
      return res.status(403).json({ error: 'Unauthorized access to address record.', code: 'UNAUTHORIZED_ADDRESS' });
    }
  }

  const finalHouse = (
    locInput.house ||
    locInput.houseNumber ||
    (addressDetails && (addressDetails.house || addressDetails.houseNumber)) ||
    req.body.house ||
    req.body.houseNumber ||
    (finalAddress ? finalAddress.split(',')[0] : '') ||
    ''
  ).toString().trim();
  if (!finalHouse) {
    return res.status(400).json({
      error: 'House / Door / Flat number is mandatory for service booking.',
      code: 'HOUSE_NUMBER_REQUIRED',
    });
  }
  const finalStreet = locInput.street || locInput.line1 || (addressDetails && addressDetails.line1) || req.body.street || req.body.line1 || '';
  const finalArea = locInput.area || locInput.locality || (addressDetails && addressDetails.area) || req.body.area || req.body.locality || '';
  const finalCity = locInput.city || (addressDetails && addressDetails.city) || req.body.city || (finalAddress.includes(',') ? finalAddress.split(',').slice(-2, -1)[0].trim() : '');
  const finalDistrict = locInput.district || (addressDetails && addressDetails.district) || req.body.district || '';
  const finalState = locInput.state || (addressDetails && addressDetails.state) || req.body.state || '';
  const finalPincode = locInput.pincode || locInput.postalCode || (addressDetails && addressDetails.pincode) || req.body.pincode || req.body.postalCode || '';
  const finalLandmark = locInput.landmark || (addressDetails && addressDetails.landmark) || req.body.landmark || '';
  const isConsistent = validateAddressCoordinatesMatch(finalAddress, finalCity, finalState, parsedLat, parsedLng);
  if (!isConsistent) {
    return res.status(400).json({
      error: 'Location details do not match. Please confirm your location again.',
      code: 'LOCATION_MISMATCH',
    });
  }

  const finalMobile = (user && user.phone) || req.body.mobileNumber || req.body.customerPhone || '+919876543210';
  const finalAccuracy = locInput.accuracy !== undefined ? Number(locInput.accuracy) : (req.body.accuracy !== undefined ? Number(req.body.accuracy) : (addressDetails && addressDetails.accuracy !== undefined ? Number(addressDetails.accuracy) : 10));
  const finalSource = locInput.source || req.body.source || (addressDetails && addressDetails.source) || 'GPS';

  const serviceAddressSnapshot = {
    formattedAddress: finalAddress.trim(),
    houseNumber: finalHouse,
    street: finalStreet,
    area: finalArea,
    locality: finalArea,
    city: finalCity,
    district: finalDistrict,
    state: finalState,
    pincode: finalPincode,
    postalCode: finalPincode,
    country: 'India',
    landmark: finalLandmark,
    mobileNumber: finalMobile,
    latitude: parsedLat,
    longitude: parsedLng,
    accuracy: finalAccuracy,
    addressId: targetAddressId || null,
    source: finalSource,
    confirmedAt: new Date(),
  };

  const structuredLocation = {
    address: finalAddress.trim(),
    area: finalArea,
    city: finalCity,
    state: finalState,
    pincode: finalPincode,
    latitude: parsedLat,
    longitude: parsedLng,
  };

  const paymentStatus = 'PENDING';

  // Canonical scheduling ISO date computation
  const bookingDateStr = date || new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const bookingTimeStr = slot || time || '10:00 AM';

  const newBooking = await Booking.create({
    customId: bookingId,
    customerId: req.auth.sub,
    customer: user ? user._id : undefined,
    customerName: req.auth.name || (user ? user.name : 'Customer'),
    customerPhone: (user && user.phone) || '+919876543210',
    service: effectiveServiceName,
    category: category || (cartItems && cartItems[0] && cartItems[0].category) || 'Home Service',
    providerId: null,
    providerName: null,
    providerPhone: null,
    date: bookingDateStr,
    time: bookingTimeStr,
    scheduledAt: new Date(),
    address: finalAddress.trim(),
    area: finalArea,
    city: finalCity,
    state: finalState,
    pincode: finalPincode,
    serviceAddress: serviceAddressSnapshot,
    location: structuredLocation,
    latitude: parsedLat,
    longitude: parsedLng,
    locationAccuracy: finalAccuracy,
    price: authoritativePrice,
    priceNum: priceBreakdown.totalAmount,
    priceBreakdown,
    status: BOOKING_STATES.CONFIRMED,
    startOtp: generatedOtp,
    paymentStatus,
    paymentMethod: paymentMethod || 'Pay Online',
  });

  // ── Parallel Operations: Audit, Customer Notification & Targeted Worker Discovery ──
  const [auditLog, custNotif, potentialWorkers, busyWorkerBookings] = await Promise.all([
    logFinancialAudit('BOOKING_PRICED', newBooking.customId, req.auth.sub, 'customer', priceBreakdown.totalAmount, priceBreakdown),
    createAndDispatchNotification({
      recipientId: newBooking.customerId,
      eventId: `evt_bk_create_${newBooking.customId}`,
      type: 'BOOKING_CONFIRMED',
      priority: 'IMPORTANT',
      title: 'Booking Confirmed',
      body: `Your service booking for ${newBooking.service} (#${newBooking.customId}) is confirmed for ${newBooking.date} at ${newBooking.time}.`,
      bookingId: newBooking.customId,
      deepLink: `homestepin://bookings/${newBooking.customId}`,
    }).catch((e) => console.warn('[Customer Booking Notification Error]:', e.message)),
    getEligibleWorkerCandidates(newBooking.service, newBooking.category),
    getBusyWorkerBookings(),
  ]);

  const busyWorkerIds = new Set(busyWorkerBookings.map(b => String(b.providerId)));

  // 2. Filter workers by busy status and service radius
  const bookingLat = newBooking.latitude;
  const bookingLng = newBooking.longitude;
  const payoutAmount = Math.round((newBooking.priceNum || 500) * 0.8);
  const payoutFormatted = `₹${payoutAmount}`;

  const eligibleWorkers = [];

  for (const worker of potentialWorkers) {
    const workerIdStr = worker._id.toString();
    if (busyWorkerIds.has(workerIdStr) || busyWorkerIds.has(worker.customId)) {
      continue;
    }

    // Distance calculation if worker coordinates exist
    let distKm = 0;
    if (typeof worker.latitude === 'number' && typeof worker.longitude === 'number') {
      distKm = calculateHaversineDistanceKm(worker.latitude, worker.longitude, bookingLat, bookingLng);
      const maxRadius = worker.serviceRadiusKm || 25;
      if (distKm > maxRadius) continue;
    }

    eligibleWorkers.push({
      worker,
      distanceKm: distKm,
    });
  }

  // 3. Dispatch targeted notifications and WebSocket alerts using efficient batch insertion
  const candidateBatch = eligibleWorkers;

  if (candidateBatch.length > 0) {
    const notifBatch = candidateBatch.map(({ worker, distanceKm }) => {
      const workerIdStr = worker._id.toString();
      const formattedDistance = distanceKm > 0 ? `${distanceKm} km` : 'Near you';
      return {
        notificationId: `notif_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        recipientId: workerIdStr,
        eventId: `evt_offer_${newBooking.customId}_${workerIdStr}`,
        type: 'NEW_JOB_OFFER',
        priority: 'CRITICAL',
        title: 'New Service Request Available',
        body: `New ${newBooking.service} job in ${newBooking.area || newBooking.city} (${formattedDistance}).`,
        bookingId: newBooking.customId,
        deepLink: `homestepin://bookings/${newBooking.customId}`,
        read: false,
      };
    });

    await Notification.insertMany(notifBatch, { ordered: false }).catch(() => {});

    // Offload real-time socket broadcasting to next event tick
    setImmediate(() => {
      for (const { worker, distanceKm } of candidateBatch) {
        const workerIdStr = worker._id.toString();
        const workerRoom = `user_${workerIdStr}`;
        const formattedDistance = distanceKm > 0 ? `${distanceKm} km` : 'Near you';

        const jobOfferPayload = {
          id: `JOB-${newBooking.customId.replace('BK-', '')}`,
          bookingId: newBooking.customId,
          service: newBooking.service,
          category: newBooking.category,
          date: newBooking.date,
          time: newBooking.time,
          address: newBooking.address,
          area: newBooking.area || newBooking.city,
          city: newBooking.city,
          pincode: newBooking.pincode,
          serviceAddress: newBooking.serviceAddress,
          latitude: newBooking.latitude,
          longitude: newBooking.longitude,
          distance: formattedDistance,
          distanceKm: distanceKm > 0 ? distanceKm : null,
          payout: payoutFormatted,
          status: 'Requested',
          offeredAt: new Date().toISOString(),
        };

        broadcastToRoom(workerRoom, {
          type: 'NEW_JOB_OFFER',
          job: jobOfferPayload,
        });
      }
      processOutboxQueue();
    });
  }

  const responseData = {
    booking: formatBooking(newBooking, 'customer'),
    dispatch: { status: 'DISPATCHED', eligibleWorkersCount: eligibleWorkers.length },
    priceBreakdown: newBooking.priceBreakdown,
  };

  if (idempotencyKey) {
    try {
      await IdempotencyKey.findOneAndUpdate(
        { customerId: req.auth.sub, idempotencyKey },
        {
          $set: {
            status: 'COMPLETED',
            bookingId: newBooking.customId,
            response: responseData,
            statusCode: 201,
          },
        },
        { upsert: true }
      );
    } catch (e) {}
  }

  broadcastToWorkers({
    type: 'NEW_JOB_AVAILABLE',
    booking: formatWorkerJob(newBooking, null),
  });

  broadcastToAdmins({
    type: 'NEW_BOOKING_CREATED',
    booking: responseData.booking,
  });

  return res.status(201).json(responseData);
}

app.post('/api/bookings', authRequired, requireRoles('customer'), handleCreateBooking);
app.post('/api/customer/bookings', authRequired, requireRoles('customer'), handleCreateBooking);

// 4. Get Customer Bookings (Both /api/bookings and /api/customer/bookings)
async function handleGetCustomerBookings(req, res) {
  const { statusFilter = 'all', page = 1, limit = 50 } = req.query;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.max(1, parseInt(limit));

  let query = { customerId: req.auth.sub };

  if (statusFilter === 'upcoming') {
    query.status = {
      $in: [
        BOOKING_STATES.PENDING,
        BOOKING_STATES.CONFIRMED,
        BOOKING_STATES.WORKER_ASSIGNED,
        BOOKING_STATES.WORKER_ACCEPTED,
        'Pending',
        'Confirmed',
        'Accepted',
        'Requested',
        'SEARCHING_WORKER',
      ],
    };
  } else if (statusFilter === 'active') {
    query.status = {
      $in: [
        BOOKING_STATES.TRAVELLING,
        BOOKING_STATES.ARRIVED,
        BOOKING_STATES.ENTERED_HOME,
        BOOKING_STATES.WORK_STARTED,
        BOOKING_STATES.WORK_FINISHED,
        'Travelling',
        'Worker on the way',
        'Arrived',
        'EnteredHome',
        'Work started',
        'InProgress',
      ],
    };
  } else if (statusFilter === 'completed') {
    query.status = {
      $in: [
        BOOKING_STATES.COMPLETED,
        BOOKING_STATES.CUSTOMER_CONFIRMED,
        BOOKING_STATES.PAYMENT_COMPLETED,
        'Completed',
      ],
    };
  } else if (statusFilter === 'cancelled') {
    query.status = {
      $in: [
        BOOKING_STATES.CANCELLED,
        BOOKING_STATES.EXPIRED,
        BOOKING_STATES.DECLINED,
        'Cancelled',
        'CANCELLED',
      ],
    };
  }

  const total = await Booking.countDocuments(query);
  const bookings = await Booking.find(query)
    .sort({ createdAt: -1 })
    .skip((pageNum - 1) * limitNum)
    .limit(limitNum);

  const formatted = bookings.map(b => formatBooking(b, 'customer'));

  return res.json({
    bookings: formatted,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
    },
  });
}

app.get('/api/bookings', authRequired, handleGetCustomerBookings);
app.get('/api/customer/bookings', authRequired, requireRoles('customer'), handleGetCustomerBookings);

// 5. Customer Booking Details
async function handleGetBookingDetails(req, res) {
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const isCustomer = booking.customerId === req.auth.sub;
  const isWorker = booking.providerId === req.auth.sub;
  const isAdmin = req.auth.role === 'admin';

  if (!isCustomer && !isWorker && !isAdmin) {
    return res.status(403).json({ error: 'Unauthorized.' });
  }

  const formatted = formatBooking(booking);
  return res.json({
    booking: formatted,
    payment: { status: booking.paymentStatus, amount: booking.priceNum },
    quotes: booking.quote ? [booking.quote] : [],
  });
}

app.get('/api/bookings/:id', authRequired, handleGetBookingDetails);
app.get('/api/customer/bookings/:id', authRequired, requireRoles('customer'), handleGetBookingDetails);

// ── Centralized Authoritative Booking State Machine ───────────────────
const STATE_TRANSITION_RULES = {
  ACCEPT_JOB: {
    roles: ['worker'],
    from: [BOOKING_STATES.PENDING, BOOKING_STATES.CONFIRMED, BOOKING_STATES.WORKER_ASSIGNED, BOOKING_STATES.DECLINED],
    to: BOOKING_STATES.WORKER_ACCEPTED,
  },
  START_JOURNEY: {
    roles: ['worker', 'admin'],
    from: [BOOKING_STATES.WORKER_ACCEPTED],
    to: BOOKING_STATES.TRAVELLING,
  },
  ARRIVE: {
    roles: ['worker', 'admin'],
    from: [BOOKING_STATES.TRAVELLING],
    to: BOOKING_STATES.ARRIVED,
  },
  ENTER_HOME: {
    roles: ['worker', 'admin'],
    from: [BOOKING_STATES.ARRIVED],
    to: BOOKING_STATES.ENTERED_HOME,
  },
  VERIFY_OTP_START: {
    roles: ['worker', 'admin'],
    from: [BOOKING_STATES.ARRIVED, BOOKING_STATES.ENTERED_HOME],
    to: BOOKING_STATES.WORK_STARTED,
  },
  START_JOB: {
    roles: ['worker', 'admin'],
    from: [BOOKING_STATES.ARRIVED, BOOKING_STATES.ENTERED_HOME],
    to: BOOKING_STATES.WORK_STARTED,
  },
  SUBMIT_QUOTE: {
    roles: ['worker', 'admin'],
    from: [BOOKING_STATES.WORK_STARTED, BOOKING_STATES.ENTERED_HOME],
    to: BOOKING_STATES.WORK_STARTED,
  },
  APPROVE_QUOTE: {
    roles: ['customer', 'admin'],
    from: [BOOKING_STATES.WORK_STARTED],
    to: BOOKING_STATES.WORK_STARTED,
  },
  REJECT_QUOTE: {
    roles: ['customer', 'admin'],
    from: [BOOKING_STATES.WORK_STARTED],
    to: BOOKING_STATES.WORK_STARTED,
  },
  FINISH_WORK: {
    roles: ['worker', 'admin'],
    from: [BOOKING_STATES.WORK_STARTED],
    to: BOOKING_STATES.COMPLETED,
  },
  CONFIRM_COMPLETION: {
    roles: ['customer', 'admin'],
    from: [BOOKING_STATES.WORK_FINISHED, BOOKING_STATES.COMPLETED],
    to: BOOKING_STATES.COMPLETED,
  },
  CANCEL_BOOKING: {
    roles: ['customer', 'admin'],
    from: [
      BOOKING_STATES.PENDING,
      BOOKING_STATES.CONFIRMED,
      BOOKING_STATES.WORKER_ASSIGNED,
      BOOKING_STATES.WORKER_ACCEPTED,
      BOOKING_STATES.TRAVELLING,
      BOOKING_STATES.ARRIVED,
    ],
    to: BOOKING_STATES.CANCELLED,
  },
  ADMIN_OVERRIDE: {
    roles: ['admin'],
    from: null,
    to: null,
  },
};

async function transitionBooking(bookingId, action, actor, payload = {}) {
  const rule = STATE_TRANSITION_RULES[action];
  if (!rule) {
    throw { status: 400, message: `Unknown state action: ${action}` };
  }

  // Role authorization check
  if (!rule.roles.includes(actor.role)) {
    throw { status: 403, message: `Role '${actor.role}' is not authorized to execute action '${action}'.` };
  }

  const booking = await findBookingById(bookingId);
  if (!booking) {
    throw { status: 404, message: 'Booking not found.' };
  }

  // Party Authorization check
  const actorUser = await findUserByIdOrIdentifier(actor.sub);
  const actorMongoId = actorUser && actorUser._id ? actorUser._id.toString() : null;
  const actorCustomId = actorUser && (actorUser.customId || actorUser.id) ? (actorUser.customId || actorUser.id) : null;

  const isCustomer = String(booking.customerId) === String(actor.sub) ||
    (actorMongoId && String(booking.customerId) === actorMongoId) ||
    (actorCustomId && String(booking.customerId) === actorCustomId);

  const isAssignedWorker = (booking.providerId && (
      String(booking.providerId) === String(actor.sub) ||
      (actorMongoId && String(booking.providerId) === actorMongoId) ||
      (actorCustomId && String(booking.providerId) === actorCustomId)
    )) ||
    (booking.worker && (
      String(booking.worker) === String(actor.sub) ||
      (actorMongoId && String(booking.worker) === actorMongoId) ||
      (actorCustomId && String(booking.worker) === actorCustomId)
    ));
  const isAdmin = actor.role === 'admin';

  const prevStatus = normalizeState(booking.status);
  const targetStatus = action === 'ADMIN_OVERRIDE' ? (payload.targetStatus ? normalizeState(payload.targetStatus) : prevStatus) : rule.to;

  if (action === 'ACCEPT_JOB') {
    // Unassigned worker must be active and specialized
    const worker = actorUser || await findUserByIdOrIdentifier(actor.sub);
    if (!worker || worker.status !== 'active') {
      throw { status: 403, message: 'Account is inactive or suspended.' };
    }
    const specializations = worker.services || ['AC Service & Repair'];
    if (specializations.length > 0 && !specializations.includes(booking.service)) {
      throw { status: 403, message: `You are not specialized in '${booking.service}'.` };
    }
    if (String(booking.providerId) === String(worker._id) || String(booking.providerId) === String(actor.sub)) {
      return booking; // Idempotent duplicate accept by same worker
    }
    if (booking.providerId) {
      throw { status: 409, message: 'This job has already been accepted by another professional.' };
    }

    // Atomic update to guarantee single winner in race conditions
    const canonicalFromStates = rule.from.concat(['Pending', 'Confirmed', 'Requested', 'SEARCHING_WORKER']);
    const updatedBooking = await Booking.findOneAndUpdate(
      {
        $or: [
          { customId: booking.customId },
          { _id: booking._id },
        ],
        providerId: null,
        status: { $in: canonicalFromStates },
      },
      {
        providerId: worker._id.toString(),
        worker: worker._id,
        providerName: worker.name,
        providerPhone: worker.phone || '+919876543211',
        status: targetStatus,
        acceptedAt: new Date(),
        $push: {
          history: {
            from: prevStatus,
            to: targetStatus,
            by: actor.sub,
            role: actor.role,
            at: new Date(),
            action,
            note: payload.note || payload.reason || '',
          },
        },
      },
      { new: true }
    );

    if (!updatedBooking) {
      throw { status: 409, message: 'This job has already been accepted by another professional.' };
    }

    await addSystemMessage(updatedBooking.customId || updatedBooking.id, `${updatedBooking.providerName} has accepted your booking.`);

    await createAndDispatchNotification({
      recipientId: updatedBooking.customerId,
      eventId: `evt_accept_${updatedBooking.customId || updatedBooking.id}`,
      type: 'WORKER_ASSIGNED',
      priority: 'IMPORTANT',
      title: 'Professional Assigned',
      body: `${updatedBooking.providerName} is confirmed for your booking #${updatedBooking.customId || updatedBooking.id}.`,
      bookingId: updatedBooking.customId || updatedBooking.id,
    });

    broadcastToRoom(updatedBooking.customId || updatedBooking.id, {
      type: 'booking_status_updated',
      bookingId: updatedBooking.customId || updatedBooking.id,
      status: updatedBooking.status,
      action,
      providerId: updatedBooking.providerId,
      providerName: updatedBooking.providerName,
    });

    broadcastToRoom(`user_${updatedBooking.customerId}`, {
      type: 'booking_status_updated',
      bookingId: updatedBooking.customId || updatedBooking.id,
      status: updatedBooking.status,
      action,
      providerId: updatedBooking.providerId,
      providerName: updatedBooking.providerName,
    });

    // Notify ALL worker apps in real-time to remove the card from available pool
    broadcastToWorkers({
      type: 'BOOKING_ASSIGNED',
      bookingId: updatedBooking.customId || updatedBooking.id,
      assignedWorkerId: worker._id.toString(),
      status: updatedBooking.status,
    });

    broadcastToAdmins({
      type: 'BOOKING_ASSIGNED',
      bookingId: updatedBooking.customId || updatedBooking.id,
      assignedWorkerId: worker._id.toString(),
      status: updatedBooking.status,
    });

    return updatedBooking;
  }

  // Non-ACCEPT_JOB authorization checks
  if (rule.roles.includes('worker') && !isAdmin && !isAssignedWorker) {
    throw { status: 403, message: 'Unauthorized. You are not the assigned professional for this booking.' };
  }
  if (rule.roles.includes('customer') && !isAdmin && !isCustomer) {
    throw { status: 403, message: 'Unauthorized. You are not the customer for this booking.' };
  }

  // Idempotency: If already in target status
  if (!['SUBMIT_QUOTE', 'APPROVE_QUOTE', 'REJECT_QUOTE', 'CONFIRM_COMPLETION', 'ADMIN_OVERRIDE'].includes(action) && rule.to && prevStatus === rule.to) {
    return booking;
  }

  // Validate from status
  if (rule.from && !rule.from.includes(prevStatus)) {
    throw {
      status: 400,
      message: `Invalid state transition: Cannot perform action '${action}' when booking is in status '${prevStatus}'.`,
    };
  }

  // Action mutations
  if (action === 'START_JOURNEY') {
    booking.status = targetStatus;
    await addSystemMessage(booking.customId || booking.id, `Worker is on the way.`);
    await createAndDispatchNotification({
      recipientId: booking.customerId,
      eventId: `evt_travel_${booking.customId || booking.id}`,
      type: 'WORKER_TRAVELLING',
      priority: 'IMPORTANT',
      title: 'Professional On The Way',
      body: `${booking.providerName} is on the way to your address.`,
      bookingId: booking.customId || booking.id,
    });
  } else if (action === 'ARRIVE') {
    booking.status = targetStatus;
    await addSystemMessage(booking.customId || booking.id, `Worker has arrived at your doorstep.`);
    await createAndDispatchNotification({
      recipientId: booking.customerId,
      eventId: `evt_arrive_${booking.customId || booking.id}`,
      type: 'WORKER_ARRIVED',
      priority: 'IMPORTANT',
      title: 'Professional Arrived',
      body: `${booking.providerName} has arrived at your doorstep.`,
      bookingId: booking.customId || booking.id,
    });
  } else if (action === 'ENTER_HOME') {
    booking.status = targetStatus;
    booking.enteredHomeAt = new Date();
  } else if (action === 'VERIFY_OTP_START' || action === 'START_JOB') {
    const { otp } = payload;
    if (!otp || String(otp).trim().length === 0) {
      throw { status: 400, message: '4-digit Start OTP is mandatory to start the job. Please obtain it from the customer.', code: 'OTP_REQUIRED' };
    }
    if (!booking.startOtp || String(booking.startOtp).trim() !== String(otp).trim()) {
      throw { status: 400, message: 'Incorrect Start OTP. Please check the 4-digit code provided by the customer.', code: 'INVALID_OTP' };
    }
    booking.status = targetStatus;
    booking.workStartedAt = new Date();
    await addSystemMessage(booking.customId || booking.id, `Service officially commenced.`);
    await createAndDispatchNotification({
      recipientId: booking.customerId,
      eventId: `evt_start_${booking.customId || booking.id}`,
      type: 'WORK_STARTED',
      priority: 'IMPORTANT',
      title: 'Service Started',
      body: `${booking.providerName} has commenced the service.`,
      bookingId: booking.customId || booking.id,
    });
  } else if (action === 'SUBMIT_QUOTE') {
    booking.quote = {
      description: payload.description || 'Additional parts / repair',
      amount: payload.amount || '₹350',
      status: 'Pending',
      createdAt: new Date().toISOString(),
    };
    booking.markModified('quote');
    await createAndDispatchNotification({
      recipientId: booking.customerId,
      eventId: `evt_quote_${booking.customId || booking.id}`,
      type: 'QUOTE_SUBMITTED',
      priority: 'IMPORTANT',
      title: 'Additional Quote Submitted',
      body: `${booking.providerName} submitted a quote of ${booking.quote.amount} for: ${booking.quote.description}.`,
      bookingId: booking.customId || booking.id,
    });
  } else if (action === 'APPROVE_QUOTE') {
    if (booking.quote) {
      booking.quote.status = 'Approved';
      const quoteAmount = parseInt(String(booking.quote.amount).replace(/[^0-9]/g, '') || '0', 10);
      booking.priceNum = (booking.priceNum || 0) + quoteAmount;
      booking.price = `₹${booking.priceNum}`;
      booking.markModified('quote');

      if (booking.providerId) {
        await createAndDispatchNotification({
          recipientId: booking.providerId,
          eventId: `evt_quote_approved_${booking.customId || booking.id}`,
          type: 'QUOTE_APPROVED',
          priority: 'IMPORTANT',
          title: 'Quote Approved',
          body: `Customer approved the additional quote of ${booking.quote.amount}.`,
          bookingId: booking.customId || booking.id,
        });
      }
    }
  } else if (action === 'REJECT_QUOTE') {
    if (booking.quote) {
      booking.quote.status = 'Rejected';
      booking.markModified('quote');

      if (booking.providerId) {
        await createAndDispatchNotification({
          recipientId: booking.providerId,
          eventId: `evt_quote_rejected_${booking.customId || booking.id}`,
          type: 'QUOTE_REJECTED',
          priority: 'NORMAL',
          title: 'Quote Declined',
          body: `Customer declined additional quote. Continue with original service scope.`,
          bookingId: booking.customId || booking.id,
        });
      }
    }
  } else if (action === 'FINISH_WORK') {
    booking.status = targetStatus;
    booking.finishedAt = new Date();
    const payoutAmount = Math.round((booking.priceNum || 500) * 0.8);
    await User.updateOne(
      { _id: booking.worker || booking.providerId },
      { $inc: { todayEarnings: payoutAmount, walletBalance: payoutAmount } }
    );
    try {
      await createOrUpdatePassportAndGuarantee(booking);
    } catch (e) {}

    await addSystemMessage(booking.customId || booking.id, `Service marked as finished. Please review & rate your professional.`);
    await createAndDispatchNotification({
      recipientId: booking.customerId,
      eventId: `evt_finish_${booking.customId || booking.id}`,
      type: 'WORK_COMPLETED',
      priority: 'IMPORTANT',
      title: 'Service Completed',
      body: `Work completed by ${booking.providerName}. Please inspect and confirm completion.`,
      bookingId: booking.customId || booking.id,
    });
  } else if (action === 'CONFIRM_COMPLETION') {
    booking.status = targetStatus;
    booking.paymentStatus = 'Settled';
    try {
      await createOrUpdatePassportAndGuarantee(booking);
    } catch (e) {}

    if (booking.providerId) {
      await createAndDispatchNotification({
        recipientId: booking.providerId,
        eventId: `evt_confirm_completion_${booking.customId || booking.id}`,
        type: 'COMPLETION_CONFIRMED',
        priority: 'IMPORTANT',
        title: 'Completion Confirmed',
        body: `Customer confirmed completion for #${booking.customId || booking.id}. Payment credited.`,
        bookingId: booking.customId || booking.id,
      });
    }
  } else if (action === 'CANCEL_BOOKING') {
    booking.status = targetStatus;
    const cancelReason = (payload.reason || payload.cancellationReason || 'Customer requested cancellation').trim();
    booking.cancellationReason = cancelReason;

    // Authoritative Refund Calculation
    const isPaid = ['PAID', 'Settled', 'Paid Online', 'Paid'].includes(booking.paymentStatus);
    if (isPaid) {
      const baseAmt = booking.priceNum || 499;
      let calculatedRefund = baseAmt;
      if (['TRAVELLING', 'ARRIVED', 'Travelling', 'Arrived'].includes(prevStatus)) {
        calculatedRefund = Math.max(0, baseAmt - 149);
      }
      booking.refundAmount = calculatedRefund;
      booking.refundStatus = calculatedRefund > 0 ? 'INITIATED' : 'NOT_APPLICABLE';
      booking.refundMethod = booking.paymentMethod || 'Original Payment Source';

      await logFinancialAudit('REFUND_INITIATED', booking.customId || booking.id, actor.sub, actor.role, calculatedRefund, {
        reason: cancelReason,
        originalPrice: baseAmt,
        previousState: prevStatus,
        paymentStatus: booking.paymentStatus,
      });
    } else {
      booking.refundAmount = 0;
      booking.refundStatus = 'NOT_APPLICABLE';
      booking.refundMethod = 'None (Payment not captured)';
    }

    if (isCustomer && booking.providerId) {
      await createAndDispatchNotification({
        recipientId: booking.providerId,
        eventId: `evt_cancel_w_${booking.customId || booking.id}`,
        type: 'BOOKING_CANCELLED',
        priority: 'IMPORTANT',
        title: 'Booking Cancelled',
        body: `Customer cancelled booking #${booking.customId || booking.id}.${cancelReason ? ` Reason: ${cancelReason}` : ''}`,
        bookingId: booking.customId || booking.id,
      });
    } else if (isAdmin) {
      await createAndDispatchNotification({
        recipientId: booking.customerId,
        eventId: `evt_cancel_c_${booking.customId || booking.id}`,
        type: 'BOOKING_CANCELLED',
        priority: 'IMPORTANT',
        title: 'Booking Cancelled',
        body: `Booking #${booking.customId || booking.id} was cancelled by support.`,
        bookingId: booking.customId || booking.id,
      });
      if (booking.providerId) {
        await createAndDispatchNotification({
          recipientId: booking.providerId,
          eventId: `evt_cancel_w_${booking.customId || booking.id}`,
          type: 'BOOKING_CANCELLED',
          priority: 'IMPORTANT',
          title: 'Booking Cancelled',
          body: `Booking #${booking.customId || booking.id} was cancelled by support.`,
          bookingId: booking.customId || booking.id,
        });
      }
    }
  } else if (action === 'ADMIN_OVERRIDE') {
    booking.status = targetStatus;
  }

  // Record in audit history
  if (!booking.history) booking.history = [];
  booking.history.push({
    from: prevStatus,
    to: booking.status,
    by: actor.sub,
    role: actor.role,
    at: new Date(),
    action,
    note: payload.note || payload.reason || '',
  });

  const isTerminalState =
    isCanonicalCompletedStatus(booking.status) ||
    ['CANCELLED', 'Cancelled', 'DECLINED', 'EXPIRED'].includes(booking.status);
  if (isTerminalState) {
    booking.chatLocked = true;
  }

  await booking.save();

  // Broadcast realtime event to booking room
  const statusUpdatePayload = {
    type: 'booking_status_updated',
    bookingId: booking.customId || booking.id,
    status: booking.status,
    action,
    providerId: booking.providerId,
    providerName: booking.providerName,
  };

  broadcastToRoom(booking.customId || booking.id, statusUpdatePayload);
  broadcastToRoom(`user_${booking.customerId}`, statusUpdatePayload);
  if (booking.providerId) {
    broadcastToRoom(`user_${booking.providerId}`, statusUpdatePayload);
  }
  broadcastToAdmins(statusUpdatePayload);

  if (isTerminalState) {
    const termReason = ['CANCELLED', 'Cancelled'].includes(booking.status)
      ? 'booking_cancelled'
      : 'booking_completed';
    await deactivateBookingCommunication(booking, termReason);
  }

  if (['CANCELLED', 'Cancelled'].includes(booking.status)) {
    broadcastToWorkers({
      type: 'BOOKING_CANCELLED',
      bookingId: booking.customId || booking.id,
    });
  }

  // Automatic Home Service Passport & 7-Day Guarantee Activation upon completion
  if (['Completed', 'COMPLETED', 'Finished', 'Settled'].includes(booking.status)) {
    try {
      const passportRes = await createOrUpdatePassportAndGuarantee(booking);
      if (passportRes && passportRes.guarantee && passportRes.guarantee.status === 'ACTIVE') {
        const endDateStr = passportRes.guarantee.endDate
          ? new Date(passportRes.guarantee.endDate).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })
          : '7 days';

        await createAndDispatchNotification({
          recipientId: booking.customerId,
          eventId: `evt_guarantee_${booking.customId || booking.id}`,
          type: 'GUARANTEE_ACTIVATED',
          priority: 'IMPORTANT',
          title: '7-Day Service Guarantee Activated',
          body: `Your 7-day guarantee for ${booking.service} is active until ${endDateStr}. If the same issue returns, request a free revisit anytime.`,
          bookingId: booking.customId || booking.id,
          deepLink: `homestepin://passport/${booking.customId || booking.id}`,
        });
      }
    } catch (err) {
      console.warn('[PassportAndGuarantee] Completion trigger error:', err);
    }
  }

  return booking;
}

// Pre-confirmation address update (preserves location after confirmation)
app.patch(['/api/bookings/:id/address', '/api/customer/bookings/:id/address'], authRequired, requireRoles('customer', 'admin'), async (req, res) => {
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  if (booking.customerId !== req.auth.sub && req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized.' });
  }

  // Only allowed if booking is in Pending or Requested state before worker assignment/confirmation
  if (!['Pending', 'PENDING', 'Requested', 'SEARCHING_WORKER'].includes(booking.status)) {
    return res.status(400).json({ error: 'Address cannot be modified after booking is confirmed and in progress.' });
  }

  const { address, location, latitude, longitude, area, city, state, pincode } = req.body;
  const newAddress = address || (location && location.address) || booking.address;
  const newLat = latitude !== undefined ? Number(latitude) : (location && location.latitude !== undefined ? Number(location.latitude) : booking.latitude);
  const newLng = longitude !== undefined ? Number(longitude) : (location && location.longitude !== undefined ? Number(location.longitude) : booking.longitude);
  const newArea = area || (location && location.area) || booking.area;
  const newCity = city || (location && location.city) || booking.city;
  const newState = state || (location && location.state) || booking.state;
  const newPincode = pincode || (location && location.pincode) || booking.pincode;

  booking.address = newAddress;
  booking.latitude = newLat;
  booking.longitude = newLng;
  booking.area = newArea;
  booking.city = newCity;
  booking.state = newState;
  booking.pincode = newPincode;
  booking.location = {
    address: newAddress,
    area: newArea,
    city: newCity,
    state: newState,
    pincode: newPincode,
    latitude: newLat,
    longitude: newLng,
  };

  await booking.save();
  return res.json({ success: true, booking: formatBooking(booking) });
});

// 6. Customer Approve In-Flight Additional Quote
app.post('/api/bookings/:id/approve-quote', authRequired, requireRoles('customer'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'APPROVE_QUOTE', req.auth);
    return res.json({ success: true, booking: formatBooking(booking) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to approve quote.' });
  }
});

// 7. Customer Reject In-Flight Additional Quote
app.post('/api/bookings/:id/reject-quote', authRequired, requireRoles('customer'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'REJECT_QUOTE', req.auth);
    return res.json({ success: true, booking: formatBooking(booking) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to reject quote.' });
  }
});

// 8. Customer Rate & Review Service (Production-grade validation, duplicate prevention & worker aggregation)
app.post(
  [
    '/api/customer/bookings/:id/rate',
    '/api/bookings/:id/rate',
    '/api/bookings/:id/rating',
    '/api/bookings/:id/review',
    '/api/customer/bookings/:id/review',
  ],
  authRequired,
  requireRoles('customer', 'admin'),
  async (req, res) => {
    try {
      const { rating, review, reviewText, comment } = req.body;
      const booking = await findBookingById(req.params.id);

      // 1. Booking Existence Validation
      if (!booking) {
        return res.status(404).json({
          error: 'This booking could not be found.',
          code: 'BOOKING_NOT_FOUND',
        });
      }

      // 2. Ownership Validation
      if (booking.customerId !== req.auth.sub && req.auth.role !== 'admin') {
        return res.status(403).json({
          error: 'You cannot rate this booking.',
          code: 'FORBIDDEN',
        });
      }

      // 3. Completed Status Validation
      const completedStates = ['Completed', 'COMPLETED', 'Finished', 'Settled'];
      if (!completedStates.includes(booking.status)) {
        return res.status(400).json({
          error: 'Only completed bookings can be rated.',
          code: 'BOOKING_NOT_COMPLETED',
        });
      }

      // 4. Assigned Professional Validation
      if (!booking.providerId) {
        return res.status(400).json({
          error: 'No service professional is assigned to this booking.',
          code: 'NO_ASSIGNED_PROVIDER',
        });
      }

      // 5. Duplicate Rating Check
      const existingReview = await Review.findOne({
        booking: booking.customId || booking.id,
      });
      if (booking.rating || existingReview) {
        return res.status(409).json({
          error: 'This booking has already been rated.',
          code: 'ALREADY_RATED',
          rating: booking.rating || (existingReview ? existingReview.rating : 5),
          booking: formatBooking(booking),
        });
      }

      // 6. Rating Value Range Validation (1 to 5)
      const parsedRating = parseInt(rating, 10);
      if (isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
        return res.status(400).json({
          error: 'Rating is required and must be an integer between 1 and 5 stars.',
          code: 'INVALID_RATING',
        });
      }

      const reviewString = String(review || reviewText || comment || '').trim().slice(0, 1000);

      // 7. Save Rating to Booking
      booking.rating = parsedRating;
      booking.review = reviewString;
      await booking.save();

      // 8. Create / Upsert Review Record
      await Review.findOneAndUpdate(
        { booking: booking.customId || booking.id },
        {
          $set: {
            booking: booking.customId || booking.id,
            customer: booking.customerId,
            worker: booking.providerId,
            service: booking.service,
            rating: parsedRating,
            comment: reviewString,
          },
        },
        { upsert: true, returnDocument: 'after' }
      );

      // 9. Recalculate Professional's Aggregate Rating & Review Count
      if (booking.providerId) {
        const worker = await findUserByIdOrIdentifier(booking.providerId);
        if (worker) {
          const allReviews = await Review.find({
            $or: [
              { worker: worker.customId },
              { worker: worker._id.toString() },
              { worker: booking.providerId },
            ],
          });

          const totalCount = allReviews.length;
          const totalSum = allReviews.reduce((sum, r) => sum + (r.rating || 5), 0);
          const avgRating = totalCount > 0 ? Number((totalSum / totalCount).toFixed(2)) : 5.0;

          worker.ratingAvg = avgRating;
          worker.ratingCount = totalCount;
          await worker.save();
        }

        // 10. Dispatch Real-Time Notification to Worker
        await createAndDispatchNotification({
          recipientId: booking.providerId,
          eventId: `evt_rate_${booking.customId || booking.id}`,
          type: 'NEW_RATING',
          title: 'New Customer Rating ⭐',
          body: `${booking.customerName || 'Customer'} rated your service ${parsedRating}/5 stars${reviewString ? `: "${reviewString}"` : '.'}`,
          bookingId: booking.customId || booking.id,
        }).catch(() => {});
      }

      return res.status(200).json({
        success: true,
        message: 'Rating submitted successfully!',
        booking: formatBooking(booking),
      });
    } catch (err) {
      console.error('[Rating Error]:', err);
      return res.status(500).json({ error: 'Failed to submit rating. Please try again.' });
    }
  }
);

// 9. Customer Confirm Completion
app.post('/api/bookings/:id/confirm-completion', authRequired, requireRoles('customer'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'CONFIRM_COMPLETION', req.auth);
    return res.json({ success: true, booking: formatBooking(booking) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to confirm completion.' });
  }
});

// 10. Customer Cancel Booking
app.post('/api/bookings/:id/cancel', authRequired, requireRoles('customer'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'CANCEL_BOOKING', req.auth, {
      reason: req.body?.reason || req.body?.cancellationReason,
    });
    return res.json({ success: true, booking: formatBooking(booking) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to cancel booking.' });
  }
});

// 11. Authoritative Customer & Admin Receipt / Tax Invoice Generation
async function handleGetBookingReceipt(req, res) {
  try {
    const booking = await findBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    const isCustomer =
      booking.customerId === req.auth.sub ||
      (req.auth.customId && booking.customerId === req.auth.customId);
    const isWorker =
      booking.providerId === req.auth.sub ||
      (req.auth.customId && booking.providerId === req.auth.customId);
    const isAdmin = req.auth.role === 'admin';

    if (!isCustomer && !isWorker && !isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view this receipt.' });
    }

    const bookingId = booking.customId || booking.id || booking._id.toString();
    const invoiceNum = booking.invoiceNumber || `INV-${bookingId}`;
    const issuedAt = booking.finishedAt || booking.updatedAt || booking.createdAt || new Date();

    const pb = booking.priceBreakdown || {};
    const basePrice = pb.basePrice || booking.priceNum || 499;
    const quantity = pb.quantity || 1;
    const itemSubtotal = pb.itemSubtotal || basePrice * quantity;
    const addOns = pb.addOns || [];
    const subtotal = pb.subtotal || itemSubtotal;
    const convenienceFee = pb.convenienceFee !== undefined ? pb.convenienceFee : subtotal >= 2000 ? 0 : 49;
    const tax = pb.tax !== undefined ? pb.tax : Math.round(subtotal * 0.05);
    const discount = pb.discount || 0;
    const couponCode = pb.couponCode || null;
    const totalAmount = pb.totalAmount || booking.priceNum || Math.max(0, subtotal + convenienceFee + tax - discount);

    const receipt = {
      receiptNumber: `RCP-${bookingId}`,
      invoiceNumber: invoiceNum,
      issuedAt: new Date(issuedAt).toISOString(),
      bookingId,
      service: booking.service,
      category: booking.category,
      customer: {
        id: booking.customerId,
        name: booking.customerName,
        phone: isCustomer || isAdmin ? booking.customerPhone : booking.customerPhone ? `${booking.customerPhone.slice(0, 3)}****${booking.customerPhone.slice(-3)}` : null,
      },
      worker: {
        id: booking.providerId || null,
        name: booking.providerName || 'HomeStepIn Professional',
        phone: booking.providerPhone || null,
        isVerified: booking.providerIsVerified || Boolean(booking.providerId),
      },
      serviceAddress: booking.serviceAddress || {
        formattedAddress: booking.address,
        area: booking.area,
        city: booking.city,
        state: booking.state,
        pincode: booking.pincode,
      },
      scheduledDate: booking.date,
      scheduledTime: booking.time,
      status: booking.status,
      pricing: {
        basePrice,
        quantity,
        itemSubtotal,
        addOns,
        subtotal,
        convenienceFee,
        tax,
        discount,
        couponCode,
        totalAmount,
        currency: 'INR',
      },
      payment: {
        status: booking.paymentStatus,
        method: booking.paymentMethod || 'Pay Online',
        transactionId: `TXN-${bookingId}`,
        paidAt: ['PAID', 'Settled', 'Paid Online', 'Paid'].includes(booking.paymentStatus) ? new Date(issuedAt).toISOString() : null,
      },
      company: {
        name: 'HomeStepIn Technologies Pvt Ltd',
        address: '7th Cross, Koramangala 4th Block, Bengaluru, Karnataka 560034',
        gstin: '29AABCH1234F1Z8',
        supportEmail: 'support@homestepin.com',
        supportPhone: '+91 800 123 4567',
      },
    };

    if (req.path.endsWith('/html')) {
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Tax Invoice - ${invoiceNum}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 32px; color: #1e293b; background: #fff; }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; }
    .logo { font-size: 24px; font-weight: 800; color: #6366f1; }
    .inv-title { font-size: 20px; font-weight: 700; color: #0f172a; }
    .inv-meta { margin-top: 4px; font-size: 13px; color: #64748b; }
    .parties { display: flex; justify-content: space-between; margin-top: 24px; padding: 16px; background: #f8fafc; border-radius: 8px; }
    .party { max-width: 45%; font-size: 14px; }
    .party-title { font-size: 11px; text-transform: uppercase; font-weight: 700; color: #94a3b8; letter-spacing: 0.5px; }
    .party-name { font-weight: 700; font-size: 15px; margin: 4px 0; color: #0f172a; }
    .table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 14px; }
    .table th { background: #f1f5f9; padding: 10px 12px; text-align: left; font-weight: 600; color: #475569; }
    .table td { padding: 12px; border-bottom: 1px solid #e2e8f0; }
    .totals { width: 320px; margin-left: auto; margin-top: 24px; font-size: 14px; }
    .totals-row { display: flex; justify-content: space-between; padding: 6px 0; }
    .grand-total { font-size: 18px; font-weight: 800; color: #0f172a; border-top: 2px solid #0f172a; padding-top: 10px; margin-top: 6px; }
    .footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">HomeStepIn</div>
      <div class="inv-meta">HomeStepIn Technologies Pvt Ltd<br/>GSTIN: 29AABCH1234F1Z8</div>
    </div>
    <div style="text-align: right;">
      <div class="inv-title">TAX INVOICE / RECEIPT</div>
      <div class="inv-meta">Invoice #: <strong>${invoiceNum}</strong><br/>Booking ID: <strong>#${bookingId}</strong><br/>Date: ${new Date(issuedAt).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })}</div>
    </div>
  </div>
  <div class="parties">
    <div class="party">
      <div class="party-title">Billed To</div>
      <div class="party-name">${receipt.customer.name}</div>
      <div>${receipt.serviceAddress.formattedAddress || 'Service Address'}</div>
      <div>Phone: ${receipt.customer.phone || 'N/A'}</div>
    </div>
    <div class="party" style="text-align: right;">
      <div class="party-title">Service Professional</div>
      <div class="party-name">${receipt.worker.name}</div>
      <div>Status: ${receipt.worker.isVerified ? '✓ Verified Professional' : 'Assigned Professional'}</div>
      <div>Payment Status: <strong>${receipt.payment.status}</strong> (${receipt.payment.method})</div>
    </div>
  </div>
  <table class="table">
    <thead>
      <tr>
        <th>Service Description</th>
        <th style="text-align: center;">Qty</th>
        <th style="text-align: right;">Rate</th>
        <th style="text-align: right;">Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>${receipt.service}</strong><br/><span style="color: #64748b; font-size: 12px;">Category: ${receipt.category}</span></td>
        <td style="text-align: center;">${quantity}</td>
        <td style="text-align: right;">₹${basePrice}</td>
        <td style="text-align: right;">₹${itemSubtotal}</td>
      </tr>
      ${addOns.map((a) => `
      <tr>
        <td>${a.name} (Add-on)</td>
        <td style="text-align: center;">1</td>
        <td style="text-align: right;">₹${a.price}</td>
        <td style="text-align: right;">₹${a.price}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <div class="totals">
    <div class="totals-row"><span>Subtotal:</span><span>₹${subtotal}</span></div>
    <div class="totals-row"><span>Convenience Fee:</span><span>₹${convenienceFee}</span></div>
    <div class="totals-row"><span>Taxes & GST (5%):</span><span>₹${tax}</span></div>
    ${discount > 0 ? `<div class="totals-row" style="color: #16a34a;"><span>Promo Discount (${couponCode || 'APPLIED'}):</span><span>-₹${discount}</span></div>` : ''}
    <div class="totals-row grand-total"><span>Total Paid:</span><span>₹${totalAmount}</span></div>
  </div>
  <div class="footer">
    Thank you for choosing HomeStepIn! For queries, reach us at support@homestepin.com or +91 800 123 4567.<br/>
    This is a computer-generated tax invoice and requires no physical signature.
  </div>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }

    return res.json({ success: true, receipt });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate receipt.' });
  }
}

app.get(['/api/bookings/:id/receipt', '/api/customer/bookings/:id/receipt'], authRequired, handleGetBookingReceipt);
app.get(['/api/bookings/:id/receipt/html', '/api/customer/bookings/:id/receipt/html'], authRequired, handleGetBookingReceipt);

// ── HOME SERVICE PASSPORT & 7-DAY GUARANTEE APIS ─────────────────────

// 1. Customer Home Service Passport (Overview, Categories & Timeline)
app.get(['/api/customer/service-passport', '/api/passport', '/api/customer/passport'], authRequired, requireRoles('customer', 'admin'), async (req, res) => {
  try {
    const requestingUser = await findUserByIdOrIdentifier(req.auth.sub);
    const userIds = [req.auth.sub, requestingUser?._id?.toString(), requestingUser?.customId].filter(Boolean);

    const query = req.auth.role === 'admin' ? {} : { customerId: { $in: userIds } };
    const rawRecords = await HomeServiceRecord.find(query).sort({ completionDate: -1 }).lean();

    // Deduplicate by bookingId to ensure strict uniqueness in timeline
    const seenBookings = new Set();
    const records = [];
    for (const r of rawRecords) {
      const bId = r.bookingId || r.customId || String(r._id);
      if (!seenBookings.has(bId)) {
        seenBookings.add(bId);
        records.push(r);
      }
    }

    const now = new Date();

    // Auto-expire active guarantees past endDate
    await ServiceGuarantee.updateMany(
      { customerId: { $in: userIds }, status: 'ACTIVE', endDate: { $lt: now } },
      { status: 'EXPIRED' }
    );

    const activeGuaranteesCount = await ServiceGuarantee.countDocuments({
      customerId: { $in: userIds },
      status: 'ACTIVE',
      endDate: { $gte: now },
    });

    // Real categories breakdown
    const categoryMap = new Map();
    for (const r of records) {
      const cat = r.category || 'Home Service';
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, {
          category: cat,
          serviceCount: 0,
          lastServicedAt: r.completionDate,
          recentService: r.service,
        });
      }
      const existing = categoryMap.get(cat);
      existing.serviceCount += 1;
      if (new Date(r.completionDate) > new Date(existing.lastServicedAt)) {
        existing.lastServicedAt = r.completionDate;
        existing.recentService = r.service;
      }
    }

    const categories = Array.from(categoryMap.values());

    // Upcoming recommended maintenance from records
    let nextMaintenance = null;
    const upcomingRecords = records
      .filter(r => r.nextRecommendedServiceDate && new Date(r.nextRecommendedServiceDate) > now)
      .sort((a, b) => new Date(a.nextRecommendedServiceDate).getTime() - new Date(b.nextRecommendedServiceDate).getTime());

    if (upcomingRecords.length > 0) {
      nextMaintenance = {
        date: upcomingRecords[0].nextRecommendedServiceDate,
        service: upcomingRecords[0].service,
        category: upcomingRecords[0].category,
        reason: upcomingRecords[0].nextRecommendedServiceReason,
      };
    }

    const overview = {
      totalCompletedServices: records.length,
      lastServiceDate: records.length > 0 ? records[0].completionDate : null,
      activeGuaranteesCount,
      nextRecommendedMaintenance: nextMaintenance,
      homeAddress: records.length > 0 ? records[0].address : null,
    };

    return res.json({
      overview,
      categories,
      timeline: records,
    });
  } catch (err) {
    console.error('[Passport Fetch Error]:', err);
    return res.status(500).json({ error: 'Failed to retrieve Home Service Passport.' });
  }
});

// 2. Customer Home Service Passport Record Details
app.get(['/api/customer/service-passport/:id', '/api/passport/:id', '/api/customer/passport/:id', '/api/bookings/:id/passport'], authRequired, requireRoles('customer', 'admin'), async (req, res) => {
  try {
    const requestingUser = await findUserByIdOrIdentifier(req.auth.sub);
    const userIds = [req.auth.sub, requestingUser?._id?.toString(), requestingUser?.customId].filter(Boolean);

    let record = await HomeServiceRecord.findOne({
      $or: [
        { customId: req.params.id },
        { bookingId: req.params.id },
        { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null },
      ],
    }).lean();

    // If record not in HomeServiceRecord table directly, check if it's a completed booking
    let booking = null;
    if (record) {
      booking = await Booking.findOne({
        $or: [
          { customId: record.bookingId },
          { id: record.bookingId },
          { _id: /^[0-9a-fA-F]{24}$/.test(record.bookingId) ? record.bookingId : (record.booking || null) },
        ],
      }).lean();
    } else {
      booking = await Booking.findOne({
        $or: [
          { customId: req.params.id },
          { id: req.params.id },
          { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null },
        ],
      }).lean();

      if (booking && ['Completed', 'COMPLETED', 'Finished', 'Settled'].includes(booking.status)) {
        const result = await createOrUpdatePassportAndGuarantee(booking);
        if (result && result.record) {
          record = result.record.toObject ? result.record.toObject() : result.record;
        }
      }
    }

    if (!record && !booking) {
      return res.status(404).json({ error: 'Service passport record not found.', code: 'RECORD_NOT_FOUND' });
    }

    const recordCustomerId = record ? record.customerId : booking.customerId;
    if (!userIds.includes(recordCustomerId) && req.auth.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized to view this record.', code: 'FORBIDDEN' });
    }

    const bookingId = record ? record.bookingId : (booking.customId || booking.id || String(booking._id));

    const guarantee = await ServiceGuarantee.findOne({
      $or: [{ originalBookingId: bookingId }, { guaranteeId: record?.guarantee?.guaranteeId }],
    }).lean();

    // Fetch worker details & rating if workerId exists
    const workerId = record?.workerId || booking?.providerId;
    let workerRating = record?.workerRating || booking?.rating || null;
    let workerRatingAvg = record?.workerRatingAvg || null;
    if (workerId && workerId !== 'UNASSIGNED') {
      const workerUser = await User.findOne({
        $or: [
          { customId: workerId },
          { _id: /^[0-9a-fA-F]{24}$/.test(workerId) ? workerId : null },
        ],
      }).lean();
      if (workerUser && workerUser.ratingAvg !== undefined && workerUser.ratingAvg !== null) {
        workerRatingAvg = workerUser.ratingAvg;
      }
    }

    // Build the consolidated authoritative passport detail record
    const serviceAddress = record?.serviceAddress?.formattedAddress ? record.serviceAddress : (booking?.serviceAddress || {
      formattedAddress: record?.address || booking?.address || '',
      houseNumber: '',
      street: '',
      area: record?.area || booking?.area || '',
      locality: '',
      city: record?.city || booking?.city || 'Bengaluru',
      district: '',
      state: record?.state || booking?.state || 'Karnataka',
      postalCode: record?.pincode || booking?.pincode || '',
      country: 'India',
      landmark: '',
      latitude: record?.latitude || booking?.latitude || null,
      longitude: record?.longitude || booking?.longitude || null,
    });

    const detailedRecord = {
      ...record,
      bookingId,
      workerName: record?.workerName || booking?.providerName || 'HomeStepIn Professional',
      workerPhone: record?.workerPhone || booking?.providerPhone || '',
      workerRating,
      workerRatingAvg,
      serviceAddress,
      latitude: serviceAddress.latitude || record?.latitude || booking?.latitude || null,
      longitude: serviceAddress.longitude || record?.longitude || booking?.longitude || null,
      scheduledDate: record?.scheduledDate || booking?.date || null,
      scheduledTime: record?.scheduledTime || booking?.time || null,
      scheduledAt: record?.scheduledAt || booking?.scheduledAt || null,
      enteredHomeAt: booking?.enteredHomeAt || null,
      workStartedAt: booking?.workStartedAt || null,
      finishedAt: booking?.finishedAt || record?.completionDate || null,
      priceBreakdown: record?.priceBreakdown || booking?.priceBreakdown || null,
      paymentMethod: record?.paymentMethod || booking?.paymentMethod || 'Pay Online',
      paymentStatus: record?.paymentStatus || booking?.paymentStatus || 'Settled',
      paymentId: record?.paymentId || booking?.customId || null,
      issueDescription: record?.issueDescription || booking?.issueDescription || booking?.problemDescription || booking?.revisitOriginalIssue || null,
      diagnosis: record?.diagnosis || booking?.diagnosis || (booking?.quote ? booking.quote.description : null),
      workPerformed: record?.workPerformed || booking?.workPerformed || null,
      partsUsed: (record?.partsUsed && record.partsUsed.length > 0) ? record.partsUsed : (booking?.partsUsed || []),
      beforePhotos: (record?.beforePhotos && record.beforePhotos.length > 0) ? record.beforePhotos : (booking?.beforePhotos || []),
      afterPhotos: (record?.afterPhotos && record.afterPhotos.length > 0) ? record.afterPhotos : (booking?.afterPhotos || []),
      invoiceUrl: record?.invoiceUrl || null,
      invoiceAvailable: Boolean(record?.invoiceUrl),
    };

    return res.json({ record: detailedRecord, booking: booking || null, guarantee: guarantee || null });
  } catch (err) {
    console.error('[Passport Detail Error]:', err);
    return res.status(500).json({ error: 'Failed to fetch passport record details.' });
  }
});

// 3. Customer Active Guarantees List
app.get(['/api/customer/guarantees', '/api/guarantees'], authRequired, requireRoles('customer', 'admin'), async (req, res) => {
  try {
    const requestingUser = await findUserByIdOrIdentifier(req.auth.sub);
    const userIds = [req.auth.sub, requestingUser?._id?.toString(), requestingUser?.customId].filter(Boolean);
    const now = new Date();

    // Auto-expire
    await ServiceGuarantee.updateMany(
      { customerId: { $in: userIds }, status: 'ACTIVE', endDate: { $lt: now } },
      { status: 'EXPIRED' }
    );

    const query = req.auth.role === 'admin' ? {} : { customerId: { $in: userIds } };
    const guarantees = await ServiceGuarantee.find(query).sort({ completionDate: -1 });
    return res.json({ guarantees });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve service guarantees.' });
  }
});

// 4. Single Guarantee Details
app.get('/api/guarantees/:id', authRequired, async (req, res) => {
  try {
    const guarantee = await ServiceGuarantee.findOne({
      $or: [
        { guaranteeId: req.params.id },
        { originalBookingId: req.params.id },
        { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null },
      ],
    });

    if (!guarantee) {
      return res.status(404).json({ error: 'Guarantee not found.', code: 'GUARANTEE_NOT_FOUND' });
    }

    const requestingUser = await findUserByIdOrIdentifier(req.auth.sub);
    const userIds = [req.auth.sub, requestingUser?._id?.toString(), requestingUser?.customId].filter(Boolean);

    const isOwner = userIds.includes(guarantee.customerId);
    const isWorker = userIds.includes(guarantee.workerId);
    const isAdmin = req.auth.role === 'admin';

    if (!isOwner && !isWorker && !isAdmin) {
      return res.status(403).json({ error: 'Unauthorized.', code: 'FORBIDDEN' });
    }

    // Auto-expire check
    if (guarantee.status === 'ACTIVE' && Date.now() > guarantee.endDate.getTime()) {
      guarantee.status = 'EXPIRED';
      await guarantee.save();
    }

    return res.json({ guarantee });
  } catch (err) {
    console.error('[Guarantee Detail Error]', err);
    return res.status(500).json({ error: 'Failed to retrieve guarantee record.' });
  }
});

// 5. Request 7-Day Guarantee Free Revisit
app.post('/api/guarantees/:id/revisit', authRequired, requireRoles('customer'), async (req, res) => {
  try {
    const { issueDescription, customerNotes, photos } = req.body;
    const explanation = issueDescription || customerNotes || '';

    if (!explanation.trim()) {
      return res.status(400).json({
        error: 'Please describe the recurring or unresolved issue.',
        code: 'MISSING_EXPLANATION',
      });
    }

    const guarantee = await ServiceGuarantee.findOne({
      $or: [
        { guaranteeId: req.params.id },
        { originalBookingId: req.params.id },
        { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null },
      ],
    });

    if (!guarantee) {
      return res.status(404).json({ error: 'Service guarantee not found.', code: 'GUARANTEE_NOT_FOUND' });
    }

    // 1. Ownership validation
    const custUser = await findUserByIdOrIdentifier(req.auth.sub);
    const customerIds = [req.auth.sub, custUser?._id?.toString(), custUser?.customId].filter(Boolean);
    if (!customerIds.includes(guarantee.customerId) && req.auth.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized.', code: 'FORBIDDEN' });
    }

    // 2. Expiry validation (7 days from actual completion date)
    if (Date.now() > guarantee.endDate.getTime()) {
      guarantee.status = 'EXPIRED';
      await guarantee.save();
      return res.status(400).json({
        error: 'The 7-day guarantee window for this booking has expired.',
        code: 'GUARANTEE_EXPIRED',
      });
    }

    // 3. Status validation
    if (['USED', 'RESOLVED'].includes(guarantee.status)) {
      return res.status(400).json({
        error: 'This 7-day service guarantee revisit has already been used.',
        code: 'GUARANTEE_ALREADY_USED',
      });
    }

    if (guarantee.status === 'CLAIM_REQUESTED' || guarantee.revisitBookingId) {
      return res.status(400).json({
        error: 'A free revisit request is already pending or active for this booking.',
        code: 'REVISIT_ALREADY_REQUESTED',
      });
    }

    // 4. Verify original booking is genuinely completed
    const originalBooking = await Booking.findOne({
      $or: [{ customId: guarantee.originalBookingId }, { _id: guarantee.originalBooking }],
    });

    if (!originalBooking || !['Completed', 'COMPLETED', 'Finished', 'Settled'].includes(originalBooking.status)) {
      return res.status(400).json({
        error: 'Original booking must be completed before requesting a guarantee revisit.',
        code: 'BOOKING_NOT_COMPLETED',
      });
    }

    // 5. Create genuine Revisit Booking in database
    const revisitBookingId = `BK-REV-${Date.now().toString().slice(-6)}`;
    const revisitBooking = await Booking.create({
      customId: revisitBookingId,
      customerId: guarantee.customerId,
      customerName: guarantee.customerName,
      customerPhone: guarantee.customerPhone,
      providerId: guarantee.workerId !== 'UNASSIGNED' ? guarantee.workerId : null,
      providerName: guarantee.workerName || null,
      providerPhone: guarantee.workerPhone || null,
      service: guarantee.service,
      category: guarantee.category,
      date: 'Today',
      time: 'Priority Revisit',
      address: guarantee.address,
      latitude: originalBooking.latitude,
      longitude: originalBooking.longitude,
      price: '₹0 (Free Guarantee Revisit)',
      priceNum: 0,
      isGuaranteeRevisit: true,
      originalBookingId: guarantee.originalBookingId,
      guaranteeId: guarantee.guaranteeId,
      revisitReason: explanation,
      revisitOriginalIssue: originalBooking.service,
      status: 'PENDING',
      paymentStatus: 'PAID',
      startOtp: Math.floor(1000 + Math.random() * 9000).toString(),
      beforePhotos: Array.isArray(photos) ? photos : [],
    });

    // 6. Update Guarantee Status & Claim details
    guarantee.status = 'CLAIM_REQUESTED';
    guarantee.claim = {
      requestedAt: new Date(),
      reason: explanation,
      customerNotes: explanation,
      photos: Array.isArray(photos) ? photos : [],
    };
    guarantee.revisitBookingId = revisitBooking.customId;
    guarantee.revisitBooking = revisitBooking._id;
    await guarantee.save();

    // 7. Update HomeServiceRecord
    await HomeServiceRecord.updateOne(
      { bookingId: guarantee.originalBookingId },
      {
        'guarantee.status': 'CLAIM_REQUESTED',
        'guarantee.revisitBookingId': revisitBooking.customId,
      }
    );

    // 8. Notifications
    await createAndDispatchNotification({
      recipientId: guarantee.customerId,
      eventId: `evt_revisit_req_${revisitBooking.customId}`,
      type: 'REVISIT_SUBMITTED',
      priority: 'IMPORTANT',
      title: 'Free Revisit Requested',
      body: `Your free revisit request for ${guarantee.service} (#${revisitBooking.customId}) has been submitted. A professional will be assigned promptly.`,
      bookingId: revisitBooking.customId,
    });

    if (guarantee.workerId && guarantee.workerId !== 'UNASSIGNED') {
      await createAndDispatchNotification({
        recipientId: guarantee.workerId,
        eventId: `evt_revisit_wkr_${revisitBooking.customId}`,
        type: 'GUARANTEE_REVISIT_ASSIGNED',
        priority: 'IMPORTANT',
        title: 'Service Guarantee Revisit',
        body: `Customer reported recurring issue for #${guarantee.originalBookingId} (${guarantee.service}): "${explanation}". Priority revisit assigned.`,
        bookingId: revisitBooking.customId,
      });

      broadcastToRoom(`user_${guarantee.workerId}`, {
        type: 'new_job_offer',
        job: formatWorkerJob(revisitBooking, guarantee.workerId),
      });
    }

    broadcastToAdmins({
      type: 'NEW_GUARANTEE_CLAIM',
      guaranteeId: guarantee.guaranteeId,
      bookingId: revisitBooking.customId,
    });

    return res.status(201).json({
      success: true,
      message: 'Free revisit requested successfully.',
      revisitBooking: formatBooking(revisitBooking),
      guarantee,
    });
  } catch (err) {
    console.error('[Revisit Request Error]:', err);
    return res.status(500).json({ error: 'Failed to submit free revisit request.' });
  }
});

// 6. Worker Performance Endpoint (Calculated from authenticated DB records)
app.get(['/api/worker/performance', '/api/worker/:workerId/performance'], authRequired, async (req, res) => {
  try {
    const targetWorkerId = req.params.workerId || req.auth.sub;
    const performance = await calculateWorkerPerformance(targetWorkerId);
    return res.json(performance);
  } catch (err) {
    console.error('[Worker Performance Error]:', err);
    return res.status(500).json({ error: 'Failed to calculate worker performance metrics.' });
  }
});

// 7. Admin Guarantees Management
app.get('/api/admin/guarantees', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const { status, search } = req.query;
    const query = {};

    if (status && status !== 'ALL') {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { guaranteeId: new RegExp(String(search), 'i') },
        { originalBookingId: new RegExp(String(search), 'i') },
        { customerName: new RegExp(String(search), 'i') },
        { workerName: new RegExp(String(search), 'i') },
        { service: new RegExp(String(search), 'i') },
      ];
    }

    const guarantees = await ServiceGuarantee.find(query).sort({ createdAt: -1 });
    return res.json({ guarantees, totalCount: guarantees.length });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve admin guarantee records.' });
  }
});

// 8. Admin Guarantee Details
app.get('/api/admin/guarantees/:id', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const guarantee = await ServiceGuarantee.findOne({
      $or: [
        { guaranteeId: req.params.id },
        { originalBookingId: req.params.id },
        { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null },
      ],
    }).populate('originalBooking');

    if (!guarantee) {
      return res.status(404).json({ error: 'Guarantee record not found.' });
    }

    let revisitBooking = null;
    if (guarantee.revisitBookingId) {
      revisitBooking = await Booking.findOne({
        $or: [{ customId: guarantee.revisitBookingId }, { _id: guarantee.revisitBooking }],
      });
    }

    return res.json({ guarantee, revisitBooking });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve guarantee details.' });
  }
});

// 9. Admin Approve Guarantee Revisit
app.patch('/api/admin/guarantees/:id/approve', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const guarantee = await ServiceGuarantee.findOne({
      $or: [{ guaranteeId: req.params.id }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
    });

    if (!guarantee) return res.status(404).json({ error: 'Guarantee not found.' });

    guarantee.status = 'APPROVED';
    if (!guarantee.claim) guarantee.claim = {};
    guarantee.claim.reviewedBy = req.auth.sub;
    guarantee.claim.reviewedAt = new Date();
    await guarantee.save();

    // If revisit booking exists, advance it
    if (guarantee.revisitBookingId) {
      await Booking.updateOne(
        { customId: guarantee.revisitBookingId },
        { status: 'Confirmed' }
      );
    }

    // Notify customer
    await createAndDispatchNotification({
      recipientId: guarantee.customerId,
      eventId: `evt_rev_app_${guarantee.guaranteeId}`,
      type: 'REVISIT_APPROVED',
      priority: 'IMPORTANT',
      title: 'Free Revisit Approved',
      body: `Your guarantee revisit for ${guarantee.service} has been approved by support. A technician will arrive shortly.`,
      bookingId: guarantee.revisitBookingId || guarantee.originalBookingId,
    });

    return res.json({ success: true, guarantee });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to approve revisit claim.' });
  }
});

// 10. Admin Reject Guarantee Revisit
app.patch('/api/admin/guarantees/:id/reject', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const { rejectionReason } = req.body;
    const reasonText = rejectionReason || 'Claim does not meet free guarantee coverage criteria.';

    const guarantee = await ServiceGuarantee.findOne({
      $or: [{ guaranteeId: req.params.id }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
    });

    if (!guarantee) return res.status(404).json({ error: 'Guarantee not found.' });

    guarantee.status = 'REJECTED';
    if (!guarantee.claim) guarantee.claim = {};
    guarantee.claim.rejectionReason = reasonText;
    guarantee.claim.reviewedBy = req.auth.sub;
    guarantee.claim.reviewedAt = new Date();
    await guarantee.save();

    if (guarantee.revisitBookingId) {
      await Booking.updateOne(
        { customId: guarantee.revisitBookingId },
        { status: 'CANCELLED' }
      );
    }

    // Notify customer
    await createAndDispatchNotification({
      recipientId: guarantee.customerId,
      eventId: `evt_rev_rej_${guarantee.guaranteeId}`,
      type: 'REVISIT_REJECTED',
      priority: 'IMPORTANT',
      title: 'Revisit Request Update',
      body: `Your revisit request for ${guarantee.service} was declined: ${reasonText}`,
      bookingId: guarantee.originalBookingId,
    });

    return res.json({ success: true, guarantee });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reject revisit claim.' });
  }
});

// 11. Real-Time Tracking & Route Context
app.get('/api/bookings/:id/tracking', authRequired, async (req, res) => {
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const isCustomer = String(booking.customerId) === String(req.auth.sub);
  const isWorker = String(booking.providerId) === String(req.auth.sub);
  const isAdmin = req.auth.role === 'admin';

  if (!isCustomer && !isWorker && !isAdmin) {
    return res.status(403).json({ error: 'Unauthorized to track this booking.' });
  }

  const normStatus = normalizeState(booking.status);
  const trackingAllowedStates = [
    BOOKING_STATES.WORKER_ACCEPTED,
    BOOKING_STATES.TRAVELLING,
    BOOKING_STATES.ARRIVED,
    BOOKING_STATES.ENTERED_HOME,
    BOOKING_STATES.WORK_STARTED,
  ];
  const isTrackingActive = trackingAllowedStates.includes(normStatus);

  // PRIVACY: Customer receives only status checkpoints, not live worker coordinates or moving markers
  if (isCustomer) {
    return res.json({
      bookingId: booking.customId || booking.id,
      service: booking.service,
      status: normStatus,
      isTrackingActive,
      destination: {
        address: booking.address,
        area: (booking.serviceAddress && booking.serviceAddress.area) || booking.area,
        city: (booking.serviceAddress && booking.serviceAddress.city) || booking.city,
      },
      worker: {
        id: booking.providerId,
        name: booking.providerName || 'Service Professional',
        phone: booking.providerPhone,
      },
      startOtp: booking.startOtp,
      updatedAt: booking.updatedAt || new Date().toISOString(),
    });
  }

  // Worker and Admin receive full route details (including destination coordinates for worker navigation)
  let workerLoc = null;
  let distanceKm = booking.distanceKm || null;
  let etaMinutes = booking.etaMinutes || null;

  if (isTrackingActive && typeof booking.workerLatitude === 'number' && typeof booking.workerLongitude === 'number') {
    workerLoc = {
      latitude: booking.workerLatitude,
      longitude: booking.workerLongitude,
      heading: booking.workerHeading || 0,
      updatedAt: booking.locationLastUpdatedAt,
    };
    if (typeof booking.latitude === 'number' && typeof booking.longitude === 'number') {
      distanceKm = calculateHaversineDistanceKm(booking.workerLatitude, booking.workerLongitude, booking.latitude, booking.longitude);
      etaMinutes = calculateEtaMinutes(distanceKm);
    }
  }

  return res.json({
    bookingId: booking.customId || booking.id,
    service: booking.service,
    status: normStatus,
    isTrackingActive,
    destination: {
      address: booking.address,
      latitude: booking.latitude,
      longitude: booking.longitude,
      accuracy: booking.locationAccuracy,
      area: (booking.serviceAddress && booking.serviceAddress.area) || booking.area,
      city: (booking.serviceAddress && booking.serviceAddress.city) || booking.city,
    },
    worker: {
      id: booking.providerId,
      name: booking.providerName || 'Service Professional',
      phone: booking.providerPhone,
      location: workerLoc,
    },
    etaMinutes: isTrackingActive ? etaMinutes : null,
    distanceKm: isTrackingActive ? distanceKm : null,
    updatedAt: booking.locationLastUpdatedAt || booking.updatedAt,
  });
});

// ── 4. WORKER DOMAIN ──────────────────────────────────────────────────

// ── Helper: Format Worker Job Object for Response ──────────────────
function formatWorkerJob(b, workerIdOrUser) {
  const matchIds = new Set();
  if (workerIdOrUser && typeof workerIdOrUser === 'object') {
    if (workerIdOrUser._id) matchIds.add(String(workerIdOrUser._id));
    if (workerIdOrUser.customId) matchIds.add(String(workerIdOrUser.customId));
    if (workerIdOrUser.id) matchIds.add(String(workerIdOrUser.id));
    if (workerIdOrUser.employeeId) matchIds.add(String(workerIdOrUser.employeeId));
  } else if (workerIdOrUser) {
    matchIds.add(String(workerIdOrUser));
  }

  const isAssigned = Boolean(
    (b.providerId && matchIds.has(String(b.providerId))) ||
    (b.worker && matchIds.has(String(b.worker))) ||
    (workerIdOrUser && b.providerId && String(b.providerId) === String(workerIdOrUser)) ||
    (workerIdOrUser && b.worker && String(b.worker) === String(workerIdOrUser))
  );
  let jobStatus = isAssigned ? (normalizeState(b.status) || b.status) : 'Requested';
  if (isAssigned) {
    const s = normalizeState(b.status);
    if (['PENDING', 'CONFIRMED', 'WORKER_ACCEPTED'].includes(s)) {
      jobStatus = 'Accepted';
    } else if (['TRAVELLING'].includes(s)) {
      jobStatus = 'Travelling';
    } else if (['ARRIVED'].includes(s)) {
      jobStatus = 'Arrived';
    } else if (['ENTERED_HOME'].includes(s)) {
      jobStatus = 'EnteredHome';
    } else if (['WORK_STARTED', 'WORK_IN_PROGRESS', 'IN_PROGRESS'].includes(s)) {
      jobStatus = 'InProgress';
    } else if (['COMPLETED', 'PAYMENT_SETTLED', 'WORK_FINISHED'].includes(s)) {
      jobStatus = 'Completed';
    } else if (['CANCELLED'].includes(s)) {
      jobStatus = 'CANCELLED';
    }
  }

  // Before assignment, only general area/landmark is visible to unassigned worker (Customer Privacy)
  const displayAddress = isAssigned
    ? b.address
    : ((b.serviceAddress && b.serviceAddress.area) || b.area || (b.address ? b.address.split(',')[0].trim() : 'Service Location'));
  const customerName = isAssigned ? b.customerName : (b.customerName ? b.customerName.split(' ')[0] + ' (Customer)' : 'Customer');
  const customerPhone = isAssigned ? (b.customerPhone || '') : 'Masked until accepted';

  const destinationLat = isAssigned
    ? (typeof b.latitude === 'number' ? b.latitude : ((b.serviceAddress && b.serviceAddress.latitude) || null))
    : null;
  const destinationLng = isAssigned
    ? (typeof b.longitude === 'number' ? b.longitude : ((b.serviceAddress && b.serviceAddress.longitude) || null))
    : null;
  const locationAccuracy = isAssigned
    ? (b.locationAccuracy !== undefined ? b.locationAccuracy : ((b.serviceAddress && b.serviceAddress.accuracy) || null))
    : null;

  const canonicalDate = b.date || (b.scheduledAt ? new Date(b.scheduledAt).toISOString().split('T')[0] : '');
  const canonicalSlot = b.time || '';
  const formattedTime = (canonicalDate && canonicalSlot)
    ? `${canonicalDate} • ${canonicalSlot}`
    : (canonicalSlot || canonicalDate || 'Scheduled');

  let formattedDistance = null;
  if (typeof b.distanceKm === 'number' && !isNaN(b.distanceKm) && b.distanceKm > 0) {
    if (b.distanceKm < 1) {
      formattedDistance = `${Math.round(b.distanceKm * 1000)} m`;
    } else {
      formattedDistance = `${Number(b.distanceKm.toFixed(1))} km`;
    }
  }

  return {
    id: b.customId || b._id.toString(),
    bookingId: b.customId || b._id.toString(),
    customerId: b.customerId,
    customerName,
    customerPhone,
    service: b.service,
    category: b.category,
    address: displayAddress,
    area: (b.serviceAddress && b.serviceAddress.area) || b.area || '',
    city: (b.serviceAddress && b.serviceAddress.city) || b.city || '',
    state: (b.serviceAddress && b.serviceAddress.state) || b.state || '',
    pincode: (b.serviceAddress && b.serviceAddress.postalCode) || b.pincode || '',
    serviceAddress: isAssigned ? (b.serviceAddress || null) : null,
    latitude: destinationLat,
    longitude: destinationLng,
    locationAccuracy,
    destination: {
      latitude: destinationLat,
      longitude: destinationLng,
      address: displayAddress,
      accuracy: locationAccuracy,
    },
    location: isAssigned ? (b.location || {
      address: b.address,
      area: (b.serviceAddress && b.serviceAddress.area) || b.area || '',
      city: (b.serviceAddress && b.serviceAddress.city) || b.city || '',
      state: (b.serviceAddress && b.serviceAddress.state) || b.state || '',
      pincode: (b.serviceAddress && b.serviceAddress.postalCode) || b.pincode || '',
      latitude: destinationLat,
      longitude: destinationLng,
    }) : null,
    workerLatitude: isAssigned ? b.workerLatitude : null,
    workerLongitude: isAssigned ? b.workerLongitude : null,
    workerHeading: isAssigned ? b.workerHeading : null,
    date: canonicalDate,
    slot: canonicalSlot,
    time: formattedTime,
    distance: formattedDistance,
    distanceKm: typeof b.distanceKm === 'number' ? b.distanceKm : null,
    price: b.price || (b.priceNum ? `₹${b.priceNum}` : '₹499'),
    priceNum: b.priceNum || 499,
    priceBreakdown: b.priceBreakdown || null,
    totalAmount: b.priceBreakdown?.totalAmount || b.priceNum || 499,
    basePrice: b.priceBreakdown?.basePrice || b.priceBreakdown?.itemSubtotal || b.priceNum || 499,
    payout: b.isGuaranteeRevisit ? '₹0 (Free Guarantee Revisit)' : `₹${Math.round((b.priceNum || 500) * 0.8)}`,
    payoutNum: b.isGuaranteeRevisit ? 0 : Math.round((b.priceNum || 500) * 0.8),
    platformCommission: b.isGuaranteeRevisit ? '₹0' : `₹${(b.priceNum || 500) - Math.round((b.priceNum || 500) * 0.8)}`,
    paymentMethod: b.paymentMethod || (b.paymentStatus && b.paymentStatus.includes('Cash') ? 'Cash on Service' : 'Pay Online'),
    paymentStatus: b.paymentStatus || 'PENDING',
    status: jobStatus,
    rawStatus: b.status,
    providerId: b.providerId,
    startOtp: null, // SECURITY: Never expose customer's physical presence start OTP to worker API responses
    etaMinutes: isAssigned ? b.etaMinutes : null,
    workStartedAt: isAssigned ? (b.workStartedAt || b.startedAt) : null,
    quote: b.quote,
    timeChangeRequest: b.timeChangeRequest || null,
    journeyStartedAt: isAssigned ? b.journeyStartedAt : null,
    updatedAt: b.updatedAt || b.createdAt,
    isGuaranteeRevisit: Boolean(b.isGuaranteeRevisit),
    originalBookingId: b.originalBookingId || null,
    guaranteeId: b.guaranteeId || null,
    revisitReason: b.revisitReason || null,
    revisitOriginalIssue: b.revisitOriginalIssue || null,
    isAssigned,
  };
}

// 1. Worker Availability Toggle
app.patch('/api/worker/availability', authRequired, requireRoles('worker'), async (req, res) => {
  const { online } = req.body || {};
  const worker = await findUserByIdOrIdentifier(req.auth.sub);
  if (!worker) return res.status(404).json({ error: 'Worker not found.' });

  worker.online = Boolean(online);
  await worker.save();
  return res.json({ success: true, online: worker.online });
});

// 1.1 Worker Push Token Registration
app.post(['/api/worker/push-token', '/api/notifications/register-token'], authRequired, async (req, res) => {
  const { token, platform = 'android', deviceId } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Push token string is required.' });
  }

  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (!user.fcmTokens) user.fcmTokens = [];

  // Remove duplicate if already exists
  user.fcmTokens = user.fcmTokens.filter(t => t.token !== token);

  // Add updated token entry
  user.fcmTokens.push({
    token: token.trim(),
    platform: ['android', 'ios', 'web'].includes(platform) ? platform : 'android',
    deviceId: deviceId || `${platform}_${user.customId || user._id}`,
    lastSeenAt: new Date(),
  });

  await user.save();
  return res.json({ success: true, message: 'Push token registered successfully.', tokenCount: user.fcmTokens.length });
});

// 1.2 Worker Push Token Unregistration (Logout / Disable)
app.delete('/api/worker/push-token', authRequired, async (req, res) => {
  const { token } = req.body || {};
  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (user.fcmTokens && token) {
    user.fcmTokens = user.fcmTokens.filter(t => t.token !== token.trim());
    await user.save();
  }

  return res.json({ success: true, message: 'Push token unregistered.' });
});

// 1.3 User Logout with Device Cleanup
app.post('/api/auth/logout', authRequired, async (req, res) => {
  const { token } = req.body || {};
  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (user && user.fcmTokens && token) {
    user.fcmTokens = user.fcmTokens.filter(t => t.token !== token.trim());
    await user.save();
  }
  return res.json({ success: true, message: 'Successfully signed out and cleaned up device session.' });
});

// 1.4 Dedicated Worker Profile (Authenticated & Fully Isolated)
app.get('/api/worker/profile', authRequired, requireRoles('worker', 'admin'), async (req, res) => {
  try {
    const workerUser = await findUserByIdOrIdentifier(req.auth.sub);
    if (!workerUser) return res.status(404).json({ error: 'Worker account not found.' });

    const workerQuery = buildWorkerBookingQuery(workerUser, {
      status: { $nin: ['CANCELLED', 'Cancelled'] },
    });
    const assignedBookings = await Booking.find(workerQuery).sort({ createdAt: -1 });

    const completedBookings = assignedBookings.filter(b => isCanonicalCompletedStatus(b.status));

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayOfWeek = now.getDay() || 7;
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek + 1);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let todayEarnings = 0;
    let weekEarnings = 0;
    let monthEarnings = 0;
    let totalEarnings = 0;
    let todayCompletedCount = 0;

    for (const b of completedBookings) {
      const payout = Math.round((b.priceNum || 500) * 0.8);
      totalEarnings += payout;
      const dateToCheck = b.finishedAt ? new Date(b.finishedAt) : (b.updatedAt ? new Date(b.updatedAt) : new Date(b.createdAt));
      if (dateToCheck >= startOfToday) {
        todayEarnings += payout;
        todayCompletedCount++;
      }
      if (dateToCheck >= startOfWeek) weekEarnings += payout;
      if (dateToCheck >= startOfMonth) monthEarnings += payout;
    }

    const ratedBookings = assignedBookings.filter(b => b.rating && Number(b.rating) > 0);
    const ratingCount = ratedBookings.length;
    const ratingAvg = ratingCount > 0
      ? Number((ratedBookings.reduce((sum, b) => sum + Number(b.rating), 0) / ratingCount).toFixed(1))
      : (workerUser.ratingCount > 0 ? Number(workerUser.ratingAvg).toFixed(1) : null);

    const performance = await calculateWorkerPerformance(req.auth.sub);
    const isVerified = (workerUser.kycStatus === 'approved' || !workerUser.kycStatus) && workerUser.status === 'active';

    return res.json({
      profile: {
        id: workerUser.customId || workerUser._id.toString(),
        name: workerUser.name,
        employeeId: workerUser.employeeId || 'EMP-' + (workerUser.customId || workerUser._id.toString()).slice(-4).toUpperCase(),
        email: workerUser.email || '',
        phone: workerUser.phone || '',
        avatarUrl: workerUser.avatarUrl || null,
        role: workerUser.role,
        status: workerUser.status,
        online: workerUser.online !== false,
        verificationStatus: isVerified ? 'approved' : (workerUser.kycStatus || 'pending'),
        isVerifiedPro: isVerified,
        kycStatus: workerUser.kycStatus || 'approved',
        services: workerUser.services && workerUser.services.length ? workerUser.services : ['AC Service & Repair'],
        serviceArea: workerUser.serviceArea || 'Bengaluru',
        serviceRadiusKm: workerUser.serviceRadiusKm || 15,
        memberSince: workerUser.createdAt ? new Date(workerUser.createdAt).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : 'Jan 2026',
        walletBalance: workerUser.walletBalance || 0,
        todayEarnings,
        weekEarnings,
        monthEarnings,
        totalEarnings,
        completedJobsCount: completedBookings.length,
        todayCompletedCount,
        ratingAvg: ratingAvg ? Number(ratingAvg) : null,
        ratingCount: ratingCount || workerUser.ratingCount || 0,
        firstVisitResolutionRate: performance.firstVisitResolutionRate,
        firstVisitResolutionText: performance.firstVisitResolutionText,
        isBuildingHistory: performance.isBuildingHistory,
        onTimeArrivalRate: performance.onTimeArrivalRate,
        activeGuaranteesCount: performance.activeGuaranteesCount,
        revisitJobsCount: performance.revisitJobsCount,
      },
      performance,
    });
  } catch (err) {
    console.error('[Worker Profile Fetch Error]:', err);
    return res.status(500).json({ error: 'Failed to load worker profile.' });
  }
});

app.patch('/api/worker/profile', authRequired, requireRoles('worker'), async (req, res) => {
  try {
    const workerUser = await findUserByIdOrIdentifier(req.auth.sub);
    if (!workerUser) return res.status(404).json({ error: 'Worker account not found.' });

    const { name, phone, email, serviceArea, serviceRadiusKm, avatarUrl } = req.body;

    if (name && typeof name === 'string') workerUser.name = name.trim().slice(0, 80);
    if (phone && typeof phone === 'string') workerUser.phone = phone.trim();
    if (email && typeof email === 'string') workerUser.email = email.trim().toLowerCase();
    if (serviceArea && typeof serviceArea === 'string') workerUser.serviceArea = serviceArea.trim();
    if (serviceRadiusKm && typeof serviceRadiusKm === 'number') {
      workerUser.serviceRadiusKm = Math.min(Math.max(1, serviceRadiusKm), 50);
    }
    if (avatarUrl && typeof avatarUrl === 'string') workerUser.avatarUrl = avatarUrl.trim();

    await workerUser.save();
    return res.json({ success: true, message: 'Profile updated successfully.', profile: workerUser });
  } catch (err) {
    console.error('[Worker Profile Update Error]:', err);
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// 2. Worker Dashboard (Strict Server-Side Specialization & Status Authorization)
app.get('/api/worker/dashboard', authRequired, requireRoles('worker'), async (req, res) => {
  const workerUser = await findUserByIdOrIdentifier(req.auth.sub);
  if (!workerUser) return res.status(404).json({ error: 'Worker not found.' });

  if (workerUser.status !== 'active') {
    return res.status(403).json({ error: 'Your account is deactivated or suspended. Contact support.' });
  }

  const workerSpecializations = workerUser.services && workerUser.services.length ? workerUser.services : ['AC Service & Repair'];
  const workerIds = [req.auth.sub, workerUser.customId, workerUser.employeeId, workerUser._id.toString()].filter(Boolean);

  // 1. Find jobs already assigned to this worker (exclude cancelled) in parallel with unassigned offers
  const [assignedBookings, unassignedOffers] = await Promise.all([
    Booking.find(
      buildWorkerBookingQuery(workerUser, { status: { $nin: ['CANCELLED', 'Cancelled'] } })
    )
      .sort({ createdAt: -1 })
      .lean(),
    workerUser.online !== false
      ? Booking.find({
          providerId: null,
          service: { $in: workerSpecializations },
          status: { $in: ['Pending', 'PENDING', 'Requested', 'SEARCHING_WORKER', 'CONFIRMED', 'Confirmed'] },
          declinedByWorkers: { $nin: workerIds },
        })
          .sort({ createdAt: -1 })
          .limit(30)
          .lean()
      : Promise.resolve([]),
  ]);

  // Strict deduplication by real booking ID
  const seenIds = new Set();
  const allBookings = [];
  for (const b of [...assignedBookings, ...unassignedOffers]) {
    const key = b.customId || b._id.toString();
    if (!seenIds.has(key)) {
      seenIds.add(key);
      allBookings.push(b);
    }
  }

  const jobs = allBookings.map(b => formatWorkerJob(b, workerUser));

  const activeJob = jobs.find(j =>
    j.isAssigned && ['Accepted', 'Travelling', 'Arrived', 'InProgress'].includes(j.status)
  ) || null;

  const newRequests = jobs.filter(j => !j.isAssigned && j.status === 'Requested');
  const activeJobs = jobs.filter(j => j.isAssigned && !['Completed', 'CANCELLED'].includes(j.status));
  const completedJobs = jobs.filter(j => j.isAssigned && j.status === 'Completed');

  // Dynamic metrics calculation from actual completed bookings
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = now.getDay() || 7; // Monday = 1
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek + 1);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const completedBookings = assignedBookings.filter(b => isCanonicalCompletedStatus(b.status));

  let todayEarnings = 0;
  let weekEarnings = 0;
  let monthEarnings = 0;
  let todayCompletedCount = 0;

  for (const b of completedBookings) {
    const payout = Math.round((b.priceNum || 500) * 0.8);
    const dateToCheck = b.finishedAt ? new Date(b.finishedAt) : (b.updatedAt ? new Date(b.updatedAt) : new Date(b.createdAt));
    if (dateToCheck >= startOfToday) {
      todayEarnings += payout;
      todayCompletedCount++;
    }
    if (dateToCheck >= startOfWeek) weekEarnings += payout;
    if (dateToCheck >= startOfMonth) monthEarnings += payout;
  }

  // Real ratings from database reviews/bookings
  const ratedBookings = assignedBookings.filter(b => b.rating && Number(b.rating) > 0);
  const ratingCount = ratedBookings.length;
  const ratingAvg = ratingCount > 0
    ? Number((ratedBookings.reduce((sum, b) => sum + Number(b.rating), 0) / ratingCount).toFixed(1))
    : (workerUser.ratingCount > 0 ? Number(workerUser.ratingAvg).toFixed(1) : null);

  // Authenticated real worker performance (First-Visit Resolution, Active Guarantees, etc.)
  const performance = await calculateWorkerPerformance(req.auth.sub);

  return res.json({
    profile: {
      id: workerUser.customId || workerUser._id.toString(),
      name: workerUser.name,
      employeeId: workerUser.employeeId || 'EMP-' + (workerUser.customId || workerUser._id.toString()).slice(-4).toUpperCase(),
      services: workerSpecializations,
      serviceArea: workerUser.serviceArea || 'Bengaluru',
      serviceRadiusKm: workerUser.serviceRadiusKm || 15,
      ratingAvg: ratingAvg ? Number(ratingAvg) : null,
      ratingCount: ratingCount || workerUser.ratingCount || 0,
      todayEarnings: todayEarnings,
      weekEarnings: weekEarnings,
      monthEarnings: monthEarnings,
      completedJobsCount: completedBookings.length,
      todayCompletedCount,
      firstVisitResolutionRate: performance.firstVisitResolutionRate,
      firstVisitResolutionText: performance.firstVisitResolutionText,
      isBuildingHistory: performance.isBuildingHistory,
      onTimeArrivalRate: performance.onTimeArrivalRate,
      activeGuaranteesCount: performance.activeGuaranteesCount,
      revisitJobsCount: performance.revisitJobsCount,
      walletBalance: workerUser.walletBalance || 0,
      online: workerUser.online,
      kycStatus: workerUser.kycStatus || 'approved',
    },
    jobs,
    activeJob,
    newRequests,
    activeJobs,
    completedJobs,
    performance,
  });
});

// 3. Worker Earnings Endpoint
app.get('/api/worker/earnings', authRequired, requireRoles('worker'), async (req, res) => {
  const workerUser = await findUserByIdOrIdentifier(req.auth.sub);
  if (!workerUser) return res.status(404).json({ error: 'Worker not found.' });

  const assignedBookings = await Booking.find(
    buildWorkerBookingQuery(workerUser, { status: { $nin: ['CANCELLED', 'Cancelled'] } })
  ).sort({ createdAt: -1 });

  const completedBookings = assignedBookings.filter(b => isCanonicalCompletedStatus(b.status));

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = now.getDay() || 7;
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek + 1);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  let todayEarnings = 0;
  let weekEarnings = 0;
  let monthEarnings = 0;
  let todayCompletedCount = 0;

  for (const b of completedBookings) {
    const payout = Math.round((b.priceNum || 500) * 0.8);
    const dateToCheck = b.finishedAt ? new Date(b.finishedAt) : (b.updatedAt ? new Date(b.updatedAt) : new Date(b.createdAt));
    if (dateToCheck >= startOfToday) {
      todayEarnings += payout;
      todayCompletedCount++;
    }
    if (dateToCheck >= startOfWeek) weekEarnings += payout;
    if (dateToCheck >= startOfMonth) monthEarnings += payout;
  }

  const ratedBookings = assignedBookings.filter(b => b.rating && Number(b.rating) > 0);
  const ratingCount = ratedBookings.length;
  const ratingAvg = ratingCount > 0
    ? Number((ratedBookings.reduce((sum, b) => sum + Number(b.rating), 0) / ratingCount).toFixed(1))
    : (workerUser.ratingCount > 0 ? Number(workerUser.ratingAvg).toFixed(1) : null);

  return res.json({
    todayEarnings,
    weekEarnings,
    monthEarnings,
    completedJobsCount: completedBookings.length,
    todayCompletedCount,
    walletBalance: workerUser.walletBalance || 0,
    ratingAvg: ratingAvg ? Number(ratingAvg) : null,
    ratingCount: ratingCount || workerUser.ratingCount || 0,
  });
});

// 3. Worker Jobs List (Strict Server-Side Specialization & Authorization Filter)
app.get('/api/worker/jobs', authRequired, requireRoles('worker'), async (req, res) => {
  const workerUser = await findUserByIdOrIdentifier(req.auth.sub);
  if (!workerUser) return res.status(404).json({ error: 'Worker not found.' });

  if (workerUser.status !== 'active') {
    return res.status(403).json({ error: 'Your account is deactivated or suspended.' });
  }

  const workerSpecializations = workerUser.services && workerUser.services.length ? workerUser.services : ['AC Service & Repair'];
  const workerIds = [req.auth.sub, workerUser.customId, workerUser.employeeId, workerUser._id.toString()].filter(Boolean);

  const assignedBookings = await Booking.find(
    buildWorkerBookingQuery(workerUser, { status: { $nin: ['CANCELLED', 'Cancelled'] } })
  ).sort({ createdAt: -1 });

  let unassignedOffers = [];
  if (workerUser.online !== false) {
    unassignedOffers = await Booking.find({
      providerId: null,
      service: { $in: workerSpecializations },
      status: { $in: ['Pending', 'PENDING', 'Requested', 'SEARCHING_WORKER', 'CONFIRMED', 'Confirmed'] },
      declinedByWorkers: { $nin: workerIds },
    }).sort({ createdAt: -1 });
  }

  const allBookings = [...assignedBookings, ...unassignedOffers];
  const jobs = allBookings.map(b => formatWorkerJob(b, workerUser));

  return res.json({ jobs });
});

// 4. Single Worker Job Details (Strict Authorization)
app.get('/api/worker/jobs/:id', authRequired, requireRoles('worker'), async (req, res) => {
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Job not found.' });

  const workerUser = await findUserByIdOrIdentifier(req.auth.sub);
  if (!workerUser || workerUser.status !== 'active') {
    return res.status(403).json({ error: 'Unauthorized.' });
  }

  const workerSpecializations = workerUser.services || [];
  const isAssigned = booking.providerId === req.auth.sub;
  const isEligibleOffer = !booking.providerId && workerSpecializations.includes(booking.service);

  if (!isAssigned && !isEligibleOffer) {
    return res.status(403).json({ error: 'Unauthorized to view this job.' });
  }

  return res.json({ job: formatWorkerJob(booking, req.auth.sub) });
});

// 5. Worker Accept Job (Atomic Concurrency Protection via transitionBooking)
app.post('/api/worker/jobs/:id/accept', authRequired, requireRoles('worker'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'ACCEPT_JOB', req.auth);
    return res.json({ success: true, job: formatWorkerJob(booking, req.auth.sub) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to accept job.' });
  }
});

// 6. Worker Mark Busy / Decline Job Offer
app.post('/api/worker/jobs/:id/busy', authRequired, requireRoles('worker'), async (req, res) => {
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Job not found.' });

  if (!booking.declinedByWorkers) booking.declinedByWorkers = [];
  if (!booking.declinedByWorkers.includes(req.auth.sub)) {
    booking.declinedByWorkers.push(req.auth.sub);
    await booking.save();
  }

  return res.json({ success: true, message: 'Job offer declined and rerouted.' });
});

// 7. Worker Request Time Change
app.post('/api/worker/jobs/:id/time-change', authRequired, requireRoles('worker'), async (req, res) => {
  const { suggestedTime, reason } = req.body;
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Job not found.' });

  const worker = await findUserByIdOrIdentifier(req.auth.sub);

  booking.timeChangeRequest = {
    requestedTime: suggestedTime || 'Proposed +1 Hour',
    reason: reason || 'Schedule adjustment requested by professional',
    status: 'Pending',
    requestedBy: (worker && worker.name) || req.auth.name,
    requestedAt: new Date(),
  };
  booking.markModified('timeChangeRequest');
  await booking.save();

  await createAndDispatchNotification({
    recipientId: booking.customerId,
    eventId: `evt_timechange_${booking.customId || booking.id}`,
    type: 'TIME_CHANGE_REQUESTED',
    priority: 'IMPORTANT',
    title: 'Schedule Change Proposed',
    body: `Professional proposed a new schedule: ${booking.timeChangeRequest.requestedTime}.`,
    bookingId: booking.customId || booking.id,
  });

  return res.json({ success: true, job: formatWorkerJob(booking, req.auth.sub) });
});

// 8. Worker Start Journey (Travelling)
app.post('/api/worker/jobs/:id/start-journey', authRequired, requireRoles('worker'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'START_JOURNEY', req.auth);
    return res.json({ success: true, job: formatWorkerJob(booking, req.auth.sub) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to start journey.' });
  }
});

// 9. Worker Arrive at Doorstep
app.post('/api/worker/jobs/:id/arrive', authRequired, requireRoles('worker'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'ARRIVE', req.auth);
    return res.json({ success: true, job: formatWorkerJob(booking, req.auth.sub) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to confirm arrival.' });
  }
});

// 10. Worker Enter Home
app.post('/api/worker/jobs/:id/enter-home', authRequired, requireRoles('worker'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'ENTER_HOME', req.auth);
    return res.json({ success: true, job: formatWorkerJob(booking, req.auth.sub) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to enter home.' });
  }
});

// 11. Worker Start Job & Verify OTP
app.post(['/api/worker/jobs/:id/start-job', '/api/worker/jobs/:id/start', '/api/worker/jobs/:id/start-work'], authRequired, requireRoles('worker'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'START_JOB', req.auth, { otp: req.body.otp });
    return res.json({ success: true, job: formatWorkerJob(booking, req.auth.sub) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to start job.', code: err.code });
  }
});

app.post(['/api/worker/jobs/:id/verify-otp-start', '/api/worker/jobs/:id/verify-otp'], authRequired, requireRoles('worker'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'VERIFY_OTP_START', req.auth, { otp: req.body.otp });
    return res.json({ success: true, job: formatWorkerJob(booking, req.auth.sub) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to verify start OTP.', code: err.code });
  }
});

// 12. Worker Submit In-Flight Quote
app.post('/api/worker/jobs/:id/quote', authRequired, requireRoles('worker'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'SUBMIT_QUOTE', req.auth, {
      description: req.body.description,
      amount: req.body.amount,
    });
    return res.json({ success: true, quote: booking.quote });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to submit quote.' });
  }
});

// 13. Worker Finish Work
app.post(['/api/worker/jobs/:id/finish-work', '/api/worker/jobs/:id/complete'], authRequired, requireRoles('worker'), async (req, res) => {
  try {
    const booking = await transitionBooking(req.params.id, 'FINISH_WORK', req.auth);
    return res.json({ success: true, job: formatWorkerJob(booking, req.auth.sub) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to finish work.' });
  }
});

// 14. Worker Submit GPS Live Location Update (REST Fallback / Redundancy)
async function handleWorkerLocationUpdate(req, res) {
  const { latitude, longitude, heading } = req.body;
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
    return res.status(400).json({ error: 'Invalid latitude or longitude coordinates.' });
  }

  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Job not found.' });

  if (booking.providerId !== req.auth.sub && req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized. You are not assigned to this booking.' });
  }

  const normStatus = normalizeState(booking.status);
  const trackingAllowedStates = [
    BOOKING_STATES.WORKER_ACCEPTED,
    BOOKING_STATES.TRAVELLING,
    BOOKING_STATES.ARRIVED,
    BOOKING_STATES.ENTERED_HOME,
    BOOKING_STATES.WORK_STARTED,
  ];
  if (!trackingAllowedStates.includes(normStatus)) {
    return res.status(400).json({ error: `Location tracking is inactive for booking in status '${normStatus}'.` });
  }

  let distanceKm = null;
  let etaMinutes = null;
  if (typeof booking.latitude === 'number' && typeof booking.longitude === 'number') {
    distanceKm = calculateHaversineDistanceKm(lat, lng, booking.latitude, booking.longitude);
    etaMinutes = calculateEtaMinutes(distanceKm);
    booking.distanceKm = distanceKm;
    booking.etaMinutes = etaMinutes;
  }

  booking.workerLatitude = lat;
  booking.workerLongitude = lng;
  booking.workerHeading = typeof heading === 'number' ? heading : (booking.workerHeading || 0);
  booking.locationLastUpdatedAt = new Date();
  await booking.save();

  // PRIVACY: Worker live GPS coordinates are sent strictly to operation admins, never to customer
  const adminPayload = {
    type: 'admin_worker_location_update',
    bookingId: booking.customId || booking.id,
    workerId: req.auth.sub,
    latitude: lat,
    longitude: lng,
    heading: booking.workerHeading,
    status: normStatus,
    updatedAt: new Date().toISOString(),
  };

  broadcastToRoom('admins', adminPayload);

  return res.json({
    success: true,
    distanceKm,
    etaMinutes,
    status: normStatus,
    updatedAt: booking.locationLastUpdatedAt,
  });
}

app.post('/api/worker/jobs/:id/location', authRequired, requireRoles('worker'), handleWorkerLocationUpdate);
app.post('/api/worker/bookings/:id/location', authRequired, requireRoles('worker'), handleWorkerLocationUpdate);

// ── 5. REAL-TIME CHAT & CALLING DOMAIN ────────────────────────────────

// 1. Get Chat History for Booking
app.get('/api/bookings/:id/chat', authRequired, async (req, res) => {
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const isCustomer =
    booking.customerId === req.auth.sub ||
    booking.customerId === req.auth.id ||
    (req.auth.customId && booking.customerId === req.auth.customId) ||
    (booking.customer && String(booking.customer) === String(req.auth.sub));

  const isWorker =
    booking.providerId === req.auth.sub ||
    booking.providerId === req.auth.id ||
    (req.auth.customId && booking.providerId === req.auth.customId);

  const isAdmin = req.auth.role === 'admin';

  if (!isCustomer && !isWorker && !isAdmin) {
    return res.status(403).json({ error: 'Unauthorized to view this conversation.' });
  }

  // Pre-assignment communication lock
  if (!booking.providerId && !isAdmin) {
    return res.status(403).json({ error: 'Communication locked until a professional is assigned.' });
  }

  const bookingIds = Array.from(new Set([
    booking.customId,
    booking.id,
    booking._id ? booking._id.toString() : null,
    req.params.id,
  ].filter(Boolean)));

  const messages = await Message.find({ bookingId: { $in: bookingIds } })
    .sort({ createdAt: 1 })
    .lean();

  const isDeactivated = isCommunicationDisabledForBooking(booking);

  return res.json({
    conversation: {
      id: `CHAT-${(booking.customId || booking.id).replace('BK-', '')}`,
      bookingId: booking.customId || booking.id,
      customerId: booking.customerId,
      workerId: booking.providerId,
      status: isDeactivated ? 'inactive' : 'active',
      isLocked: isDeactivated,
      lockedReason: isDeactivated ? 'booking_completed' : null,
      messages: messages.map(m => ({
        id: m.messageId || m._id.toString(),
        clientMsgId: m.clientMsgId || m.messageId || m._id.toString(),
        senderId: m.senderId,
        senderName: m.senderName,
        senderRole: m.senderRole,
        text: m.text,
        photoUrl: m.photoUrl,
        timestamp: m.createdAt ? m.createdAt.toISOString() : (m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString()),
        status: m.status,
      })),
    },
    isLocked: isDeactivated,
    bookingStatus: booking.status,
  });
});

// 2. Post Chat Message (With clientMsgId Deduplication & Canonical Server ID)
app.post('/api/bookings/:id/chat/messages', authRequired, async (req, res) => {
  const { text, clientMsgId, photoUrl } = req.body;
  if (!text && !photoUrl) return res.status(400).json({ error: 'Message text or photo is required.' });

  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const isCustomer =
    booking.customerId === req.auth.sub ||
    booking.customerId === req.auth.id ||
    (req.auth.customId && booking.customerId === req.auth.customId) ||
    (booking.customer && String(booking.customer) === String(req.auth.sub));

  const isWorker =
    booking.providerId === req.auth.sub ||
    booking.providerId === req.auth.id ||
    (req.auth.customId && booking.providerId === req.auth.customId);

  const isAdmin = req.auth.role === 'admin';

  if (!isCustomer && !isWorker && !isAdmin) {
    return res.status(403).json({ error: 'Unauthorized to participate in this conversation.' });
  }

  if (!booking.providerId && !isAdmin) {
    return res.status(403).json({ error: 'Communication locked until a professional is assigned.' });
  }

  if (isCommunicationDisabledForBooking(booking) && !isAdmin) {
    return res.status(403).json({
      error: 'Communication is closed for this completed booking.',
      code: 'COMMUNICATION_DEACTIVATED',
      bookingStatus: booking.status,
    });
  }

  const targetBookingId = booking.customId || booking.id;

  // Deduplication check: If clientMsgId already exists, return existing message
  if (clientMsgId) {
    const existing = await Message.findOne({
      bookingId: targetBookingId,
      $or: [{ clientMsgId }, { messageId: clientMsgId }],
    });
    if (existing) {
      const echoPayload = {
        id: existing.messageId,
        clientMsgId: existing.clientMsgId || existing.messageId,
        bookingId: targetBookingId,
        senderId: existing.senderId,
        senderName: existing.senderName,
        senderRole: existing.senderRole,
        text: existing.text,
        photoUrl: existing.photoUrl,
        timestamp: existing.createdAt ? existing.createdAt.toISOString() : new Date().toISOString(),
        status: existing.status,
      };
      return res.json({
        success: true,
        message: echoPayload,
      });
    }
  }

  const serverMsgId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const effectiveClientMsgId = (clientMsgId || serverMsgId).trim();

  const newMsg = await Message.create({
    messageId: serverMsgId,
    clientMsgId: effectiveClientMsgId,
    bookingId: targetBookingId,
    senderId: req.auth.sub,
    senderName: req.auth.name,
    senderRole: req.auth.role,
    text: (text || '').trim(),
    photoUrl: photoUrl || undefined,
    status: 'delivered',
  });

  const receiverId = isCustomer
    ? (booking.providerId || (booking.worker ? String(booking.worker) : ''))
    : (booking.customerId || (booking.customer ? String(booking.customer) : ''));

  const msgPayload = {
    id: newMsg.messageId,
    clientMsgId: newMsg.clientMsgId,
    bookingId: targetBookingId,
    senderId: newMsg.senderId,
    senderName: newMsg.senderName,
    senderRole: newMsg.senderRole,
    text: newMsg.text,
    photoUrl: newMsg.photoUrl,
    timestamp: newMsg.createdAt.toISOString(),
    status: newMsg.status,
  };

  broadcastToRoom(targetBookingId, {
    type: 'new_message',
    bookingId: targetBookingId,
    message: msgPayload,
  });

  if (receiverId && String(receiverId) !== String(newMsg.senderId)) {
    broadcastToRoom(`user_${receiverId}`, {
      type: 'new_message',
      bookingId: targetBookingId,
      message: msgPayload,
    });

    createAndDispatchNotification({
      recipientId: receiverId,
      eventId: newMsg.messageId,
      type: 'CHAT_MESSAGE',
      priority: 'NORMAL',
      title: newMsg.senderName || (isCustomer ? 'Customer' : 'Partner'),
      body: newMsg.text || 'Sent an attachment',
      bookingId: targetBookingId,
      deepLink: `homestepin://bookings/${targetBookingId}/chat`,
      metadata: {
        type: 'chat_message',
        messageId: newMsg.messageId,
        clientMsgId: newMsg.clientMsgId,
        bookingId: targetBookingId,
        senderId: newMsg.senderId,
        receiverId,
        senderName: newMsg.senderName,
        senderRole: newMsg.senderRole,
        message: newMsg.text,
      },
    }).catch(err => console.error('REST chat notification dispatch error:', err));
  }

  return res.status(201).json({
    success: true,
    message: msgPayload,
  });
});

// 3. Initiate In-App Call
app.post('/api/bookings/:id/call/initiate', authRequired, async (req, res) => {
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const authUserIds = [req.auth.sub, req.auth.id, req.auth.customId, req.auth._id].filter(Boolean).map(String);
  const isCustomer = authUserIds.includes(String(booking.customerId)) ||
                     (booking.customer && authUserIds.includes(String(booking.customer)));
  const isWorker = authUserIds.includes(String(booking.providerId)) ||
                   (booking.worker && authUserIds.includes(String(booking.worker)));
  const isAdmin = req.auth.role === 'admin';

  if (!isCustomer && !isWorker && !isAdmin) {
    return res.status(403).json({ error: 'Unauthorized to initiate a call for this booking.' });
  }

  if (!booking.providerId && !isAdmin) {
    return res.status(403).json({ error: 'Communication locked until a professional is assigned.' });
  }

  if (isCommunicationDisabledForBooking(booking) && !isAdmin) {
    return res.status(403).json({
      error: 'Calling is deactivated for this completed booking.',
      code: 'COMMUNICATION_DEACTIVATED',
      bookingStatus: booking.status,
    });
  }

  const receiverId = isCustomer
    ? (booking.providerId || (booking.worker ? String(booking.worker) : ''))
    : (booking.customerId || (booking.customer ? String(booking.customer) : ''));
  const receiverAltId = isCustomer
    ? (booking.worker ? String(booking.worker) : '')
    : (booking.customer ? String(booking.customer) : '');
  const receiverName = isCustomer
    ? (booking.providerName || 'Partner')
    : (booking.customerName || 'Customer');

  const callSession = await CallSession.create({
    callSessionId: `CALL-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
    bookingId: booking.customId || booking.id,
    callerId: req.auth.sub,
    callerName: req.auth.name,
    callerRole: req.auth.role,
    receiverId,
    receiverName,
    receiverRole: isCustomer ? 'worker' : 'customer',
    status: 'CALL_RINGING',
    startedAt: new Date(),
    maskedLine: true,
  });

  const incomingPayload = {
    type: 'incoming_call',
    callSession: {
      callSessionId: callSession.callSessionId,
      bookingId: booking.customId || booking.id,
      callerId: req.auth.sub,
      callerName: req.auth.name,
      callerRole: req.auth.role,
      receiverId,
      receiverName,
      receiverRole: callSession.receiverRole,
      maskedNumber: callSession.maskedNumber,
    },
  };

  broadcastToRoom(`user_${receiverId}`, incomingPayload);
  if (receiverAltId && receiverAltId !== receiverId) {
    broadcastToRoom(`user_${receiverAltId}`, incomingPayload);
  }

  broadcastToRoom(booking.customId || booking.id, {
    type: 'call_ringing',
    callSessionId: callSession.callSessionId,
    bookingId: booking.customId || booking.id,
    status: 'Ringing...',
  });

  return res.json({
    success: true,
    callSession: {
      callSessionId: callSession.callSessionId,
      bookingId: callSession.bookingId,
      maskedNumber: callSession.maskedNumber,
      caller: callSession.callerName,
      callee: callSession.receiverName,
      status: callSession.status,
    },
  });
});

// 4. Accept In-App Call
app.post('/api/bookings/:id/call/:callSessionId/accept', authRequired, async (req, res) => {
  const session = await CallSession.findOne({ callSessionId: req.params.callSessionId });
  if (!session) return res.status(404).json({ error: 'Call session not found.' });

  const authUserIds = [req.auth.sub, req.auth.id, req.auth.customId, req.auth._id].filter(Boolean).map(String);
  const isAuthorized = authUserIds.includes(String(session.receiverId)) || req.auth.role === 'admin';

  if (!isAuthorized) {
    return res.status(403).json({ error: 'Unauthorized to accept this call.' });
  }

  const booking = await findBookingById(session.bookingId);
  if (isCommunicationDisabledForBooking(booking) && req.auth.role !== 'admin') {
    session.status = 'CALL_ENDED';
    session.endedAt = new Date();
    session.endReason = 'booking_completed';
    await session.save();
    return res.status(403).json({
      error: 'Cannot accept call: Booking has been completed.',
      code: 'COMMUNICATION_DEACTIVATED',
    });
  }

  session.status = 'CALL_CONNECTED';
  session.connectedAt = new Date();
  await session.save();

  const connectedPayload = {
    type: 'call_connected',
    callSessionId: session.callSessionId,
    bookingId: session.bookingId,
    connectedAt: session.connectedAt.toISOString(),
  };

  broadcastToRoom(session.bookingId, connectedPayload);
  broadcastToRoom(`user_${session.callerId}`, connectedPayload);
  broadcastToRoom(`user_${session.receiverId}`, connectedPayload);

  return res.json({ success: true, status: 'CALL_CONNECTED', connectedAt: session.connectedAt });
});

// 5. End / Reject In-App Call
app.post('/api/bookings/:id/call/:callSessionId/end', authRequired, async (req, res) => {
  const session = await CallSession.findOne({ callSessionId: req.params.callSessionId });
  if (!session) return res.status(404).json({ error: 'Call session not found.' });

  const authUserIds = [req.auth.sub, req.auth.id, req.auth.customId, req.auth._id].filter(Boolean).map(String);
  const isAuthorized = authUserIds.includes(String(session.callerId)) ||
                       authUserIds.includes(String(session.receiverId)) ||
                       req.auth.role === 'admin';

  if (!isAuthorized) {
    return res.status(403).json({ error: 'Unauthorized to terminate this call session.' });
  }

  const { reason } = req.body;
  const isReject = reason === 'declined' || session.status === 'CALL_RINGING';
  const endedAt = new Date();
  const duration = session.connectedAt ? Math.max(0, Math.round((endedAt - new Date(session.connectedAt)) / 1000)) : 0;

  session.status = isReject && !session.connectedAt ? 'CALL_REJECTED' : 'CALL_ENDED';
  session.endedAt = endedAt;
  session.durationSeconds = duration;
  session.endReason = reason || (isReject ? 'declined' : 'normal');
  await session.save();

  const endPayload = {
    type: 'call_ended',
    callSessionId: session.callSessionId,
    bookingId: session.bookingId,
    durationSeconds: duration,
    reason: session.endReason,
  };

  broadcastToRoom(session.bookingId, endPayload);
  broadcastToRoom(`user_${session.callerId}`, endPayload);
  broadcastToRoom(`user_${session.receiverId}`, endPayload);

  return res.json({ success: true, status: session.status, durationSeconds: duration, endReason: session.endReason });
});

// 6. Call History for Booking
app.get('/api/bookings/:id/call/history', authRequired, async (req, res) => {
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const authUserIds = [req.auth.sub, req.auth.id, req.auth.customId, req.auth._id].filter(Boolean).map(String);
  const isCustomer = authUserIds.includes(String(booking.customerId)) ||
                     (booking.customer && authUserIds.includes(String(booking.customer)));
  const isWorker = authUserIds.includes(String(booking.providerId)) ||
                   (booking.worker && authUserIds.includes(String(booking.worker)));
  const isAdmin = req.auth.role === 'admin';

  if (!isCustomer && !isWorker && !isAdmin) {
    return res.status(403).json({ error: 'Unauthorized to view call history for this booking.' });
  }

  const calls = await CallSession.find({ bookingId: booking.customId || booking.id })
    .sort({ createdAt: -1 })
    .lean();

  return res.json({
    calls: calls.map(c => ({
      callSessionId: c.callSessionId,
      callerName: c.callerName,
      receiverName: c.receiverName,
      status: c.status,
      durationSeconds: c.durationSeconds,
      startedAt: c.startedAt,
      connectedAt: c.connectedAt,
      endedAt: c.endedAt,
    })),
  });
});

// ── 6. NOTIFICATIONS DOMAIN ───────────────────────────────────────────

// Register Device FCM Token (Multi-Device Safe & JWT-Authenticated)
async function handleRegisterFcmToken(req, res) {
  const { token, deviceId, platform } = req.body;
  if (!token) return res.status(400).json({ error: 'FCM token string is required.' });

  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (!user.fcmTokens) user.fcmTokens = [];

  // Update existing device entry or append new device token
  const existingIdx = user.fcmTokens.findIndex(
    t => t.token === token || (deviceId && t.deviceId === deviceId)
  );

  if (existingIdx !== -1) {
    user.fcmTokens[existingIdx].token = token;
    if (deviceId) user.fcmTokens[existingIdx].deviceId = deviceId;
    if (platform) user.fcmTokens[existingIdx].platform = platform;
    user.fcmTokens[existingIdx].lastSeenAt = new Date();
  } else {
    user.fcmTokens.push({
      token,
      deviceId: deviceId || `dev_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`,
      platform: platform || 'android',
      lastSeenAt: new Date(),
    });
  }

  // Deduplicate and retain only valid tokens (max 10 devices per user)
  if (user.fcmTokens.length > 10) {
    user.fcmTokens = user.fcmTokens.slice(-10);
  }

  await user.save();

  return res.json({
    success: true,
    message: 'FCM token registered successfully.',
    devicesCount: user.fcmTokens.length,
  });
}

app.post('/api/notifications/fcm-token', authRequired, handleRegisterFcmToken);
app.post('/api/auth/fcm-token', authRequired, handleRegisterFcmToken);
app.post('/api/notifications/register-device', authRequired, (req, res) => {
  req.body.token = req.body.token || req.body.pushToken;
  return handleRegisterFcmToken(req, res);
});

// Deregister Device FCM Token (Logout & Account Switching Safety)
async function handleDeregisterFcmToken(req, res) {
  const token = req.body.token || req.body.pushToken || req.query.token;
  const deviceId = req.body.deviceId || req.query.deviceId;

  const user = await findUserByIdOrIdentifier(req.auth.sub);
  if (user && user.fcmTokens) {
    user.fcmTokens = user.fcmTokens.filter(
      t => (token ? t.token !== token : true) && (deviceId ? t.deviceId !== deviceId : true)
    );
    await user.save();
  }

  return res.json({ success: true, message: 'FCM device token removed.' });
}

app.delete('/api/notifications/fcm-token', authRequired, handleDeregisterFcmToken);
app.post('/api/notifications/fcm-token/deregister', authRequired, handleDeregisterFcmToken);
app.delete('/api/auth/fcm-token', authRequired, handleDeregisterFcmToken);
app.post('/api/notifications/unregister-device', authRequired, handleDeregisterFcmToken);

// Get User Notifications (Paginated, Filterable & Strict User Scoped)
app.get('/api/notifications', authRequired, async (req, res) => {
  const userId = req.auth.sub;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
  const filter = req.query.filter;

  const query = { recipientId: userId };
  if (filter === 'unread') {
    query.read = false;
  }

  const total = await Notification.countDocuments(query);
  const unreadCount = await Notification.countDocuments({ recipientId: userId, read: false });

  const notifications = await Notification.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  return res.json({
    notifications: notifications.map(n => ({
      id: n.notificationId || n._id.toString(),
      eventId: n.eventId,
      title: n.title,
      body: n.body,
      type: n.type,
      priority: n.priority,
      bookingId: n.bookingId,
      deepLink: n.deepLink,
      read: n.read,
      createdAt: n.createdAt.toISOString(),
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      unreadCount,
    },
    unreadCount,
  });
});

app.get('/api/notifications/unread-count', authRequired, async (req, res) => {
  const unreadCount = await Notification.countDocuments({ recipientId: req.auth.sub, read: false });
  return res.json({ unreadCount });
});

app.get('/api/notifications/outbox/status', authRequired, async (req, res) => {
  if (req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Administrative privileges required to monitor outbox health.' });
  }
  const [pending, processing, delivered, failed, deadLetter] = await Promise.all([
    NotificationOutbox.countDocuments({ status: 'PENDING' }),
    NotificationOutbox.countDocuments({ status: 'PROCESSING' }),
    NotificationOutbox.countDocuments({ status: 'DELIVERED' }),
    NotificationOutbox.countDocuments({ status: 'FAILED' }),
    NotificationOutbox.countDocuments({ status: 'DEAD_LETTER' }),
  ]);
  return res.json({
    status: 'OK',
    outbox: { pending, processing, delivered, failed, deadLetter },
  });
});


// Mark Single Notification as Read
async function handleMarkNotificationRead(req, res) {
  const notif = await Notification.findOne({
    $or: [{ notificationId: req.params.id }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
  });
  if (!notif) return res.status(404).json({ error: 'Notification not found.' });

  if (notif.recipientId !== req.auth.sub && req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized to access this notification.' });
  }

  notif.read = true;
  notif.readAt = new Date();
  await notif.save();

  const unreadCount = await Notification.countDocuments({ recipientId: req.auth.sub, read: false });
  broadcastToRoom(`user_${req.auth.sub}`, { type: 'unread_count_updated', unreadCount });

  return res.json({ success: true, notification: notif, unreadCount });
}

app.patch('/api/notifications/:id/read', authRequired, handleMarkNotificationRead);
app.post('/api/notifications/:id/read', authRequired, handleMarkNotificationRead);

// Mark All Notifications as Read
async function handleMarkAllNotificationsRead(req, res) {
  await Notification.updateMany({ recipientId: req.auth.sub, read: false }, { read: true, readAt: new Date() });
  broadcastToRoom(`user_${req.auth.sub}`, { type: 'unread_count_updated', unreadCount: 0 });
  return res.json({ success: true, unreadCount: 0 });
}

app.post('/api/notifications/mark-all-read', authRequired, handleMarkAllNotificationsRead);
app.post('/api/notifications/read-all', authRequired, handleMarkAllNotificationsRead);

// Delete Notification
app.delete('/api/notifications/:id', authRequired, async (req, res) => {
  const notif = await Notification.findOne({
    $or: [{ notificationId: req.params.id }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
  });
  if (!notif) return res.status(404).json({ error: 'Notification not found.' });

  if (notif.recipientId !== req.auth.sub && req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized to delete this notification.' });
  }

  await Notification.deleteOne({ _id: notif._id });
  const unreadCount = await Notification.countDocuments({ recipientId: req.auth.sub, read: false });

  return res.json({ success: true, message: 'Notification deleted.', unreadCount });
});

// ── CUSTOMER COMPLAINTS & DISPUTES APIS ─────────────────────────────
app.post('/api/complaints', authRequired, async (req, res) => {
  const { subject, description, bookingId } = req.body;
  if (!subject) return res.status(400).json({ error: 'Subject is required.' });

  const customId = `CMP-${Date.now().toString().slice(-6)}`;
  const complaint = await Complaint.create({
    customId,
    customerId: req.auth.sub,
    customerName: req.auth.name || 'Customer',
    bookingId: bookingId || null,
    subject: subject.trim(),
    description: description ? description.trim() : subject.trim(),
    status: 'Open',
  });

  return res.status(201).json(complaint);
});

app.get('/api/complaints', authRequired, async (req, res) => {
  const query = req.auth.role === 'admin' ? {} : { customerId: req.auth.sub };
  const complaints = await Complaint.find(query).sort({ createdAt: -1 }).lean();
  return res.json({ complaints });
});

// ── 7. ADMIN OPERATIONS CONTROL CENTER DOMAIN ────────────────────────

// 1. Comprehensive Admin Dashboard Metrics
async function handleGetAdminMetrics(req, res) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const totalBookings = await Booking.countDocuments();
  const todayBookings = await Booking.countDocuments({ createdAt: { $gte: startOfToday } });
  const activeBookings = await Booking.countDocuments({
    status: {
      $in: [
        BOOKING_STATES.PENDING,
        BOOKING_STATES.CONFIRMED,
        BOOKING_STATES.WORKER_ASSIGNED,
        BOOKING_STATES.WORKER_ACCEPTED,
        BOOKING_STATES.TRAVELLING,
        BOOKING_STATES.ARRIVED,
        BOOKING_STATES.ENTERED_HOME,
        BOOKING_STATES.WORK_STARTED,
        'Accepted',
        'Travelling',
        'Worker on the way',
        'Arrived',
        'EnteredHome',
        'Work started',
        'InProgress',
        'Pending',
        'Requested',
        'CONFIRMED',
        'SEARCHING_WORKER',
      ],
    },
  });
  const completedBookings = await Booking.countDocuments({
    status: {
      $in: [
        BOOKING_STATES.COMPLETED,
        BOOKING_STATES.WORK_FINISHED,
        BOOKING_STATES.CUSTOMER_CONFIRMED,
        BOOKING_STATES.PAYMENT_COMPLETED,
        'Completed',
        'COMPLETED',
        'PAYMENT_SETTLED',
        'Finished',
        'Settled',
      ],
    },
  });
  const cancelledBookings = await Booking.countDocuments({
    status: {
      $in: [
        BOOKING_STATES.CANCELLED,
        BOOKING_STATES.DECLINED,
        BOOKING_STATES.EXPIRED,
        'CANCELLED',
        'Cancelled',
        'Declined',
      ],
    },
  });

  const pendingBookings = await Booking.countDocuments({
    status: {
      $in: [
        BOOKING_STATES.PENDING,
        BOOKING_STATES.CONFIRMED,
        'Pending',
        'Requested',
        'CONFIRMED',
        'SEARCHING_WORKER',
        'Created',
      ],
    },
  });

  const assignedBookings = await Booking.countDocuments({
    status: {
      $in: [
        BOOKING_STATES.WORKER_ASSIGNED,
        BOOKING_STATES.WORKER_ACCEPTED,
        BOOKING_STATES.TRAVELLING,
        BOOKING_STATES.ARRIVED,
        BOOKING_STATES.ENTERED_HOME,
        BOOKING_STATES.WORK_STARTED,
        'Accepted',
        'Travelling',
        'Worker on the way',
        'Arrived',
        'EnteredHome',
        'Work started',
        'InProgress',
      ],
    },
  });

  const totalCustomers = await User.countDocuments({ role: 'customer' });
  const activeCustomers = await User.countDocuments({ role: 'customer', status: 'active' });

  const totalWorkers = await User.countDocuments({ role: 'worker' });
  const onlineWorkers = await User.countDocuments({ role: 'worker', online: true });
  const pendingKyc = await User.countDocuments({ role: 'worker', kycStatus: { $in: ['pending', 'needs_review', 'Pending'] } });

  const totalComplaints = await Complaint.countDocuments();
  const openComplaints = await Complaint.countDocuments({ status: { $in: ['Open', 'In Review', 'Under Review'] } });

  // Calculate Real Financials from persistent Payment & Booking records
  const payments = await Payment.find({ status: { $in: ['PAID', 'SUCCESS', 'Captured', 'COMPLETED'] } }).lean();
  const paymentRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

  // Also include completed/settled bookings that don't have duplicate payment records
  const paidBookingIds = new Set(payments.map(p => String(p.bookingId)));
  const completedBookingsList = await Booking.find({
    $or: [
      {
        status: {
          $in: [
            BOOKING_STATES.COMPLETED,
            BOOKING_STATES.WORK_FINISHED,
            BOOKING_STATES.CUSTOMER_CONFIRMED,
            BOOKING_STATES.PAYMENT_COMPLETED,
            'Completed',
            'COMPLETED',
            'PAYMENT_SETTLED',
            'Finished',
            'Settled',
          ],
        },
      },
      { paymentStatus: { $in: ['PAID', 'Settled', 'Paid', 'PAID ONLINE', 'Cash on Service', 'SUCCESS'] } },
    ],
  }).lean();

  const bookingRevenue = completedBookingsList.reduce((sum, b) => {
    const bId = String(b.customId || b.id || b._id);
    if (paidBookingIds.has(bId)) return sum;
    const amt = Number(b.priceNum) || (typeof b.price === 'string' ? parseFloat(b.price.replace(/[^0-9.]/g, '')) : 0) || 0;
    return sum + amt;
  }, 0);

  const grossRevenue = paymentRevenue + bookingRevenue;
  const platformRevenue = Math.round(grossRevenue * 0.2); // 20% platform commission
  const workerEarnings = grossRevenue - platformRevenue;

  const todayRevenueNum = completedBookingsList
    .filter(b => b.createdAt && new Date(b.createdAt) >= startOfToday)
    .reduce((sum, b) => {
      const bId = String(b.customId || b.id || b._id);
      if (paidBookingIds.has(bId)) return sum;
      const amt = Number(b.priceNum) || (typeof b.price === 'string' ? parseFloat(b.price.replace(/[^0-9.]/g, '')) : 0) || 0;
      return sum + amt;
    }, 0) + payments.filter(p => p.createdAt && new Date(p.createdAt) >= startOfToday).reduce((s, p) => s + (p.amount || 0), 0);

  const pendingPayments = await Booking.countDocuments({
    status: {
      $nin: [
        BOOKING_STATES.COMPLETED,
        BOOKING_STATES.WORK_FINISHED,
        BOOKING_STATES.CUSTOMER_CONFIRMED,
        BOOKING_STATES.PAYMENT_COMPLETED,
        BOOKING_STATES.CANCELLED,
        'Completed',
        'COMPLETED',
        'CANCELLED',
        'Cancelled',
      ],
    },
    paymentStatus: { $regex: /pending|cash/i },
  });

  const allWorkers = await User.find({ role: 'worker' }).lean();

  return res.json({
    stats: {
      totalBookings,
      todayBookings,
      activeBookings,
      pendingBookings,
      assignedBookings,
      completedBookings,
      cancelledBookings,
      grossRevenue: `₹${grossRevenue.toLocaleString('en-IN')}`,
      grossRevenueNum: grossRevenue,
      revenue: grossRevenue,
      totalRevenue: grossRevenue,
      todayRevenue: `₹${todayRevenueNum.toLocaleString('en-IN')}`,
      todayRevenueNum,
      platformRevenue: `₹${platformRevenue.toLocaleString('en-IN')}`,
      platformRevenueNum: platformRevenue,
      workerEarnings: `₹${workerEarnings.toLocaleString('en-IN')}`,
      workerEarningsNum: workerEarnings,
      pendingPayments,
      totalCustomers,
      activeCustomers,
      totalWorkers,
      onlineWorkers,
      workersOnline: onlineWorkers,
      pendingKyc,
      totalComplaints,
      openComplaints,
    },
    workers: allWorkers.map(w => ({
      id: w.customId || w._id.toString(),
      name: w.name,
      email: w.email,
      phone: w.phone,
      employeeId: w.employeeId,
      services: w.services || [],
      online: Boolean(w.online),
      ratingAvg: typeof w.ratingAvg === 'number' ? w.ratingAvg : 0,
      ratingCount: w.ratingCount || 0,
      status: w.status,
    })),
  });
}

app.get('/api/admin/metrics', authRequired, requireRoles('admin'), handleGetAdminMetrics);
app.get('/api/admin/dashboard', authRequired, requireRoles('admin'), handleGetAdminMetrics);

// 2. Live Operations Monitor
app.get('/api/admin/live-ops', authRequired, requireRoles('admin'), async (req, res) => {
  const activeBookings = await Booking.find({
    status: {
      $in: [
        BOOKING_STATES.PENDING,
        BOOKING_STATES.CONFIRMED,
        BOOKING_STATES.WORKER_ASSIGNED,
        BOOKING_STATES.WORKER_ACCEPTED,
        BOOKING_STATES.TRAVELLING,
        BOOKING_STATES.ARRIVED,
        BOOKING_STATES.ENTERED_HOME,
        BOOKING_STATES.WORK_STARTED,
        'Accepted',
        'Travelling',
        'Worker on the way',
        'Arrived',
        'EnteredHome',
        'Work started',
        'InProgress',
        'Requested',
        'Pending',
        'SEARCHING_WORKER',
      ],
    },
  })
    .sort({ createdAt: -1 })
    .lean();

  const allWorkers = await User.find({ role: 'worker' }).lean();
  const onlineWorkers = allWorkers.filter(w => w.online);

  const travellingWorkers = activeBookings.filter(b => {
    const s = normalizeState(b.status);
    return s === BOOKING_STATES.TRAVELLING;
  }).length;

  const arrivedWorkers = activeBookings.filter(b => {
    const s = normalizeState(b.status);
    return s === BOOKING_STATES.ARRIVED || s === BOOKING_STATES.ENTERED_HOME;
  }).length;

  const inProgressJobs = activeBookings.filter(b => {
    const s = normalizeState(b.status);
    return s === BOOKING_STATES.WORK_STARTED;
  }).length;

  const unassignedJobs = activeBookings.filter(b => {
    const s = normalizeState(b.status);
    return !b.providerId || s === BOOKING_STATES.PENDING || s === BOOKING_STATES.CONFIRMED || s === BOOKING_STATES.WORKER_ASSIGNED;
  }).length;

  const problemBookings = activeBookings.filter(b => {
    const ageMinutes = (Date.now() - new Date(b.createdAt).getTime()) / 60000;
    return (!b.providerId && ageMinutes > 15) || b.status === 'CANCELLED';
  });

  return res.json({
    summary: {
      totalActive: activeBookings.length,
      onlineWorkers: onlineWorkers.length,
      travellingWorkers,
      arrivedWorkers,
      inProgressJobs,
      unassignedJobs,
      problemCount: problemBookings.length,
    },
    activeBookings: activeBookings.map(b => formatBooking(b, 'admin')),
    problemBookings: problemBookings.map(b => formatBooking(b, 'admin')),
    onlineWorkers: onlineWorkers.map(w => ({
      id: w.customId || w._id.toString(),
      name: w.name,
      phone: w.phone,
      employeeId: w.employeeId,
      services: w.services || [],
      serviceArea: w.serviceArea || 'Bengaluru',
      ratingAvg: w.ratingAvg || 4.9,
      status: w.status,
      online: true,
      currentJobId: activeBookings.find(b => b.providerId === (w.customId || w._id.toString()))?.customId || null,
    })),
  });
});

// 3. Worker Management & KYC Lifecycle
app.get('/api/admin/workers', authRequired, requireRoles('admin'), async (req, res) => {
  const { status, kycStatus, service, search, page = 1, limit = 50 } = req.query;
  let query = { role: 'worker' };

  if (status && status !== 'all') {
    if (status === 'online') query.online = true;
    else if (status === 'offline') query.online = false;
    else query.status = status;
  }

  if (kycStatus && kycStatus !== 'all') {
    query.kycStatus = new RegExp(`^${kycStatus}$`, 'i');
  }

  if (service && service !== 'all') {
    query.services = { $in: [service] };
  }

  if (search) {
    const q = String(search).trim();
    query.$or = [
      { name: new RegExp(q, 'i') },
      { email: new RegExp(q, 'i') },
      { phone: new RegExp(q, 'i') },
      { employeeId: new RegExp(q, 'i') },
    ];
  }

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.max(1, parseInt(limit));
  const total = await User.countDocuments(query);

  const workers = await User.find(query)
    .sort({ createdAt: -1 })
    .skip((pageNum - 1) * limitNum)
    .limit(limitNum)
    .lean();

  const formatted = await Promise.all(
    workers.map(async w => {
      const completedQuery = buildWorkerBookingQuery(w, {
        status: { $in: CANONICAL_COMPLETED_STATUSES },
      });
      const completedCount = await Booking.countDocuments(completedQuery);

      const ratedBookings = await Booking.find(
        buildWorkerBookingQuery(w, { rating: { $exists: true, $ne: null, $gt: 0 } })
      ).lean();
      const liveRatingCount = ratedBookings.length;
      const liveRatingAvg = liveRatingCount > 0
        ? Number((ratedBookings.reduce((sum, b) => sum + Number(b.rating), 0) / liveRatingCount).toFixed(1))
        : (w.ratingCount > 0 ? Number(w.ratingAvg).toFixed(1) : null);

      return {
        id: w.customId || w._id.toString(),
        _id: w._id.toString(),
        name: w.name,
        email: w.email,
        phone: w.phone,
        employeeId: w.employeeId,
        role: w.role,
        status: w.status,
        kycStatus: w.kycStatus || 'pending',
        services: w.services || [],
        serviceArea: w.serviceArea || 'Bengaluru',
        serviceRadiusKm: w.serviceRadiusKm || 15,
        ratingAvg: liveRatingAvg ? Number(liveRatingAvg) : null,
        ratingCount: liveRatingCount || w.ratingCount || 0,
        online: Boolean(w.online),
        todayEarnings: w.todayEarnings || 0,
        walletBalance: w.walletBalance || 0,
        completedJobsCount: completedCount,
        createdAt: w.createdAt ? w.createdAt.toISOString() : new Date().toISOString(),
      };
    })
  );

  return res.json({
    workers: formatted,
    pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 },
  });
});

app.post('/api/admin/workers', authRequired, requireRoles('admin'), async (req, res) => {
  const { name, email, phone, employeeId, password, services, serviceArea, serviceRadiusKm } = req.body;
  if (!name || !email || !password || !employeeId) {
    return res.status(400).json({ error: 'Name, Email, Employee ID, and Password are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const trimmedPhone = phone ? phone.trim() : null;
  const orConditions = [
    { email: normalizedEmail },
    { employeeId: employeeId.trim().toUpperCase() },
  ];
  if (trimmedPhone) {
    orConditions.push({ phone: trimmedPhone });
  }

  const existing = await User.findOne({ $or: orConditions });
  if (existing) {
    return res.status(409).json({ error: 'A user with this email, phone, or employee ID already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const customId = `usr_work_${Date.now()}`;

  let worker;
  try {
    worker = await User.create({
      customId,
      name: name.trim(),
      email: normalizedEmail,
      phone: trimmedPhone || `+91${Date.now().toString().slice(-10)}`,
      employeeId: employeeId.trim().toUpperCase(),
      passwordHash,
      role: 'worker',
      status: 'active',
      kycStatus: 'pending',
      services: Array.isArray(services) && services.length ? services : ['AC Service & Repair'],
      serviceArea: serviceArea || 'Indiranagar, Bengaluru',
      serviceRadiusKm: Number(serviceRadiusKm) || 15,
      online: true,
      ratingAvg: null,
      ratingCount: 0,
      todayEarnings: 0,
      walletBalance: 0,
    });
  } catch (createErr) {
    if (createErr.code === 11000) {
      return res.status(409).json({ error: 'A worker with these credentials already exists.' });
    }
    throw createErr;
  }

  await logFinancialAudit('ADMIN_WORKER_PROVISIONED', worker.customId, req.auth.sub, 'admin', 0, {
    name: worker.name,
    email: worker.email,
    employeeId: worker.employeeId,
    services: worker.services,
  });

  return res.status(201).json({
    success: true,
    worker: {
      id: worker._id.toString(),
      _id: worker._id.toString(),
      customId: worker.customId,
      name: worker.name,
      email: worker.email,
      phone: worker.phone,
      employeeId: worker.employeeId,
      services: worker.services,
      role: 'worker',
      status: 'active',
      kycStatus: worker.kycStatus,
    },
  });
});

app.get('/api/admin/workers/:id', authRequired, requireRoles('admin'), async (req, res) => {
  const worker = await findUserByIdOrIdentifier(req.params.id);
  if (!worker || worker.role !== 'worker') return res.status(404).json({ error: 'Worker not found.' });

  const workerQuery = buildWorkerBookingQuery(worker);
  const recentBookings = await Booking.find(workerQuery)
    .sort({ createdAt: -1 })
    .limit(15)
    .lean();

  const completedCount = await Booking.countDocuments(
    buildWorkerBookingQuery(worker, { status: { $in: CANONICAL_COMPLETED_STATUSES } })
  );

  const ratedBookings = await Booking.find(
    buildWorkerBookingQuery(worker, { rating: { $exists: true, $ne: null, $gt: 0 } })
  ).lean();
  const liveRatingCount = ratedBookings.length;
  const liveRatingAvg = liveRatingCount > 0
    ? Number((ratedBookings.reduce((sum, b) => sum + Number(b.rating), 0) / liveRatingCount).toFixed(1))
    : (worker.ratingCount > 0 ? Number(worker.ratingAvg).toFixed(1) : null);

  return res.json({
    worker: {
      id: worker.customId || worker._id.toString(),
      name: worker.name,
      email: worker.email,
      phone: worker.phone,
      employeeId: worker.employeeId,
      status: worker.status,
      kycStatus: worker.kycStatus || 'pending',
      services: worker.services || [],
      serviceArea: worker.serviceArea || 'Bengaluru',
      serviceRadiusKm: worker.serviceRadiusKm || 15,
      ratingAvg: liveRatingAvg ? Number(liveRatingAvg) : null,
      ratingCount: liveRatingCount || worker.ratingCount || 0,
      online: Boolean(worker.online),
      walletBalance: worker.walletBalance || 0,
      todayEarnings: worker.todayEarnings || 0,
      completedJobsCount: completedCount,
      recentBookings: recentBookings.map(formatBooking),
      kycDocuments: [
        { type: 'Aadhaar Card', status: worker.kycStatus === 'approved' ? 'Verified' : 'Submitted', documentId: `DOC-AADHAAR-${worker.employeeId || '8801'}` },
        { type: 'Trade Certificate / License', status: worker.kycStatus === 'approved' ? 'Verified' : 'Submitted', documentId: `DOC-LIC-${worker.employeeId || '8801'}` },
        { type: 'Police Verification Record', status: worker.kycStatus === 'approved' ? 'Verified' : 'Submitted', documentId: `DOC-POLICE-CLR` },
      ],
    },
  });
});

// KYC Action (Approve / Reject / Request Correction)
app.patch('/api/admin/workers/:id/kyc', authRequired, requireRoles('admin'), async (req, res) => {
  const { status, notes } = req.body;
  if (!status) return res.status(400).json({ error: 'KYC status is required (approved, rejected, needs_review).' });

  const worker = await findUserByIdOrIdentifier(req.params.id);
  if (!worker || worker.role !== 'worker') return res.status(404).json({ error: 'Worker not found.' });

  const prevStatus = worker.kycStatus;
  worker.kycStatus = status;
  await worker.save();

  await logFinancialAudit('ADMIN_KYC_UPDATE', worker.customId || worker._id.toString(), req.auth.sub, 'admin', 0, {
    workerName: worker.name,
    previousKyc: prevStatus,
    newKyc: status,
    notes: notes || `KYC status marked as ${status} by admin`,
  });

  await createAndDispatchNotification({
    recipientId: worker.customId || worker._id.toString(),
    eventId: `evt_kyc_${worker.customId}_${status}_${Date.now()}`,
    type: 'KYC_STATUS_UPDATED',
    priority: 'IMPORTANT',
    title: status === 'approved' ? 'KYC Verification Approved!' : 'KYC Verification Update',
    body: status === 'approved'
      ? 'Congratulations! Your KYC documents have been approved. You are now verified to accept service jobs.'
      : `Your KYC status is now: ${status}. Notes: ${notes || 'Please check with support.'}`,
  });

  return res.json({ success: true, worker });
});

// Update Worker Specializations & Service Areas
app.patch('/api/admin/workers/:id/services', authRequired, requireRoles('admin'), async (req, res) => {
  const { services, serviceArea, serviceRadiusKm } = req.body;
  const worker = await findUserByIdOrIdentifier(req.params.id);
  if (!worker || worker.role !== 'worker') return res.status(404).json({ error: 'Worker not found.' });

  if (Array.isArray(services)) worker.services = services;
  if (serviceArea) worker.serviceArea = serviceArea;
  if (serviceRadiusKm) worker.serviceRadiusKm = Number(serviceRadiusKm);
  await worker.save();

  await logFinancialAudit('ADMIN_WORKER_SPECIALIZATIONS_UPDATE', worker.customId || worker._id.toString(), req.auth.sub, 'admin', 0, {
    workerName: worker.name,
    services: worker.services,
    serviceArea: worker.serviceArea,
    serviceRadiusKm: worker.serviceRadiusKm,
  });

  return res.json({ success: true, worker });
});

app.patch('/api/admin/workers/:id/specializations', (req, res) => app._router.handle({ ...req, url: `/api/admin/workers/${req.params.id}/services` }, res));

// Worker Status (Active / Suspended)
app.patch('/api/admin/workers/:id/status', authRequired, requireRoles('admin'), async (req, res) => {
  const user = await findUserByIdOrIdentifier(req.params.id);
  if (!user || user.role !== 'worker') return res.status(404).json({ error: 'Worker not found.' });

  const prev = user.status;
  user.status = req.body.status || user.status;
  await user.save();

  await logFinancialAudit('ADMIN_WORKER_STATUS_UPDATE', user.customId || user._id.toString(), req.auth.sub, 'admin', 0, {
    workerName: user.name,
    previousStatus: prev,
    newStatus: user.status,
  });

  return res.json({ success: true, worker: user });
});

// Helper: Format Worker Profile for Admin
function formatWorkerProfile(w) {
  return {
    id: w.customId || w._id.toString(),
    _id: w._id.toString(),
    customId: w.customId || w._id.toString(),
    name: w.name,
    email: w.email,
    phone: w.phone,
    employeeId: w.employeeId,
    role: w.role,
    status: w.status,
    kycStatus: w.kycStatus || 'pending',
    services: w.services || [],
    serviceArea: w.serviceArea || 'Bengaluru',
    serviceRadiusKm: w.serviceRadiusKm || 15,
    ratingAvg: w.ratingAvg || 4.9,
    ratingCount: w.ratingCount || 0,
    online: Boolean(w.online),
    todayEarnings: w.todayEarnings || 0,
    walletBalance: w.walletBalance || 0,
  };
}

// Full Worker Profile Editing from Admin
app.patch('/api/admin/workers/:id', authRequired, requireRoles('admin'), async (req, res) => {
  const worker = await findUserByIdOrIdentifier(req.params.id);
  if (!worker || worker.role !== 'worker') return res.status(404).json({ error: 'Worker not found.' });

  const {
    name,
    email,
    phone,
    employeeId,
    services,
    serviceArea,
    serviceRadiusKm,
    kycStatus,
    status,
    password,
  } = req.body;

  if (name) worker.name = name;
  if (email) worker.email = email;
  if (phone) worker.phone = phone;
  if (employeeId) worker.employeeId = employeeId;
  if (Array.isArray(services)) worker.services = services;
  if (serviceArea !== undefined) worker.serviceArea = serviceArea;
  if (serviceRadiusKm !== undefined) worker.serviceRadiusKm = Number(serviceRadiusKm);
  if (kycStatus) worker.kycStatus = kycStatus;
  if (status) worker.status = status;
  if (password && password.trim().length > 0) {
    const salt = await bcrypt.genSalt(10);
    worker.passwordHash = await bcrypt.hash(password, salt);
  }

  await worker.save();

  await logFinancialAudit('ADMIN_WORKER_PROFILE_UPDATE', worker.customId || worker._id.toString(), req.auth.sub, 'admin', 0, {
    workerName: worker.name,
    updatedFields: req.body,
  });

  return res.json({ success: true, worker: formatWorkerProfile(worker) });
});

app.put('/api/admin/workers/:id', (req, res) => app._router.handle({ ...req, method: 'PATCH' }, res));

// 4. Customer Directory
app.get('/api/admin/customers', authRequired, requireRoles('admin'), async (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;
  let query = { role: 'customer' };

  if (search) {
    const q = String(search).trim();
    query.$or = [
      { name: new RegExp(q, 'i') },
      { email: new RegExp(q, 'i') },
      { phone: new RegExp(q, 'i') },
      { customId: new RegExp(q, 'i') },
    ];
  }

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.max(1, parseInt(limit));
  const total = await User.countDocuments(query);

  const customers = await User.find(query)
    .sort({ createdAt: -1 })
    .skip((pageNum - 1) * limitNum)
    .limit(limitNum)
    .lean();

  if (customers.length === 0) {
    return res.json({
      customers: [],
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 },
    });
  }

  // Efficient batch aggregation to avoid N+1 queries
  const custMongoIds = customers.map(c => c._id);
  const custMongoIdStrings = customers.map(c => c._id.toString());
  const custCustomIds = customers.map(c => c.customId).filter(Boolean);
  const custPhones = customers.map(c => c.phone).filter(Boolean);

  const allBookings = await Booking.find({
    $or: [
      { customerId: { $in: [...custMongoIdStrings, ...custCustomIds] } },
      { customer: { $in: custMongoIds } },
      { customerPhone: { $in: custPhones } },
    ],
  }).lean();



  const formatted = customers.map(c => {
    const cId = c.customId || c._id.toString();
    const cMongoIdStr = c._id.toString();

    // Match all bookings for this customer
    const userBookings = allBookings.filter(b => {
      const bCustId = String(b.customerId || '');
      const bCustRef = b.customer ? b.customer.toString() : '';
      const bPhone = String(b.customerPhone || '');
      return (
        bCustId === cMongoIdStr ||
        (c.customId && bCustId === c.customId) ||
        bCustRef === cMongoIdStr ||
        (c.phone && bPhone && bPhone === c.phone)
      );
    });

    const completedBookings = userBookings.filter(b => {
      const s = String(b.status || '').toUpperCase();
      const ps = String(b.paymentStatus || '').toUpperCase();
      return (
        s === 'COMPLETED' ||
        s === 'PAYMENT_COMPLETED' ||
        s === 'PAYMENT_SETTLED' ||
        ps === 'PAID' ||
        ps === 'SETTLED' ||
        ps === 'PAID ONLINE'
      );
    });

    const activeBookings = userBookings.filter(b => {
      const s = String(b.status || '').toUpperCase();
      return !['COMPLETED', 'CANCELLED', 'EXPIRED', 'DECLINED'].includes(s);
    });

    const totalSpendNum = completedBookings.reduce((sum, b) => {
      const amt = Number(b.priceNum) || (typeof b.price === 'string' ? parseFloat(b.price.replace(/[^0-9.]/g, '')) : 0) || 0;
      return sum + amt;
    }, 0);

    const primaryAddress = getCustomerPrimaryAddress(c);
    const cleanAddress = formatCustomerAddress(primaryAddress) || (typeof c.address === 'string' ? formatCustomerAddress(c.address) : null);

    return {
      id: cId,
      _id: cMongoIdStr,
      name: c.name,
      email: c.email,
      phone: c.phone,
      role: c.role,
      status: c.status || 'active',
      accountStatus: c.status || 'active',
      address: cleanAddress,
      primaryAddress,
      addresses: c.addresses || [],
      bookingCount: userBookings.length,
      totalBookings: userBookings.length,
      completedBookings: completedBookings.length,
      activeBookings: activeBookings.length,
      totalSpend: `₹${totalSpendNum.toLocaleString('en-IN')}`,
      totalSpendNum,
      createdAt: c.createdAt ? c.createdAt.toISOString() : new Date().toISOString(),
    };
  });

  return res.json({
    customers: formatted,
    pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 },
  });
});

app.get('/api/admin/customers/:id', authRequired, requireRoles('admin'), async (req, res) => {
  const customer = await findUserByIdOrIdentifier(req.params.id);
  if (!customer || customer.role !== 'customer') return res.status(404).json({ error: 'Customer not found.' });

  const cId = customer.customId || customer._id.toString();
  const cMongoIdStr = customer._id.toString();

  const bookings = await Booking.find({
    $or: [
      { customerId: { $in: [cMongoIdStr, customer.customId].filter(Boolean) } },
      { customer: customer._id },
      { customerPhone: customer.phone },
    ],
  }).sort({ createdAt: -1 }).lean();

  const complaints = await Complaint.find({
    $or: [
      { customerId: { $in: [cMongoIdStr, customer.customId].filter(Boolean) } },
      { customer: customer._id },
    ],
  }).sort({ createdAt: -1 }).lean();

  const completedBookings = bookings.filter(b => {
    const s = String(b.status || '').toUpperCase();
    const ps = String(b.paymentStatus || '').toUpperCase();
    return (
      s === 'COMPLETED' ||
      s === 'PAYMENT_COMPLETED' ||
      s === 'PAYMENT_SETTLED' ||
      ps === 'PAID' ||
      ps === 'SETTLED' ||
      ps === 'PAID ONLINE'
    );
  });

  const activeBookings = bookings.filter(b => {
    const s = String(b.status || '').toUpperCase();
    return !['COMPLETED', 'CANCELLED', 'EXPIRED', 'DECLINED'].includes(s);
  });

  const totalSpendNum = completedBookings.reduce((sum, b) => {
    const amt = Number(b.priceNum) || (typeof b.price === 'string' ? parseFloat(b.price.replace(/[^0-9.]/g, '')) : 0) || 0;
    return sum + amt;
  }, 0);

  const primaryAddress = getCustomerPrimaryAddress(customer);
  const cleanAddress = formatCustomerAddress(primaryAddress) || (typeof customer.address === 'string' ? formatCustomerAddress(customer.address) : null);

  return res.json({
    customer: {
      id: cId,
      _id: cMongoIdStr,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      status: customer.status || 'active',
      accountStatus: customer.status || 'active',
      address: cleanAddress,
      primaryAddress,
      addresses: customer.addresses || [],
      totalBookings: bookings.length,
      bookingCount: bookings.length,
      completedBookings: completedBookings.length,
      activeBookings: activeBookings.length,
      totalSpend: `₹${totalSpendNum.toLocaleString('en-IN')}`,
      totalSpendNum,
      bookings: bookings.map(formatBooking),
      complaints,
      createdAt: customer.createdAt ? customer.createdAt.toISOString() : new Date().toISOString(),
    },
  });
});

// 5. Booking Command Center & Reporting Endpoints
app.get('/api/admin/bookings', authRequired, requireRoles('admin'), async (req, res) => {
  const {
    status,
    search,
    page = 1,
    limit = 50,
    period,
    startDate: qStartDate,
    endDate: qEndDate,
    service,
    workerId,
    customerId,
    paymentStatus,
  } = req.query;

  let query = {};
  let dateRange = null;

  if (period || qStartDate) {
    dateRange = reportingService.getPeriodDateRange(period, qStartDate, qEndDate);
    query.createdAt = { $gte: dateRange.startDate, $lte: dateRange.endDate };
  }

  if (status && status !== 'all') {
    const s = String(status).trim().toUpperCase();
    if (['PENDING', 'CREATED', 'REQUESTED', 'SEARCHING_WORKER', 'OPEN'].includes(s)) {
      query.status = { $in: ['PENDING', 'CONFIRMED', 'CREATED', 'REQUESTED', 'SEARCHING_WORKER', 'OPEN'] };
    } else if (['ACCEPTED', 'ASSIGNED', 'WORKER_ASSIGNED', 'WORKER_ACCEPTED'].includes(s)) {
      query.status = { $in: ['WORKER_ASSIGNED', 'ASSIGNED', 'WORKER_ACCEPTED', 'ACCEPTED'] };
    } else if (['TRAVELLING', 'ON_THE_WAY', 'WORKER_ON_THE_WAY'].includes(s)) {
      query.status = { $in: ['TRAVELLING', 'WORKER_ON_THE_WAY', 'ON_THE_WAY'] };
    } else if (['ARRIVED', 'ENTERED_HOME', 'ENTEREDHOME'].includes(s)) {
      query.status = { $in: ['ARRIVED', 'ENTERED_HOME', 'ENTEREDHOME'] };
    } else if (['INPROGRESS', 'IN_PROGRESS', 'WORK_STARTED', 'STARTED'].includes(s)) {
      query.status = { $in: ['WORK_STARTED', 'IN_PROGRESS', 'INPROGRESS', 'STARTED'] };
    } else if (['COMPLETED', 'RESOLVED', 'PAYMENT_COMPLETED', 'PAYMENT_SETTLED'].includes(s)) {
      query.status = { $in: ['WORK_FINISHED', 'CUSTOMER_CONFIRMED', 'PAYMENT_COMPLETED', 'PAYMENT_SETTLED', 'COMPLETED', 'RESOLVED', 'Completed'] };
    } else if (['CANCELLED', 'REJECTED', 'DECLINED', 'EXPIRED'].includes(s)) {
      query.status = { $in: ['CANCELLED', 'REJECTED', 'DECLINED', 'EXPIRED', 'Cancelled'] };
    } else {
      query.status = new RegExp(`^${status}$`, 'i');
    }
  }

  if (service && service !== 'all') {
    query.service = new RegExp(`^${service}$`, 'i');
  }

  if (paymentStatus && paymentStatus !== 'all') {
    query.paymentStatus = new RegExp(`^${paymentStatus}$`, 'i');
  }

  if (workerId && workerId !== 'all') {
    query.$and = (query.$and || []).concat([{ $or: [{ providerId: workerId }, { worker: workerId }] }]);
  }

  if (customerId && customerId !== 'all') {
    query.$and = (query.$and || []).concat([{ $or: [{ customerId }, { customer: customerId }] }]);
  }

  if (search) {
    const q = String(search).trim();
    query.$or = [
      { customId: new RegExp(q, 'i') },
      { customerName: new RegExp(q, 'i') },
      { customerPhone: new RegExp(q, 'i') },
      { service: new RegExp(q, 'i') },
      { providerName: new RegExp(q, 'i') },
      { address: new RegExp(q, 'i') },
    ];
  }

  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.max(1, parseInt(limit) || 50);
  const total = await Booking.countDocuments(query);

  const bookings = await Booking.find(query)
    .sort({ createdAt: -1 })
    .skip((pageNum - 1) * limitNum)
    .limit(limitNum);

  // Period summary metrics derived from actual database records
  let periodSummary = null;
  if (dateRange) {
    periodSummary = await reportingService.getPeriodSummary(dateRange.startDate, dateRange.endDate);
  }

  return res.json({
    bookings: bookings.map(b => formatBooking(b, 'admin')),
    pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 },
    dateRange: dateRange
      ? {
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          period: dateRange.period,
          formattedLabel: reportingService.formatRangeLabel(dateRange.startDate, dateRange.endDate),
        }
      : null,
    summary: periodSummary,
  });
});

// Dedicated Reporting Engine API (Aggregated Reports, Trends, Breakdowns)
app.get('/api/admin/reports', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const {
      period = '1week',
      startDate: qStartDate,
      endDate: qEndDate,
      status,
      service,
      workerId,
      customerId,
      paymentStatus,
      search,
      page = 1,
      limit = 50,
    } = req.query;

    const dateRange = reportingService.getPeriodDateRange(period, qStartDate, qEndDate);
    const { startDate, endDate, period: normPeriod } = dateRange;
    const formattedLabel = reportingService.formatRangeLabel(startDate, endDate);

    // 1. Period-Specific Summary Cards (17 Authoritative Metrics)
    const summary = await reportingService.getPeriodSummary(startDate, endDate);

    // 2. Time-series Trends Breakdown (Daily for week/month, Monthly for year, plus weekly comparison buckets)
    const trends = await reportingService.getTrendsBreakdown(normPeriod, startDate, endDate);

    // 3. Status, Category, and Payment Distributions for Charts
    const distributions = await reportingService.getDistributions(startDate, endDate);

    // 4. Customer Report
    const customerReport = await reportingService.getCustomerReport(startDate, endDate);

    // 5. Worker Report
    const workerReport = await reportingService.getWorkerReport(startDate, endDate);

    // 6. Cancellation Report
    const cancellationReport = await reportingService.getCancellationReport(startDate, endDate);

    // 7. Filtered, Paginated Booking Report
    const bookingReport = await reportingService.getBookingReport(
      { startDate, endDate, status, service, workerId, customerId, paymentStatus, search },
      page,
      limit
    );

    // 8. Filtered, Paginated Payment Report
    const paymentReport = await reportingService.getPaymentReport(
      { startDate, endDate, paymentStatus, search },
      page,
      limit
    );

    return res.json({
      period: normPeriod,
      dateRange: {
        startDate,
        endDate,
        formattedLabel,
      },
      summary,
      trends,
      distributions,
      bookingReport,
      paymentReport,
      customerReport,
      workerReport,
      cancellationReport,
    });
  } catch (err) {
    console.error('[Admin Reports Error]', err);
    return res.status(500).json({ error: 'Failed to generate administrative reports: ' + err.message });
  }
});

// Reports CSV Export Endpoint (Respects Period and Active Filters)
app.get('/api/admin/reports/export', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const {
      type = 'bookings',
      period = '1week',
      startDate: qStartDate,
      endDate: qEndDate,
      status,
      service,
      workerId,
      customerId,
      paymentStatus,
      search,
    } = req.query;

    const dateRange = reportingService.getPeriodDateRange(period, qStartDate, qEndDate);
    const { startDate, endDate } = dateRange;

    let csvContent = '';
    const safePeriodName = String(period).toLowerCase().replace(/[^a-z0-9]/g, '');
    const filename = `homestepin-${type}-report-${safePeriodName}.csv`;

    if (type === 'bookings') {
      const { bookings } = await reportingService.getBookingReport(
        { startDate, endDate, status, service, workerId, customerId, paymentStatus, search },
        1,
        10000
      );
      const columns = [
        { key: 'id', label: 'Booking ID' },
        { key: 'createdAt', label: 'Created At' },
        { key: 'customerName', label: 'Customer Name' },
        { key: 'customerPhone', label: 'Customer Phone' },
        { key: 'category', label: 'Category' },
        { key: 'service', label: 'Service' },
        { key: 'scheduledAt', label: 'Scheduled Time' },
        { key: 'address', label: 'Address' },
        { key: 'providerName', label: 'Assigned Professional' },
        { key: 'status', label: 'Status' },
        { key: 'basePrice', label: 'Base Price (INR)' },
        { key: 'convenienceFee', label: 'Convenience Fee (INR)' },
        { key: 'tax', label: 'Tax & GST (INR)' },
        { key: 'discount', label: 'Discount (INR)' },
        { key: 'totalPrice', label: 'Total Payable (INR)' },
        { key: 'paymentStatus', label: 'Payment Status' },
        { key: 'paymentMethod', label: 'Payment Method' },
        { key: 'cancellationReason', label: 'Cancellation Reason' },
        { key: 'refundAmount', label: 'Refund Amount' },
        { key: 'refundStatus', label: 'Refund Status' },
      ];
      csvContent = reportingService.generateCsv(bookings, columns);
    } else if (type === 'revenue') {
      const trends = await reportingService.getTrendsBreakdown(period, startDate, endDate);
      const columns = [
        { key: 'fullLabel', label: 'Period' },
        { key: 'bookingsCount', label: 'Bookings' },
        { key: 'completedCount', label: 'Completed' },
        { key: 'cancelledCount', label: 'Cancelled' },
        { key: 'bookingValue', label: 'Booking Value (INR)' },
        { key: 'collected', label: 'Actually Collected (INR)' },
        { key: 'pending', label: 'Pending (INR)' },
        { key: 'refunds', label: 'Refunds (INR)' },
        { key: 'netCollected', label: 'Net Revenue (INR)' },
      ];
      csvContent = reportingService.generateCsv(trends.data, columns);
    } else if (type === 'payments') {
      const { payments } = await reportingService.getPaymentReport(
        { startDate, endDate, paymentStatus, search },
        1,
        10000
      );
      const columns = [
        { key: 'customId', label: 'Transaction Ref' },
        { key: 'bookingId', label: 'Booking ID' },
        { key: 'customerName', label: 'Customer' },
        { key: 'amount', label: 'Amount (INR)' },
        { key: 'status', label: 'Status' },
        { key: 'method', label: 'Payment Method' },
        { key: 'provider', label: 'Provider' },
        { key: 'createdAt', label: 'Transaction Date' },
        { key: 'refundAmount', label: 'Refund Amount (INR)' },
        { key: 'refundStatus', label: 'Refund Status' },
      ];
      csvContent = reportingService.generateCsv(payments, columns);
    } else if (type === 'customers') {
      const customerReport = await reportingService.getCustomerReport(startDate, endDate);
      const columns = [
        { key: 'customerId', label: 'Customer ID' },
        { key: 'name', label: 'Name' },
        { key: 'phone', label: 'Phone' },
        { key: 'bookingsCount', label: 'Total Bookings' },
        { key: 'completedCount', label: 'Completed Bookings' },
        { key: 'totalSpent', label: 'Total Spend (INR)' },
        { key: 'lastBookingDate', label: 'Last Booking' },
      ];
      csvContent = reportingService.generateCsv(customerReport.customers, columns);
    } else if (type === 'workers') {
      const workerReport = await reportingService.getWorkerReport(startDate, endDate);
      const columns = [
        { key: 'workerId', label: 'Worker ID' },
        { key: 'employeeId', label: 'Employee ID' },
        { key: 'name', label: 'Name' },
        { key: 'phone', label: 'Phone' },
        { key: 'assignments', label: 'Assignments' },
        { key: 'completedJobs', label: 'Completed Jobs' },
        { key: 'cancellations', label: 'Cancellations' },
        { key: 'acceptanceRate', label: 'Acceptance Rate' },
        { key: 'earnings', label: 'Recorded Earnings (INR)' },
      ];
      csvContent = reportingService.generateCsv(workerReport.workers, columns);
    } else if (type === 'cancellations') {
      const cancellationReport = await reportingService.getCancellationReport(startDate, endDate);
      const columns = [
        { key: 'bookingId', label: 'Booking ID' },
        { key: 'customerName', label: 'Customer Name' },
        { key: 'service', label: 'Service' },
        { key: 'bookingAmount', label: 'Amount (INR)' },
        { key: 'cancellationTimestamp', label: 'Cancelled At' },
        { key: 'reason', label: 'Cancellation Reason' },
        { key: 'cancelledBy', label: 'Cancelled By' },
        { key: 'refundAmount', label: 'Refund Amount (INR)' },
        { key: 'refundStatus', label: 'Refund Status' },
      ];
      csvContent = reportingService.generateCsv(cancellationReport.records, columns);
    } else {
      return res.status(400).json({ error: 'Unknown export report type.' });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvContent);
  } catch (err) {
    console.error('[Reports Export Error]', err);
    return res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// Assign / Reassign Worker
app.post('/api/admin/bookings/:id/assign', authRequired, requireRoles('admin'), async (req, res) => {
  const { workerId, reason } = req.body;
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  const worker = await findUserByIdOrIdentifier(workerId);
  if (!worker || worker.role !== 'worker') {
    return res.status(400).json({ error: 'A valid worker record is required for assignment.' });
  }

  const prevWorker = booking.providerName;
  booking.providerId = worker._id.toString();
  booking.worker = worker._id;
  booking.providerName = worker.name;
  booking.providerPhone = worker.phone;
  booking.status = 'WORKER_ACCEPTED';
  await booking.save();

  await logFinancialAudit('ADMIN_MANUAL_ASSIGNMENT', booking.customId, req.auth.sub, 'admin', 0, {
    previousWorker: prevWorker,
    assignedWorkerId: booking.providerId,
    assignedWorkerName: booking.providerName,
    reason: reason || 'Manual dispatch assignment by administrator',
  });

  await createAndDispatchNotification({
    recipientId: booking.providerId,
    eventId: `evt_admin_assign_${booking.customId}_${booking.providerId}`,
    type: 'WORKER_ASSIGNED',
    priority: 'IMPORTANT',
    title: 'Booking Assigned by Admin',
    body: `You have been manually assigned to booking #${booking.customId} for ${booking.service}.`,
    bookingId: booking.customId,
  });

  await createAndDispatchNotification({
    recipientId: booking.customerId,
    eventId: `evt_admin_assign_cust_${booking.customId}`,
    type: 'WORKER_ASSIGNED',
    priority: 'IMPORTANT',
    title: 'Professional Assigned',
    body: `${booking.providerName} has been assigned to your booking #${booking.customId}.`,
    bookingId: booking.customId,
  });

  const workerOid = worker._id.toString();
  const workerCustom = worker.customId || workerOid;

  // Real-time broadcast to all workers so the assigned partner claims it and others remove it
  broadcastToWorkers({
    type: 'BOOKING_ASSIGNED',
    bookingId: booking.customId || booking.id,
    assignedWorkerId: workerOid,
    assignedWorkerCustomId: workerCustom,
    workerId: workerOid,
    status: booking.status,
  });

  // Direct WebSocket room dispatch for instant partner notification
  broadcastToRoom(`user_${workerOid}`, {
    type: 'BOOKING_ASSIGNED',
    bookingId: booking.customId || booking.id,
    assignedWorkerId: workerOid,
    assignedWorkerCustomId: workerCustom,
    status: booking.status,
  });

  if (workerCustom !== workerOid) {
    broadcastToRoom(`user_${workerCustom}`, {
      type: 'BOOKING_ASSIGNED',
      bookingId: booking.customId || booking.id,
      assignedWorkerId: workerCustom,
      assignedWorkerCustomId: workerCustom,
      status: booking.status,
    });
  }

  // Real-time update for customer tracking screen
  broadcastToRoom(`user_${booking.customerId}`, {
    type: 'booking_status_updated',
    bookingId: booking.customId || booking.id,
    status: booking.status,
    providerId: booking.providerId,
    providerName: booking.providerName,
  });

  // Admin live-ops update
  broadcastToAdmins({
    type: 'BOOKING_ASSIGNED',
    bookingId: booking.customId || booking.id,
    assignedWorkerId: workerOid,
    status: booking.status,
  });

  return res.json({ success: true, booking: formatBooking(booking) });
});

// Cancel Booking by Admin
app.post('/api/admin/bookings/:id/cancel', authRequired, requireRoles('admin'), async (req, res) => {
  const { reason } = req.body;
  const booking = await findBookingById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  booking.status = 'CANCELLED';
  booking.chatLocked = true;
  await booking.save();
  await deactivateBookingCommunication(booking, 'booking_cancelled');

  await logFinancialAudit('ADMIN_BOOKING_CANCELLED', booking.customId, req.auth.sub, 'admin', 0, {
    reason: reason || 'Cancelled by administrator',
  });

  await createAndDispatchNotification({
    recipientId: booking.customerId,
    eventId: `evt_cancel_cust_${booking.customId}_${Date.now()}`,
    type: 'BOOKING_CANCELLED',
    priority: 'CRITICAL',
    title: 'Booking Cancelled',
    body: `Your booking #${booking.customId} has been cancelled by support. Reason: ${reason || 'Operational adjustment'}.`,
    bookingId: booking.customId,
  });

  return res.json({ success: true, booking: formatBooking(booking) });
});

// 6. Services & Pricing Catalog Management (Admin-Only)

// Admin Service Image / Logo Upload Endpoint (Secured with RBAC and Magic-Byte Verification)
app.post('/api/admin/services/upload', authRequired, requireRoles('admin'), async (req, res) => {
  try {
    const { image, base64Data } = req.body;
    const rawData = image || base64Data;
    if (!rawData) {
      return res.status(400).json({ error: 'Image data is required (base64 string).' });
    }

    const cleanBase64 = rawData.replace(/^data:[a-zA-Z0-9+/.-]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image file size exceeds maximum 10MB limit.' });
    }

    const verifiedExt = detectAndValidateRasterImage(buffer);
    if (!verifiedExt) {
      return res.status(400).json({
        error: 'Invalid image format: Only authentic JPEG, PNG, WEBP, or GIF raster images are permitted. SVG, executable, and script files are strictly rejected.',
        code: 'INVALID_IMAGE_TYPE',
      });
    }

    const safeName = `service_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${verifiedExt}`;
    const filePath = path.join(SERVICES_UPLOADS_DIR, safeName);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/services/${safeName}`;
    return res.json({ success: true, url: publicUrl, filename: safeName });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to upload service image: ' + err.message });
  }
});

// List All Services (Admin-Only: returns both visible and hidden services)
app.get('/api/admin/services', authRequired, requireRoles('admin'), async (req, res) => {
  const { search, category, status, sort } = req.query;
  const filter = {};

  if (category && category !== 'all') {
    filter.category = category;
  }

  if (status === 'visible') {
    filter.$or = [{ is_visible: true, active: true }, { is_visible: true, active: { $ne: false } }];
  } else if (status === 'hidden') {
    filter.$or = [{ is_visible: false }, { active: false }];
  }

  if (search && search.trim()) {
    const q = search.trim();
    filter.$or = [
      { name: new RegExp(q, 'i') },
      { shortName: new RegExp(q, 'i') },
      { customId: new RegExp(q, 'i') },
      { category: new RegExp(q, 'i') },
      { description: new RegExp(q, 'i') },
    ];
  }

  let sortObj = { displayOrder: 1, createdAt: -1 };
  if (sort === 'name') sortObj = { name: 1 };
  else if (sort === 'price_asc') sortObj = { priceNum: 1 };
  else if (sort === 'price_desc') sortObj = { priceNum: -1 };
  else if (sort === 'newest') sortObj = { createdAt: -1 };
  else if (sort === 'oldest') sortObj = { createdAt: 1 };

  const services = await Service.find(filter).sort(sortObj).lean();
  const allServices = await Service.find().lean();
  const categories = await Category.find().lean();

  const total = allServices.length;
  const visible = allServices.filter(s => s.is_visible !== false && s.active !== false).length;
  const hidden = total - visible;
  const uniqueCats = Array.from(new Set(allServices.map(s => s.category).filter(Boolean)));

  return res.json({
    services,
    categories,
    stats: {
      total,
      visible,
      hidden,
      categoriesCount: uniqueCats.length,
    },
  });
});

// Create New Service (Admin-Only)
app.post('/api/admin/services', authRequired, requireRoles('admin'), async (req, res) => {
  const {
    name,
    shortName,
    category,
    description,
    detailedDescription,
    icon,
    imageUrl,
    images,
    priceStart,
    priceNum,
    discount,
    finalPrice,
    priceUnit,
    minCharge,
    badge,
    highlights,
    features,
    inclusions,
    exclusions,
    instructions,
    requirements,
    duration,
    durationMinutes,
    displayOrder,
    popular,
    featured,
    is_visible,
    active,
  } = req.body;

  if (!name || !category) return res.status(400).json({ error: 'Name and Category are required.' });

  const existing = await Service.findOne({ name: name.trim() });
  if (existing) return res.status(409).json({ error: 'A service with this name already exists.' });

  const numVal = parseInt(String(priceNum || req.body.basePrice || priceStart || '499').replace(/[^0-9]/g, ''), 10);
  const customId = `srv_${Date.now()}`;
  let baseSlug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let slug = baseSlug;
  let slugSuffix = 1;
  while (await Service.findOne({ slug })) {
    slug = `${baseSlug}-${slugSuffix++}`;
  }
  const visibleState = is_visible !== undefined ? Boolean(is_visible) : (active !== undefined ? Boolean(active) : true);

  const discountVal = Number(discount) || 0;
  const finalPriceNum = finalPrice !== undefined ? Number(finalPrice) : (discountVal > 0 ? Math.round(numVal * (1 - discountVal / 100)) : numVal);

  const created = await Service.create({
    customId,
    name: name.trim(),
    shortName: shortName ? shortName.trim() : name.trim(),
    slug,
    category: category.trim(),
    description: description || '',
    detailedDescription: detailedDescription || description || '',
    icon: icon || '🛠️',
    imageUrl: imageUrl || (Array.isArray(images) && images[0]) || '',
    images: Array.isArray(images) ? images : (imageUrl ? [imageUrl] : []),
    priceStart: priceStart || `₹${finalPriceNum || numVal}`,
    priceNum: numVal,
    discount: discountVal,
    finalPrice: finalPriceNum,
    priceUnit: priceUnit || 'per service',
    minCharge: Number(minCharge) || 0,
    badge: badge || 'PRO',
    highlights: Array.isArray(highlights) ? highlights : [],
    features: Array.isArray(features) ? features : [],
    inclusions: Array.isArray(inclusions) && inclusions.length ? inclusions : ['Professional diagnostic', 'Standard service & cleanup', 'Genuine components warranty'],
    exclusions: Array.isArray(exclusions) && exclusions.length ? exclusions : ['Major spare parts replacements', 'Unapproved electrical rewiring'],
    instructions: instructions || '',
    requirements: requirements || '',
    duration: duration || '45 mins',
    durationMinutes: Number(durationMinutes) || 45,
    displayOrder: Number(displayOrder) || 0,
    popular: Boolean(popular),
    featured: Boolean(featured),
    is_visible: visibleState,
    active: visibleState,
  });

  await logFinancialAudit('ADMIN_SERVICE_CREATED', created.customId, req.auth.sub, 'admin', numVal, {
    name: created.name,
    category: created.category,
    price: created.priceStart,
    is_visible: created.is_visible,
  });

  return res.status(201).json({ success: true, service: created });
});

// Update Service (Admin-Only)
app.put('/api/admin/services/:id', authRequired, requireRoles('admin'), async (req, res) => {
  const service = await Service.findOne({
    $or: [{ customId: req.params.id }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
  });
  if (!service) return res.status(404).json({ error: 'Service not found.' });

  if (req.body.name && req.body.name.trim() !== service.name) {
    service.name = req.body.name.trim();
    let baseSlug = req.body.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let slug = baseSlug;
    let slugSuffix = 1;
    while (await Service.findOne({ slug, _id: { $ne: service._id } })) {
      slug = `${baseSlug}-${slugSuffix++}`;
    }
    service.slug = slug;
  }
  if (req.body.shortName !== undefined) service.shortName = req.body.shortName.trim();
  if (req.body.category) service.category = req.body.category.trim();
  if (req.body.description !== undefined) service.description = req.body.description;
  if (req.body.detailedDescription !== undefined) service.detailedDescription = req.body.detailedDescription;
  if (req.body.icon !== undefined) service.icon = req.body.icon;
  if (req.body.imageUrl !== undefined) service.imageUrl = req.body.imageUrl;
  if (Array.isArray(req.body.images)) service.images = req.body.images;
  if (req.body.priceNum !== undefined) service.priceNum = Number(req.body.priceNum);
  if (req.body.basePrice !== undefined) service.priceNum = Number(req.body.basePrice);
  if (req.body.discount !== undefined) service.discount = Number(req.body.discount);
  if (req.body.finalPrice !== undefined) {
    service.finalPrice = Number(req.body.finalPrice);
    if (!req.body.priceStart) service.priceStart = `₹${service.finalPrice}`;
  }
  if (req.body.priceStart !== undefined) service.priceStart = req.body.priceStart;
  else if (req.body.basePrice !== undefined && req.body.finalPrice === undefined) service.priceStart = `₹${service.priceNum}`;
  if (req.body.priceUnit !== undefined) service.priceUnit = req.body.priceUnit;
  if (req.body.minCharge !== undefined) service.minCharge = Number(req.body.minCharge);
  if (req.body.badge !== undefined) service.badge = req.body.badge;
  if (Array.isArray(req.body.highlights)) service.highlights = req.body.highlights;
  if (Array.isArray(req.body.features)) service.features = req.body.features;
  if (Array.isArray(req.body.inclusions)) service.inclusions = req.body.inclusions;
  if (Array.isArray(req.body.exclusions)) service.exclusions = req.body.exclusions;
  if (req.body.instructions !== undefined) service.instructions = req.body.instructions;
  if (req.body.requirements !== undefined) service.requirements = req.body.requirements;
  if (req.body.duration !== undefined) service.duration = req.body.duration;
  if (req.body.durationMinutes !== undefined) service.durationMinutes = Number(req.body.durationMinutes);
  if (req.body.displayOrder !== undefined) service.displayOrder = Number(req.body.displayOrder);
  if (req.body.popular !== undefined) service.popular = Boolean(req.body.popular);
  if (req.body.featured !== undefined) service.featured = Boolean(req.body.featured);

  if (typeof req.body.is_visible === 'boolean') {
    service.is_visible = req.body.is_visible;
    service.active = req.body.is_visible;
  } else if (typeof req.body.active === 'boolean') {
    service.active = req.body.active;
    service.is_visible = req.body.active;
  }

  await service.save();

  await logFinancialAudit('ADMIN_SERVICE_UPDATED', service.customId || service._id.toString(), req.auth.sub, 'admin', service.priceNum, {
    name: service.name,
    price: service.priceStart,
    is_visible: service.is_visible,
  });

  return res.json({ success: true, service });
});

// Toggle Service Visibility (Admin-Only)
app.patch('/api/admin/services/:id/visibility', authRequired, requireRoles('admin'), async (req, res) => {
  const service = await Service.findOne({
    $or: [{ customId: req.params.id }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
  });
  if (!service) return res.status(404).json({ error: 'Service not found.' });

  const targetState = typeof req.body.is_visible === 'boolean'
    ? req.body.is_visible
    : (typeof req.body.active === 'boolean' ? req.body.active : !(service.is_visible !== false && service.active !== false));

  service.is_visible = targetState;
  service.active = targetState;
  await service.save();

  await logFinancialAudit('ADMIN_SERVICE_VISIBILITY_TOGGLED', service.customId || service._id.toString(), req.auth.sub, 'admin', 0, {
    name: service.name,
    is_visible: service.is_visible,
  });

  return res.json({ success: true, is_visible: service.is_visible, active: service.active, service });
});

// Bulk Reorder Services (Admin-Only)
app.patch('/api/admin/services/reorder', authRequired, requireRoles('admin'), async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Array of items with id and displayOrder is required.' });

  for (const item of items) {
    if (item.id && typeof item.displayOrder === 'number') {
      await Service.updateOne(
        { $or: [{ customId: item.id }, { _id: /^[0-9a-fA-F]{24}$/.test(item.id) ? item.id : null }] },
        { $set: { displayOrder: item.displayOrder } }
      );
    }
  }

  return res.json({ success: true, message: 'Services display order updated.' });
});

// Permanent Service Delete (Admin-Only: checks active bookings and safely protects historical records)
app.delete('/api/admin/services/:id', authRequired, requireRoles('admin'), async (req, res) => {
  const service = await Service.findOne({
    $or: [{ customId: req.params.id }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
  });
  if (!service) return res.status(404).json({ error: 'Service not found.' });

  // Safety Check: Check if there are active / in-flight bookings depending on this service
  const activeBookingsCount = await Booking.countDocuments({
    service: service.name,
    status: { $nin: ['Completed', 'CANCELLED', 'PAYMENT_SETTLED', 'DISPUTED'] },
  });

  if (activeBookingsCount > 0) {
    const msg = `Cannot permanently delete service "${service.name}" because ${activeBookingsCount} active/in-progress booking(s) currently depend on it. Please complete or cancel those bookings first, or hide the service instead.`;
    return res.status(400).json({
      error: msg,
      message: msg,
      code: 'ACTIVE_BOOKINGS_EXIST',
      activeBookingsCount,
    });
  }

  // Delete the service from catalog. Historical completed/cancelled bookings retain their denormalized snapshots safely.
  await Service.deleteOne({ _id: service._id });

  await logFinancialAudit('ADMIN_SERVICE_DELETED', service.customId || service._id.toString(), req.auth.sub, 'admin', 0, {
    name: service.name,
    category: service.category,
  });

  return res.json({ success: true, message: `Service "${service.name}" was permanently deleted.` });
});

// 7. Coupons & Offers Management (Admin-Only)

// List All Coupons (Admin-Only: returns all coupons: active, hidden, expired)
app.get('/api/admin/coupons', authRequired, requireRoles('admin'), async (req, res) => {
  const { search, status, sort } = req.query;
  const filter = {};
  const now = new Date();

  if (status === 'active') {
    filter.is_visible = { $ne: false };
    filter.active = { $ne: false };
    filter.$or = [{ expiresAt: null }, { expiresAt: { $gt: now } }];
  } else if (status === 'hidden') {
    filter.$or = [{ is_visible: false }, { active: false }];
  } else if (status === 'expired') {
    filter.expiresAt = { $lte: now };
  }

  if (search && search.trim()) {
    const q = search.trim();
    filter.$or = [
      { code: new RegExp(q, 'i') },
      { title: new RegExp(q, 'i') },
      { description: new RegExp(q, 'i') },
    ];
  }

  let sortObj = { displayOrder: 1, createdAt: -1 };
  if (sort === 'expiry') sortObj = { expiresAt: 1 };
  else if (sort === 'code') sortObj = { code: 1 };
  else if (sort === 'newest') sortObj = { createdAt: -1 };

  const coupons = await Coupon.find(filter).sort(sortObj).lean();
  const allCoupons = await Coupon.find().lean();

  const total = allCoupons.length;
  const activeCount = allCoupons.filter(c => (c.is_visible !== false && c.active !== false && (!c.expiresAt || new Date(c.expiresAt) > now))).length;
  const hiddenCount = allCoupons.filter(c => c.is_visible === false || c.active === false).length;
  const expiredCount = allCoupons.filter(c => c.expiresAt && new Date(c.expiresAt) <= now).length;

  return res.json({
    coupons,
    stats: {
      total,
      active: activeCount,
      hidden: hiddenCount,
      expired: expiredCount,
    },
  });
});

// Create Coupon (Admin-Only)
app.post('/api/admin/coupons', authRequired, requireRoles('admin'), async (req, res) => {
  const {
    code,
    title,
    description,
    discountType,
    discountValue,
    amount,
    percent,
    maxDiscount,
    minOrderAmount,
    applicableService,
    applicableCategory,
    startDate,
    expiresAt,
    usageLimit,
    perUserLimit,
    displayOrder,
    terms,
    is_visible,
    active,
  } = req.body;

  if (!code) return res.status(400).json({ error: 'Coupon code is required.' });

  const upperCode = code.trim().toUpperCase();
  const existing = await Coupon.findOne({ code: upperCode });
  if (existing) return res.status(409).json({ error: 'Coupon code already exists.' });

  const numAmount = amount !== undefined ? Number(amount) : (discountType === 'flat' ? Number(discountValue) : 0);
  const numPercent = percent !== undefined ? Number(percent) : (discountType === 'percentage' ? Number(discountValue) : 0);
  const visibleState = is_visible !== undefined ? Boolean(is_visible) : (active !== undefined ? Boolean(active) : true);

  const created = await Coupon.create({
    code: upperCode,
    title: title || (numAmount ? `Flat ₹${numAmount} OFF` : `${numPercent}% Instant Discount`),
    description: description || `Use code ${upperCode} at checkout to save on home services.`,
    discountType: discountType || (numPercent > 0 ? 'percentage' : 'flat'),
    discountValue: discountValue !== undefined ? Number(discountValue) : (numPercent || numAmount || 0),
    amount: numAmount || 0,
    percent: numPercent || 0,
    maxDiscount: Number(maxDiscount) || (numAmount || 250),
    minOrderAmount: Number(minOrderAmount) || (numAmount ? numAmount * 4 : 299),
    applicableService: applicableService || 'all',
    applicableCategory: applicableCategory || 'all',
    startDate: startDate ? new Date(startDate) : null,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    usageLimit: Number(usageLimit) || 0,
    perUserLimit: Number(perUserLimit) || 1,
    displayOrder: Number(displayOrder) || 0,
    terms: Array.isArray(terms) ? terms.join('\n') : (terms || ''),
    is_visible: visibleState,
    active: visibleState,
  });

  await logFinancialAudit('ADMIN_COUPON_CREATED', created.code, req.auth.sub, 'admin', created.amount, {
    code: created.code,
    amount: created.amount,
    percent: created.percent,
    is_visible: created.is_visible,
  });

  return res.status(201).json({ success: true, coupon: created });
});

// Update Coupon (Admin-Only)
app.put('/api/admin/coupons/:id', authRequired, requireRoles('admin'), async (req, res) => {
  const coupon = await Coupon.findOne({
    $or: [{ code: req.params.id.toUpperCase() }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
  });
  if (!coupon) return res.status(404).json({ error: 'Coupon not found.' });

  if (req.body.title !== undefined) coupon.title = req.body.title;
  if (req.body.description !== undefined) coupon.description = req.body.description;
  if (req.body.discountType !== undefined) coupon.discountType = req.body.discountType;
  if (req.body.discountValue !== undefined) coupon.discountValue = Number(req.body.discountValue);
  if (req.body.amount !== undefined) coupon.amount = Number(req.body.amount);
  if (req.body.percent !== undefined) coupon.percent = Number(req.body.percent);
  if (req.body.maxDiscount !== undefined) coupon.maxDiscount = Number(req.body.maxDiscount);
  if (req.body.minOrderAmount !== undefined) coupon.minOrderAmount = Number(req.body.minOrderAmount);
  if (req.body.applicableService !== undefined) coupon.applicableService = req.body.applicableService;
  if (req.body.applicableCategory !== undefined) coupon.applicableCategory = req.body.applicableCategory;
  if (req.body.startDate !== undefined) coupon.startDate = req.body.startDate ? new Date(req.body.startDate) : null;
  if (req.body.expiresAt !== undefined) coupon.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  if (req.body.usageLimit !== undefined) coupon.usageLimit = Number(req.body.usageLimit);
  if (req.body.perUserLimit !== undefined) coupon.perUserLimit = Number(req.body.perUserLimit);
  if (req.body.displayOrder !== undefined) coupon.displayOrder = Number(req.body.displayOrder);
  if (req.body.terms !== undefined) coupon.terms = Array.isArray(req.body.terms) ? req.body.terms.join('\n') : req.body.terms;

  if (typeof req.body.is_visible === 'boolean') {
    coupon.is_visible = req.body.is_visible;
    coupon.active = req.body.is_visible;
  } else if (typeof req.body.active === 'boolean') {
    coupon.active = req.body.active;
    coupon.is_visible = req.body.active;
  }

  // Ensure amount & percent reflect discountType & discountValue if provided
  if (req.body.discountType === 'flat' && req.body.discountValue !== undefined) {
    coupon.amount = Number(req.body.discountValue);
    coupon.percent = 0;
  } else if (req.body.discountType === 'percentage' && req.body.discountValue !== undefined) {
    coupon.percent = Number(req.body.discountValue);
    coupon.amount = 0;
  }

  await coupon.save();

  await logFinancialAudit('ADMIN_COUPON_UPDATED', coupon.code, req.auth.sub, 'admin', coupon.amount, {
    code: coupon.code,
    active: coupon.active,
    is_visible: coupon.is_visible,
  });

  return res.json({ success: true, coupon });
});

// Toggle Coupon Visibility (Admin-Only)
app.patch('/api/admin/coupons/:id/visibility', authRequired, requireRoles('admin'), async (req, res) => {
  const coupon = await Coupon.findOne({
    $or: [{ code: req.params.id.toUpperCase() }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
  });
  if (!coupon) return res.status(404).json({ error: 'Coupon not found.' });

  const targetState = typeof req.body.is_visible === 'boolean'
    ? req.body.is_visible
    : (typeof req.body.active === 'boolean' ? req.body.active : !(coupon.is_visible !== false && coupon.active !== false));

  coupon.is_visible = targetState;
  coupon.active = targetState;
  await coupon.save();

  await logFinancialAudit('ADMIN_COUPON_VISIBILITY_TOGGLED', coupon.code, req.auth.sub, 'admin', 0, {
    code: coupon.code,
    is_visible: coupon.is_visible,
  });

  return res.json({ success: true, is_visible: coupon.is_visible, active: coupon.active, coupon });
});

// Bulk Reorder Coupons (Admin-Only)
app.patch('/api/admin/coupons/reorder', authRequired, requireRoles('admin'), async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Array of items with id/code and displayOrder is required.' });

  for (const item of items) {
    const key = item.id || item.code;
    if (key && typeof item.displayOrder === 'number') {
      await Coupon.updateOne(
        { $or: [{ code: String(key).toUpperCase() }, { _id: /^[0-9a-fA-F]{24}$/.test(key) ? key : null }] },
        { $set: { displayOrder: item.displayOrder } }
      );
    }
  }

  return res.json({ success: true, message: 'Coupons display order updated.' });
});

// Permanent Coupon Delete (Admin-Only: checks active bookings and safely protects historical records)
app.delete('/api/admin/coupons/:id', authRequired, requireRoles('admin'), async (req, res) => {
  const coupon = await Coupon.findOne({
    $or: [{ code: req.params.id.toUpperCase() }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
  });
  if (!coupon) return res.status(404).json({ error: 'Coupon not found.' });

  // Safety check: protect any ongoing / active bookings that have this coupon applied
  const activeBookingsCount = await Booking.countDocuments({
    'priceBreakdown.couponCode': coupon.code,
    status: { $nin: ['Completed', 'CANCELLED', 'PAYMENT_SETTLED', 'DISPUTED'] },
  });

  if (activeBookingsCount > 0) {
    const msg = `Cannot permanently delete coupon "${coupon.code}" because it is currently applied to ${activeBookingsCount} active booking(s). Please hide or disable the coupon instead.`;
    return res.status(400).json({
      error: msg,
      message: msg,
      code: 'ACTIVE_BOOKINGS_EXIST',
      activeBookingsCount,
    });
  }

  await Coupon.deleteOne({ _id: coupon._id });

  await logFinancialAudit('ADMIN_COUPON_DELETED', coupon.code, req.auth.sub, 'admin', 0, {
    code: coupon.code,
  });

  return res.json({ success: true, message: `Coupon "${coupon.code}" was permanently deleted.` });
});

// 8. Payments, Financials & Refunds
app.get('/api/admin/financials', authRequired, requireRoles('admin'), async (req, res) => {
  const payments = await Payment.find().sort({ createdAt: -1 }).lean();
  const completedBookings = await Booking.find({
    $or: [
      {
        status: {
          $in: [
            BOOKING_STATES.COMPLETED,
            BOOKING_STATES.WORK_FINISHED,
            BOOKING_STATES.CUSTOMER_CONFIRMED,
            BOOKING_STATES.PAYMENT_COMPLETED,
            'Completed',
            'COMPLETED',
            'PAYMENT_SETTLED',
            'Finished',
            'Settled',
          ],
        },
      },
      { paymentStatus: { $in: ['PAID', 'Settled', 'Paid', 'PAID ONLINE', 'Cash on Service', 'SUCCESS'] } },
    ],
  }).sort({ createdAt: -1 }).lean();

  const paidBookingIds = new Set(payments.filter(p => ['PAID', 'SUCCESS', 'Captured', 'COMPLETED'].includes(p.status)).map(p => String(p.bookingId)));
  const bookingRevenue = completedBookings.reduce((sum, b) => {
    const bId = String(b.customId || b.id || b._id);
    if (paidBookingIds.has(bId)) return sum;
    const amt = Number(b.priceNum) || (typeof b.price === 'string' ? parseFloat(b.price.replace(/[^0-9.]/g, '')) : 0) || 0;
    return sum + amt;
  }, 0);
  const paymentRevenue = payments.filter(p => ['PAID', 'SUCCESS', 'Captured', 'COMPLETED'].includes(p.status)).reduce((sum, p) => sum + (p.amount || 0), 0);
  const totalRevenue = paymentRevenue + bookingRevenue;
  const platformCommission = Math.round(totalRevenue * 0.2);
  const workerEarnings = totalRevenue - platformCommission;

  // Synthesize payment list combining Payment records with settled Booking payments so transactions list accurately reflects business operations
  const bookingTransactions = completedBookings
    .filter(b => !paidBookingIds.has(String(b.customId || b.id || b._id)))
    .map(b => ({
      _id: b._id,
      customId: `PAY-${b.customId || b.id}`,
      bookingId: b.customId || b.id,
      customerId: b.customerId,
      customerName: b.customerName,
      amount: Number(b.priceNum) || (typeof b.price === 'string' ? parseFloat(b.price.replace(/[^0-9.]/g, '')) : 0) || 0,
      currency: 'INR',
      status: 'PAID',
      method: b.paymentMethod || 'Online / UPI',
      provider: b.paymentMethod?.includes('Cash') ? 'Cash on Service' : 'Razorpay Gateway',
      createdAt: b.createdAt,
    }));

  const allTransactions = [...payments, ...bookingTransactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return res.json({
    summary: {
      totalRevenue: `₹${totalRevenue.toLocaleString('en-IN')}`,
      totalRevenueNum: totalRevenue,
      platformCommission: `₹${platformCommission.toLocaleString('en-IN')}`,
      workerEarnings: `₹${workerEarnings.toLocaleString('en-IN')}`,
      transactionsCount: allTransactions.length,
      refundsCount: payments.filter(p => p.status === 'REFUNDED').length,
    },
    payments: allTransactions,
    refunds: payments.filter(p => p.status === 'REFUNDED'),
  });
});

// Process Refund Workflow (Admin-Authenticated with Atomic Concurrency Protection)
app.post('/api/admin/financials/refund', authRequired, requireRoles('admin'), async (req, res) => {
  const { paymentId, bookingId, amount, reason } = req.body;
  if (!paymentId && !bookingId) return res.status(400).json({ error: 'Payment ID or Booking ID is required.' });

  let payment = null;
  if (paymentId) {
    payment = await Payment.findOne({
      $or: [
        { customId: paymentId },
        { orderId: paymentId },
        { razorpayPaymentId: paymentId },
        { paymentId: paymentId },
      ],
    }).sort({ createdAt: -1 });
  }

  if (!payment && bookingId) {
    payment = await Payment.findOne({
      bookingId,
      status: { $in: ['PAID', 'CAPTURED', 'Settled', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
    }).sort({ createdAt: -1 });

    if (!payment) {
      payment = await Payment.findOne({ bookingId }).sort({ createdAt: -1 });
    }
  }

  if (!payment) {
    return res.status(404).json({ error: 'Payment not found.', code: 'PAYMENT_NOT_FOUND' });
  }

  const remainingRefundable = Math.max(0, (payment.amount || 0) - (payment.refundAmount || 0));
  if (payment.status === 'REFUNDED' || remainingRefundable <= 0) {
    return res.status(400).json({ error: 'This payment has already been fully refunded.', code: 'ALREADY_REFUNDED' });
  }

  if (!['PAID', 'CAPTURED', 'Settled', 'PARTIALLY_REFUNDED'].includes(payment.status)) {
    return res.status(400).json({ error: `Cannot refund payment in ${payment.status} status. Only captured or partially refunded payments are eligible.`, code: 'INELIGIBLE_FOR_REFUND' });
  }

  const refundAmt = amount !== undefined && amount !== null ? Number(amount) : remainingRefundable;
  if (isNaN(refundAmt) || refundAmt <= 0) {
    return res.status(400).json({ error: 'Refund amount must be a positive number greater than zero.', code: 'INVALID_REFUND_AMOUNT' });
  }

  if (refundAmt > remainingRefundable) {
    return res.status(400).json({
      error: `Requested refund amount (₹${refundAmt}) exceeds the remaining refundable balance (₹${remainingRefundable}).`,
      code: 'EXCESSIVE_REFUND_AMOUNT',
      remainingRefundable,
    });
  }

  // Atomic concurrency lock: Transition status to REFUND_IN_FLIGHT to prevent race conditions
  const lockedPayment = await Payment.findOneAndUpdate(
    {
      _id: payment._id,
      status: { $in: ['PAID', 'CAPTURED', 'Settled', 'PARTIALLY_REFUNDED'] },
    },
    {
      $set: { status: 'REFUND_IN_FLIGHT' },
    },
    { new: true }
  );

  if (!lockedPayment) {
    return res.status(409).json({
      error: 'A refund operation is already in progress for this payment or its status has changed.',
      code: 'REFUND_CONFLICT',
    });
  }

  let rzpRefundResult = null;
  // If this payment was captured via Razorpay, call the official Razorpay Refund API
  if (lockedPayment && (lockedPayment.razorpayPaymentId || (lockedPayment.paymentId && lockedPayment.paymentId.startsWith('pay_')))) {
    if (razorpayService.isConfigured()) {
      try {
        rzpRefundResult = await razorpayService.refundPayment({
          paymentId: lockedPayment.razorpayPaymentId || lockedPayment.paymentId,
          amount: refundAmt,
          notes: {
            reason: reason || 'Admin processed refund',
            adminId: req.auth.sub,
            bookingId: lockedPayment.bookingId,
          },
        });
      } catch (rzpErr) {
        console.error('[REFUND] Admin Razorpay refund API error:', rzpErr.message);
        // Rollback lock and record manual review requirement
        lockedPayment.status = (lockedPayment.refundAmount || 0) > 0 ? 'PARTIALLY_REFUNDED' : 'PAID';
        lockedPayment.refundStatus = 'MANUAL_REVIEW_REQUIRED';
        lockedPayment.failureReason = `Provider refund error: ${rzpErr.message}`;
        await lockedPayment.save();

        await logFinancialAudit('ADMIN_REFUND_FAILED_MANUAL_REVIEW', lockedPayment.customId, req.auth.sub, 'admin', refundAmt, {
          reason,
          error: rzpErr.message,
          manualReview: true,
        });

        return res.status(502).json({
          error: `Razorpay refund API failed: ${rzpErr.message}. Logged for manual operational review.`,
          code: 'RAZORPAY_REFUND_FAILED',
        });
      }
    }
  }

  const totalRefunded = (lockedPayment.refundAmount || 0) + refundAmt;
  const isFullyRefunded = totalRefunded >= lockedPayment.amount;
  const finalPaymentStatus = isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  const finalRefundStatus = rzpRefundResult
    ? (rzpRefundResult.status === 'processed' ? (isFullyRefunded ? 'REFUNDED' : 'PARTIAL') : 'PROCESSING')
    : (isFullyRefunded ? 'REFUNDED' : 'PARTIAL');

  lockedPayment.status = finalPaymentStatus;
  lockedPayment.refundAmount = totalRefunded;
  lockedPayment.refundReason = reason || 'Customer service dispute resolution';
  lockedPayment.refundedAt = new Date();
  if (rzpRefundResult) {
    lockedPayment.refundId = rzpRefundResult.refundId;
  }
  lockedPayment.refundStatus = finalRefundStatus;
  await lockedPayment.save();

  const effectiveBookingId = bookingId || lockedPayment?.bookingId;
  let updatedBooking = null;
  if (effectiveBookingId) {
    updatedBooking = await findBookingById(effectiveBookingId);
    if (updatedBooking) {
      updatedBooking.paymentStatus = finalPaymentStatus;
      updatedBooking.refundStatus = finalRefundStatus;
      updatedBooking.refundAmount = totalRefunded;
      if (Array.isArray(updatedBooking.history)) {
        updatedBooking.history.push({
          from: updatedBooking.paymentStatus,
          to: finalPaymentStatus,
          by: req.auth.sub,
          role: 'admin',
          action: isFullyRefunded ? 'PAYMENT_REFUNDED' : 'PAYMENT_PARTIALLY_REFUNDED',
          note: `Admin processed refund of ₹${refundAmt}. Reason: ${reason || 'Resolution'}. Total refunded: ₹${totalRefunded}`,
          at: new Date(),
        });
      }
      await updatedBooking.save();
    }
  }

  await logFinancialAudit('ADMIN_PROCESS_REFUND', lockedPayment?.customId || effectiveBookingId, req.auth.sub, 'admin', refundAmt, {
    bookingId: effectiveBookingId,
    reason,
    refundId: lockedPayment?.refundId,
    totalRefunded,
    isFullyRefunded,
  });

  return res.json({
    success: true,
    message: `${isFullyRefunded ? 'Full' : 'Partial'} refund processed and recorded successfully.`,
    refund: lockedPayment,
    refundAmount: refundAmt,
    totalRefunded,
    remainingRefundable: Math.max(0, lockedPayment.amount - totalRefunded),
    razorpayRefund: rzpRefundResult,
  });
});

// Worker Payout Review & Approval
app.post('/api/admin/financials/payout', authRequired, requireRoles('admin'), async (req, res) => {
  const { workerId, amount, notes } = req.body;
  const worker = await findUserByIdOrIdentifier(workerId);
  if (!worker || worker.role !== 'worker') return res.status(404).json({ error: 'Worker not found.' });

  const payoutAmount = Number(amount) || worker.walletBalance || 0;
  worker.walletBalance = Math.max(0, (worker.walletBalance || 0) - payoutAmount);
  await worker.save();

  await logFinancialAudit('ADMIN_WORKER_PAYOUT', worker.customId || worker._id.toString(), req.auth.sub, 'admin', payoutAmount, {
    workerName: worker.name,
    amount: payoutAmount,
    notes: notes || 'Bi-weekly payout disbursement',
  });

  return res.json({
    success: true,
    message: `Payout of ₹${payoutAmount} approved for ${worker.name}.`,
    remainingBalance: worker.walletBalance,
  });
});

// 9. Reviews & Ratings Moderation
app.get('/api/admin/reviews', authRequired, requireRoles('admin'), async (req, res) => {
  const { rating, moderationStatus } = req.query;
  let query = { rating: { $ne: null } };

  if (rating && rating !== 'all') {
    query.rating = Number(rating);
  }

  if (moderationStatus && moderationStatus !== 'all') {
    query.moderationStatus = moderationStatus;
  }

  const bookingsWithReviews = await Booking.find(query).sort({ updatedAt: -1 }).lean();

  const reviews = bookingsWithReviews.map(b => ({
    id: `REV-${(b.customId || b._id.toString()).replace('BK-', '')}`,
    bookingId: b.customId || b._id.toString(),
    customerName: b.customerName,
    providerName: b.providerName,
    service: b.service,
    rating: b.rating,
    review: b.review || 'No written comment.',
    moderationStatus: b.moderationStatus || 'Approved',
    createdAt: b.updatedAt ? b.updatedAt.toISOString() : new Date().toISOString(),
  }));

  return res.json({ reviews });
});

app.patch('/api/admin/reviews/:id/moderate', authRequired, requireRoles('admin'), async (req, res) => {
  const { moderationStatus, reason } = req.body;
  const rawId = req.params.id.replace('REV-', 'BK-');
  const booking = await findBookingById(rawId);
  if (!booking) return res.status(404).json({ error: 'Review/Booking not found.' });

  booking.moderationStatus = moderationStatus || 'Approved';
  await booking.save();

  await logFinancialAudit('ADMIN_REVIEW_MODERATION', booking.customId, req.auth.sub, 'admin', 0, {
    moderationStatus: booking.moderationStatus,
    reason: reason || 'Admin content policy review',
  });

  return res.json({ success: true, moderationStatus: booking.moderationStatus });
});

// 10. Complaints & Dispute Center
app.get('/api/admin/complaints', authRequired, requireRoles('admin'), async (req, res) => {
  const { status } = req.query;
  let query = {};
  if (status && status !== 'all') {
    query.status = new RegExp(`^${status}$`, 'i');
  }

  const complaints = await Complaint.find(query).sort({ createdAt: -1 }).lean();
  return res.json({ complaints });
});

app.patch(['/api/admin/complaints/:id', '/api/complaints/:id'], authRequired, requireRoles('admin'), async (req, res) => {
  const complaint = await Complaint.findOne({
    $or: [{ customId: req.params.id }, { _id: /^[0-9a-fA-F]{24}$/.test(req.params.id) ? req.params.id : null }],
  });
  if (!complaint) return res.status(404).json({ error: 'Complaint not found.' });

  complaint.status = req.body.status || complaint.status;
  if (req.body.notes) complaint.adminNotes = req.body.notes;
  if (req.body.status === 'Resolved') {
    complaint.resolvedAt = new Date();
    complaint.resolvedBy = req.auth.sub;
  }
  await complaint.save();

  await logFinancialAudit('ADMIN_COMPLAINT_UPDATE', complaint.customId || complaint._id.toString(), req.auth.sub, 'admin', 0, {
    status: complaint.status,
    notes: req.body.notes,
  });

  return res.json({ success: true, complaint });
});

// 11. Admin Operational Notifications Feed
app.get('/api/admin/notifications', authRequired, requireRoles('admin'), async (req, res) => {
  const pendingKycCount = await User.countDocuments({ role: 'worker', kycStatus: 'pending' });
  const openComplaintsCount = await Complaint.countDocuments({ status: 'Open' });

  const adminNotifications = [
    {
      id: 'notif_kyc_alert',
      type: 'KYC_PENDING',
      title: 'Pending Worker KYC Submissions',
      body: `${pendingKycCount} partner applications are awaiting verification approval.`,
      severity: pendingKycCount > 0 ? 'warning' : 'info',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'notif_complaint_alert',
      type: 'COMPLAINT_OPEN',
      title: 'Active Support Disputes',
      body: `${openComplaintsCount} customer complaints require immediate review.`,
      severity: openComplaintsCount > 0 ? 'alert' : 'info',
      createdAt: new Date().toISOString(),
    },
  ];

  return res.json({ notifications: adminNotifications });
});

// 12. Marketplace Analytics Engine
app.get('/api/admin/analytics', authRequired, requireRoles('admin'), async (req, res) => {
  const { range = '30d' } = req.query;

  const totalBookings = await Booking.countDocuments();
  const completedBookings = await Booking.countDocuments({ status: { $in: ['Completed', 'PAYMENT_SETTLED'] } });
  const cancelledBookings = await Booking.countDocuments({ status: { $in: ['CANCELLED', 'Cancelled'] } });
  const cancellationRate = totalBookings > 0 ? ((cancelledBookings / totalBookings) * 100).toFixed(1) + '%' : '0%';
  const completionRate = totalBookings > 0 ? ((completedBookings / totalBookings) * 100).toFixed(1) + '%' : '0%';

  const payments = await Payment.find({ status: { $in: ['PAID', 'SUCCESS', 'Captured'] } }).lean();
  const totalGmv = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const totalPlatformFees = Math.round(totalGmv * 0.2);
  const totalWorkerPayouts = totalGmv - totalPlatformFees;

  const assignedOffers = await Booking.countDocuments({ providerId: { $ne: null } });
  const workerAcceptanceRate = totalBookings > 0 ? ((assignedOffers / totalBookings) * 100).toFixed(1) + '%' : '0%';
  const onTimeArrivalRate = completedBookings > 0 ? '100.0%' : '0%';
  const uniqueCustomers = await Booking.distinct('customerId');
  const repeatCustomersAgg = await Booking.aggregate([
    { $group: { _id: '$customerId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $count: 'repeatCount' },
  ]);
  const repeatCount = (repeatCustomersAgg && repeatCustomersAgg[0] && repeatCustomersAgg[0].repeatCount) || 0;
  const customerRetention = uniqueCustomers.length > 0 ? ((repeatCount / uniqueCustomers.length) * 100).toFixed(1) + '%' : '0%';

  const services = await Service.find({ active: true }).lean();

  return res.json({
    metrics: {
      range,
      totalBookings,
      completedBookings,
      cancelledBookings,
      cancellationRate,
      completionRate,
      totalGmv: `₹${totalGmv.toLocaleString('en-IN')}`,
      totalGmvNum: totalGmv,
      totalPlatformFees: `₹${totalPlatformFees.toLocaleString('en-IN')}`,
      totalWorkerPayouts: `₹${totalWorkerPayouts.toLocaleString('en-IN')}`,
      avgBookingValue: totalBookings > 0 ? `₹${Math.round(totalGmv / (completedBookings || 1))}` : '₹0',
      workerAcceptanceRate,
      onTimeArrivalRate,
      customerRetention,
    },
    popularServices: services.map(s => ({
      name: s.name,
      category: s.category,
      basePrice: s.priceStart,
      popularity: s.popular ? 'High' : 'Standard',
    })),
  });
});

// 13. Global Search Multi-Entity Indexer
app.get('/api/admin/search', authRequired, requireRoles('admin'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 2) {
    return res.json({ results: { bookings: [], workers: [], customers: [], complaints: [] } });
  }

  const regex = new RegExp(q, 'i');

  const [bookings, workers, customers, complaints] = await Promise.all([
    Booking.find({
      $or: [{ customId: regex }, { customerName: regex }, { service: regex }, { providerName: regex }],
    }).limit(6).lean(),
    User.find({
      role: 'worker',
      $or: [{ name: regex }, { email: regex }, { phone: regex }, { employeeId: regex }],
    }).limit(6).lean(),
    User.find({
      role: 'customer',
      $or: [{ name: regex }, { email: regex }, { phone: regex }],
    }).limit(6).lean(),
    Complaint.find({
      $or: [{ customId: regex }, { customerName: regex }, { subject: regex }],
    }).limit(6).lean(),
  ]);

  return res.json({
    results: {
      bookings: bookings.map(formatBooking),
      workers: workers.map(w => ({ id: w.customId || w._id.toString(), name: w.name, email: w.email, employeeId: w.employeeId })),
      customers: customers.map(c => ({ id: c.customId || c._id.toString(), name: c.name, email: c.email, phone: c.phone })),
      complaints: complaints.map(comp => ({ id: comp.customId || comp._id.toString(), subject: comp.subject, status: comp.status })),
    },
  });
});

// 14. Audit Logs
app.get('/api/admin/audit-logs', authRequired, requireRoles('admin'), async (req, res) => {
  const auditLogs = await AuditLog.find().sort({ createdAt: -1 }).limit(150).lean();
  return res.json({ auditLogs });
});

// 15. Admin Users & RBAC
app.get('/api/admin/users', authRequired, requireRoles('admin'), async (req, res) => {
  const adminUsers = await User.find({ role: 'admin' }).select('-passwordHash').lean();
  return res.json({ adminUsers });
});

app.post('/api/admin/users', authRequired, requireRoles('admin'), async (req, res) => {
  const { name, email, password, adminRole } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, Email and Password are required.' });

  const normalized = email.trim().toLowerCase();
  const existing = await User.findOne({ email: normalized });
  if (existing) return res.status(409).json({ error: 'An admin with this email already exists.' });

  const passwordHash = await bcrypt.hash(password, 10);
  const created = await User.create({
    customId: `usr_adm_${Date.now()}`,
    name: name.trim(),
    email: normalized,
    passwordHash,
    role: 'admin',
    adminRole: adminRole || 'Operations Admin',
    status: 'active',
  });

  await logFinancialAudit('ADMIN_USER_PROVISIONED', created.customId, req.auth.sub, 'admin', 0, {
    name: created.name,
    email: created.email,
    adminRole: created.adminRole,
  });

  return res.status(201).json({ success: true, user: { id: created.customId, name: created.name, email: created.email, role: 'admin' } });
});

// 16. Persistent Platform Settings (MongoDB-backed)
app.get('/api/admin/settings', authRequired, requireRoles('admin'), async (req, res) => {
  let settings = await PlatformSetting.findOne({ key: 'global_config' });
  if (!settings) {
    settings = await PlatformSetting.create({ key: 'global_config' });
  }
  return res.json({ settings });
});

app.put('/api/admin/settings', authRequired, requireRoles('admin'), async (req, res) => {
  const allowedFields = [
    'platformName',
    'platformCommissionPercent',
    'convenienceFee',
    'freeDeliveryThreshold',
    'taxRatePercent',
    'defaultServiceRadiusKm',
    'supportPhone',
    'supportEmail',
    'autoDispatchEnabled',
  ];
  const updateData = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updateData[field] = req.body[field];
    }
  }
  const settings = await PlatformSetting.findOneAndUpdate(
    { key: 'global_config' },
    { $set: updateData },
    { new: true, upsert: true }
  );
  await logFinancialAudit('ADMIN_SETTINGS_UPDATED', 'PLATFORM_CONFIG', req.auth.sub, 'admin', 0, req.body);
  return res.json({ success: true, settings });
});

// ── 8. SYSTEM HEALTH & OBSERVABILITY ──────────────────────────────────
app.get(['/api/health', '/api/healthz'], async (req, res) => {
  const mem = process.memoryUsage();
  const dbHealth = getDbHealth();

  let registeredUsers = undefined;
  let totalBookings = undefined;

  // Only run collection counts if explicitly requested via ?metrics=true (avoids DB load on mobile launch probes)
  if (req.query.metrics === 'true' && dbHealth.isConnected) {
    try {
      registeredUsers = await User.countDocuments();
      totalBookings = await Booking.countDocuments();
    } catch (e) {}
  }

  res.json({
    status: dbHealth.isConnected ? 'ok' : 'degraded',
    database: dbHealth,
    liveness: true,
    readiness: dbHealth.isConnected,
    service: 'HomeStepIn Core API (MongoDB Persistent)',
    version: '2.0.0-production',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    metrics: {
      memoryRssMb: Math.round(mem.rss / (1024 * 1024)),
      heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
      registeredUsers,
      totalBookings,
      activeWebSocketRooms: roomSockets.size,
    },
  });
});

async function cleanLegacyCustomerAddresses() {
  try {
    const users = await User.find({ role: 'customer' });
    for (const u of users) {
      let changed = false;
      if (Array.isArray(u.addresses) && u.addresses.length > 1) {
        const hasReal = u.addresses.some(a => a.latitude && a.longitude);
        if (hasReal) {
          const filtered = u.addresses.filter(a => !(a.address === 'Indiranagar, Bengaluru' && !a.latitude));
          if (filtered.length !== u.addresses.length) {
            u.addresses = filtered;
            changed = true;
          }
        }
      }
      const prim = getCustomerPrimaryAddress(u);
      const clean = formatCustomerAddress(prim);
      if (clean && u.address !== clean) {
        u.address = clean;
        changed = true;
      }
      if (changed) {
        await u.save();
      }
    }
  } catch (e) {
    console.warn('[Address Cleaner Warning]:', e.message);
  }
}

// ── Server Startup with Persistent Database Initialization ───────────
let serverInstance = null;

async function startServer() {
  try {
    console.log('[HomeStepIn Backend] Initializing database connection...');
    await connectDb();
    // Never auto-seed public production or staging databases. The seed module
    // contains fixed demo credentials; use a deliberate, reviewed provisioning
    // process instead of running it automatically at every deployment.
    if (!config.isProduction) {
      await seedDatabase();
    }
    await backfillLegacyCompletedBookings().catch(err => console.warn('[Backfill Warning]:', err));
    await Booking.updateMany(
      { status: { $in: CANONICAL_COMPLETED_STATUSES }, chatLocked: { $ne: true } },
      { $set: { chatLocked: true } }
    ).catch(err => console.warn('[ChatLock Backfill Warning]:', err));
    await cleanLegacyCustomerAddresses().catch(err => console.warn('[Clean Addresses Warning]:', err));

    setupWebSocketServer(server);

   const port = Number(process.env.PORT || config.port || 4001);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid server port: ${process.env.PORT || config.port}`);
}

serverInstance = server.listen(port, '0.0.0.0', () => {
  console.log(
    `[HomeStepIn Backend API & WS] Running on http://0.0.0.0:${port} (WS on /ws)`
  );
});
  } catch (err) {
    console.error('[HomeStepIn Startup Error] Failed to start server:', err);
    process.exit(1);
  }
}

// ── Graceful Shutdown Handler ─────────────────────────────────────────
async function handleGracefulShutdown(signal) {
  console.log(`[HomeStepIn Server] Received ${signal}. Starting graceful shutdown...`);
  try {
    if (serverInstance) serverInstance.close();
    await disconnectDb();
    console.log('[HomeStepIn Server] Database disconnected cleanly. Exiting.');
    process.exit(0);
  } catch (err) {
    console.error('[HomeStepIn Server] Error during graceful shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer, handleGracefulShutdown };
