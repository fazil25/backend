const { Resend } = require('resend');
const config = require('../config');

let resendClient = null;
let testEmailTransport = null;

function getResendClient() {
  if (testEmailTransport) {
    return testEmailTransport;
  }
  if (!resendClient) {
    if (!config.resendApiKey) {
      return null;
    }
    resendClient = new Resend(config.resendApiKey);
  }
  return resendClient;
}

/**
 * Configure a test transport hook for automated testing.
 * @param {Function|null} transport - Custom delivery handler or null to reset.
 */
function setTestEmailTransport(transport) {
  testEmailTransport = transport;
}

/**
 * Mask an email address for safe responses & logs (e.g. j***e@example.com).
 * @param {string} email
 * @returns {string}
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const [local, domain] = email.trim().toLowerCase().split('@');
  if (!domain) return email;
  if (local.length <= 2) {
    return `${local[0]}*@${domain}`;
  }
  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 4))}${local[local.length - 1]}@${domain}`;
}

/**
 * Branded HTML email generator for HomeStepIn OTPs.
 */
function buildOtpEmailHtml({ otp, purposeLabel, expiresInMinutes = 5 }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your HomeStepIn Verification Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b1513; color: #f0fdf4; margin: 0; padding: 24px; }
    .card { max-width: 480px; margin: 0 auto; background-color: #12231f; border-radius: 16px; border: 1px solid #1e3a34; padding: 32px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); }
    .header { text-align: center; padding-bottom: 24px; border-bottom: 1px solid #1e3a34; }
    .logo { display: inline-block; font-size: 24px; font-weight: 800; color: #10b981; letter-spacing: -0.5px; text-decoration: none; }
    .tag { display: inline-block; background: #064e3b; color: #6ee7b7; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 10px; border-radius: 999px; margin-top: 8px; }
    .body { padding: 24px 0; text-align: center; }
    .instruction { font-size: 15px; color: #cbd5e1; line-height: 1.5; margin: 0 0 20px 0; }
    .otp-box { background: #071712; border: 2px dashed #10b981; border-radius: 12px; padding: 18px 24px; display: inline-block; margin: 8px auto 20px auto; }
    .otp-code { font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #34d399; font-family: 'Courier New', Courier, monospace; }
    .expiry { font-size: 13px; color: #94a3b8; margin-top: 4px; }
    .warning { background: #1f2937; border-left: 4px solid #f59e0b; padding: 12px 16px; text-align: left; border-radius: 4px; font-size: 12px; color: #d1d5db; margin-top: 20px; line-height: 1.4; }
    .footer { text-align: center; padding-top: 24px; border-top: 1px solid #1e3a34; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo">HomeStepIn</div>
      <div><span class="tag">${purposeLabel}</span></div>
    </div>
    <div class="body">
      <p class="instruction">Use the verification code below to complete your authentication request:</p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
      </div>
      <div class="expiry">Expires in ${expiresInMinutes} minutes.</div>
      <div class="warning">
        <strong>Security Notice:</strong> Never share this verification code with anyone. HomeStepIn support staff will never ask for your code. If you did not request this, you can safely ignore this email.
      </div>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} HomeStepIn Technologies. All rights reserved.
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Dispatch OTP verification email via Resend.
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.otp - 6-digit OTP code
 * @param {string} options.purpose - 'signup_verification' | 'login_2fa'
 */
async function sendOtpEmail({ to, otp, purpose }) {
  const normalizedEmail = to.trim().toLowerCase();
  const purposeLabel = purpose === 'signup_verification' ? 'Email Verification' : 'Two-Factor Authentication';
  const subject = purpose === 'signup_verification'
    ? `${otp} is your HomeStepIn verification code`
    : `${otp} is your HomeStepIn sign-in security code`;

  const html = buildOtpEmailHtml({ otp, purposeLabel, expiresInMinutes: 5 });
  const text = `Your HomeStepIn ${purposeLabel} code is: ${otp}\n\nThis code expires in 5 minutes. Do not share this code with anyone.`;

  // 1. Check for automated testing transport hook
  if (testEmailTransport) {
    return testEmailTransport.send({
      from: config.resendFromEmail,
      to: normalizedEmail,
      subject,
      html,
      text,
      otp,
      purpose,
    });
  }

  // 2. In local test environment with no real API key, simulate safe mock delivery
  if (!config.resendApiKey || config.resendApiKey === 'your_resend_api_key' || config.resendApiKey.startsWith('mock_')) {
    if (config.nodeEnv === 'development' || config.nodeEnv === 'test') {
      console.log(`[EmailService] Dev simulation: OTP email prepared for ${maskEmail(normalizedEmail)} [Purpose: ${purpose}]`);
      return { id: `sim_${Date.now()}` };
    }
    const err = new Error('Resend email delivery is not configured. RESEND_API_KEY is missing.');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }

  // 3. Dispatch using official Resend SDK
  try {
    const client = getResendClient();
    const result = await client.emails.send({
      from: config.resendFromEmail,
      to: normalizedEmail,
      subject,
      html,
      text,
    });

    if (result.error) {
      const errorMsg = String(result.error.message || '');
      const statusCode = result.error.statusCode || result.error.status;

      // Detect Resend sandbox trial unverified recipient restriction:
      const isTestingRestriction =
        statusCode === 403 ||
        errorMsg.includes('only send testing emails') ||
        errorMsg.includes('testing email address') ||
        errorMsg.includes('resend.com/domains');

      if (isTestingRestriction) {
        console.warn(
          `[Resend Sandbox Restricted] Recipient ${maskEmail(normalizedEmail)} rejected by Resend trial domain (unverified recipient).`
        );
        const err = new Error(
          'Email delivery is restricted in staging mode. Resend trial domain can only deliver verification codes to the registered account email (vinothan.aaaa@gmail.com). Please register using vinothan.aaaa@gmail.com or verify a custom domain at resend.com/domains.'
        );
        err.code = 'RESEND_RESTRICTED_RECIPIENT';
        err.status = 403;
        throw err;
      }

      if (statusCode === 429) {
        console.warn(`[Resend Rate Limited] Rate limit reached while delivering to ${maskEmail(normalizedEmail)}.`);
        const err = new Error('Email service rate limit reached. Please wait a minute and try again.');
        err.code = 'EMAIL_RATE_LIMITED';
        err.status = 429;
        throw err;
      }

      console.error(`[Resend Error] Delivery to ${maskEmail(normalizedEmail)} failed:`, result.error.message || result.error.name);
      const err = new Error(result.error.message || 'Unable to deliver verification email. Please try again.');
      err.code = 'EMAIL_DELIVERY_FAILED';
      err.status = 502;
      throw err;
    }

    return result.data;
  } catch (error) {
    if (
      error.code === 'RESEND_RESTRICTED_RECIPIENT' ||
      error.code === 'EMAIL_RATE_LIMITED' ||
      error.code === 'EMAIL_DELIVERY_FAILED' ||
      error.code === 'EMAIL_NOT_CONFIGURED'
    ) {
      throw error;
    }
    console.error(`[Resend Error] Delivery to ${maskEmail(normalizedEmail)} encountered an exception:`, error.message);
    const err = new Error('Email service temporarily unavailable. Please try again shortly.');
    err.code = 'EMAIL_DELIVERY_FAILED';
    err.status = 502;
    throw err;
  }
}

module.exports = {
  sendOtpEmail,
  setTestEmailTransport,
  maskEmail,
  buildOtpEmailHtml,
};
