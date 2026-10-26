const rateLimit = require('express-rate-limit');
const { verifyAccess } = require('./authTokens');
const User = require('./models/User');
const { HttpError } = require('./httpError');

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'UNAUTHORIZED', 'Session expired.'));
  try {
    const payload = verifyAccess(token);
    req.auth = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(new HttpError(401, 'UNAUTHORIZED', 'Session expired.'));
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.auth) return next(new HttpError(401, 'UNAUTHORIZED', 'Session expired.'));
    if (!roles.includes(req.auth.role)) {
      return next(new HttpError(403, 'FORBIDDEN', 'You do not have access to this.'));
    }
    next();
  };
}

async function loadUser(req, res, next) {
  try {
    const user = await User.findById(req.auth.id);
    if (!user) return next(new HttpError(401, 'UNAUTHORIZED', 'Session expired.'));
    if (user.status === 'disabled' || user.status === 'suspended') {
      return next(new HttpError(403, 'ACCOUNT_DISABLED', 'Account disabled.'));
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.', code: 'RATE_LIMIT' },
});

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.', code: 'RATE_LIMIT' },
});

module.exports = { authRequired, requireRoles, loadUser, loginLimiter, sensitiveLimiter };
