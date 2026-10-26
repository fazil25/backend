const Razorpay = require('razorpay');
const crypto = require('crypto');
const config = require('../config');

let razorpayClient = null;

function isConfigured() {
  const keyId = config.razorpayKeyId !== undefined ? config.razorpayKeyId : process.env.RAZORPAY_KEY_ID;
  const keySecret = config.razorpayKeySecret !== undefined ? config.razorpayKeySecret : process.env.RAZORPAY_KEY_SECRET;
  return Boolean(keyId && keySecret && String(keyId).trim().length > 0 && String(keySecret).trim().length > 0);
}

function getRazorpayClient() {
  const keyId = String(config.razorpayKeyId !== undefined ? config.razorpayKeyId : (process.env.RAZORPAY_KEY_ID || '')).trim();
  const keySecret = String(config.razorpayKeySecret !== undefined ? config.razorpayKeySecret : (process.env.RAZORPAY_KEY_SECRET || '')).trim();

  if (!keyId || !keySecret) {
    const error = new Error('Razorpay credentials are not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the backend environment.');
    error.code = 'RAZORPAY_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }

  if (!razorpayClient || razorpayClient.key_id !== keyId) {
    razorpayClient = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
    razorpayClient.key_id = keyId;
  }
  return razorpayClient;
}

function getPublicConfig() {
  const keyId = (config.razorpayKeyId || process.env.RAZORPAY_KEY_ID || '').trim();
  const configured = isConfigured();
  return {
    keyId: configured ? keyId : null,
    currency: 'INR',
    isConfigured: configured,
    mode: keyId.startsWith('rzp_live_') ? 'live' : 'test',
  };
}

async function createOrder({ amount, currency = 'INR', receipt, notes = {} }) {
  const numAmount = Number(amount);
  if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
    const error = new Error('Invalid order amount. Amount must be a positive number.');
    error.code = 'INVALID_AMOUNT';
    error.status = 400;
    throw error;
  }

  // Convert to paise (smallest currency unit for INR)
  const amountInPaise = Math.round(numAmount * 100);

  const client = getRazorpayClient();
  const options = {
    amount: amountInPaise,
    currency: currency.toUpperCase(),
    receipt: receipt || `rcpt_${Date.now()}`,
    notes: notes || {},
  };

  const order = await client.orders.create(options);
  return {
    orderId: order.id,
    amount: numAmount,
    amountInPaise: order.amount,
    currency: order.currency,
    receipt: order.receipt,
    status: order.status,
    rawOrder: order,
  };
}

function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) {
    return false;
  }
  const keySecret = (config.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keySecret) {
    return false;
  }

  try {
    const payload = `${orderId}|${paymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(payload)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const providedBuf = Buffer.from(signature, 'utf8');

    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch (err) {
    return false;
  }
}

function verifyWebhookSignature({ rawBody, signature, secret }) {
  const webhookSecret = (secret || config.razorpayWebhookSecret || config.paymentWebhookSecret || '').trim();
  if (!webhookSecret || !signature || !rawBody) {
    return false;
  }

  try {
    const bodyStr = Buffer.isBuffer(rawBody)
      ? rawBody.toString('utf8')
      : typeof rawBody === 'string'
      ? rawBody
      : JSON.stringify(rawBody);

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(bodyStr)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const providedBuf = Buffer.from(signature, 'utf8');

    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch (err) {
    return false;
  }
}

async function fetchPayment(paymentId) {
  const client = getRazorpayClient();
  return await client.payments.fetch(paymentId);
}

async function fetchOrder(orderId) {
  const client = getRazorpayClient();
  return await client.orders.fetch(orderId);
}

async function refundPayment({ paymentId, amount, notes = {}, receipt }) {
  const client = getRazorpayClient();
  const options = {
    notes: notes || {},
  };
  if (amount && Number(amount) > 0) {
    options.amount = Math.round(Number(amount) * 100);
  }
  if (receipt) {
    options.receipt = receipt;
  }
  const refund = await client.payments.refund(paymentId, options);
  return {
    refundId: refund.id,
    paymentId: refund.payment_id,
    amount: (refund.amount || 0) / 100,
    currency: refund.currency,
    status: refund.status,
    rawRefund: refund,
  };
}

module.exports = {
  isConfigured,
  getRazorpayClient,
  getPublicConfig,
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchPayment,
  fetchOrder,
  refundPayment,
};
