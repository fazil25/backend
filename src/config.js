require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const FORBIDDEN_PROD_VALUES = new Set([
  'dev-access-secret-change',
  'dev-refresh-secret-change',
  'dev-payment-webhook-secret',
  'dev-otp-secret-long-random-hash-key-homestepin-local',
  'replace-with-long-random-access-secret',
  'replace-with-long-random-refresh-secret',
  'replace-with-payment-webhook-secret',
  'your_long_random_secret_at_least_32_characters',
  'your_resend_api_key',
  'ChangeMe_Admin_1',
]);

function required(name, fallback, minLength = 0) {
  const value = process.env[name] || (!isProduction ? fallback : undefined);
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  if (isProduction) {
    if (FORBIDDEN_PROD_VALUES.has(value)) {
      throw new Error(`Insecure default value detected for ${name} in production mode`);
    }
    if (minLength > 0 && value.length < minLength) {
      throw new Error(`Environment variable ${name} must be at least ${minLength} characters in production`);
    }
  }
  return value;
}

function csv(name, fallback = '') {
  return (process.env[name] || fallback)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

module.exports = {
  port: Number(process.env.PORT || 4001),
  mongoUri: required('MONGODB_URI', 'mongodb://127.0.0.1:27017/homestepin'),
  jwtAccessSecret: required('JWT_ACCESS_SECRET', 'dev-access-secret-change', 32),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET', 'dev-refresh-secret-change', 32),
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || '15m',
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL || '14d',
  paymentWebhookSecret: required('PAYMENT_WEBHOOK_SECRET', 'dev-payment-webhook-secret', 16),
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || 'dev-payment-webhook-secret',
  adminBootstrapEmail: (process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@homestepin.local').toLowerCase(),
  adminBootstrapPassword: (() => {
    const pw = process.env.ADMIN_BOOTSTRAP_PASSWORD || (!isProduction ? 'ChangeMe_Admin_1' : undefined);
    if (isProduction && (!pw || FORBIDDEN_PROD_VALUES.has(pw) || pw.length < 12)) {
      throw new Error('ADMIN_BOOTSTRAP_PASSWORD must be a strong unique password of at least 12 characters in production');
    }
    return pw || 'ChangeMe_Admin_1';
  })(),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:4001',
  corsOrigins: isProduction
    ? csv('CORS_ALLOWED_ORIGINS', required('CORS_ALLOWED_ORIGINS'))
    : csv('CORS_ALLOWED_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4001,http://127.0.0.1:4001'),
  // Stored here for the forthcoming server-side Razorpay adapter. They are not
  // required until that adapter is enabled, so cash-on-service can launch safely.
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  gmailSenderEmail: process.env.GMAIL_SENDER_EMAIL || '',
  googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
  googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  googleOauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB || 8),
  enterHomeMaxMeters: Number(process.env.ENTER_HOME_MAX_METERS || 180),
  // Mappls (MapmyIndia) Credentials for server-side REST APIs
  // Supports either OAuth 2.0 (Client ID & Secret) or direct API Key / Access Token
  mapplsClientId: process.env.MAPPLS_CLIENT_ID || '',
  mapplsClientSecret: process.env.MAPPLS_CLIENT_SECRET || '',
  // Resend Email Delivery & OTP Secret
  resendApiKey: process.env.RESEND_API_KEY || '',
  resendFromEmail: process.env.RESEND_FROM_EMAIL || 'HomeStepIn <onboarding@resend.dev>',
  otpSecret: required('OTP_SECRET', 'dev-otp-secret-long-random-hash-key-homestepin-local', 32),
  nodeEnv,
  isProduction,
};
