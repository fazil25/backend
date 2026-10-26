const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccess(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, tv: user.passwordHash ? undefined : 0 },
    config.jwtAccessSecret,
    { expiresIn: config.jwtAccessTtl },
  );
}

function signRefresh(user) {
  const token = jwt.sign({ sub: String(user._id), typ: 'refresh' }, config.jwtRefreshSecret, {
    expiresIn: config.jwtRefreshTtl,
  });
  return token;
}

function verifyAccess(token) {
  return jwt.verify(token, config.jwtAccessSecret);
}

function verifyRefresh(token) {
  return jwt.verify(token, config.jwtRefreshSecret);
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function checkPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = {
  hashToken,
  signAccess,
  signRefresh,
  verifyAccess,
  verifyRefresh,
  hashPassword,
  checkPassword,
};
