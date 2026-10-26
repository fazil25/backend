class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function publicError(err) {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message, code: err.code } };
  }
  return {
    status: 500,
    body: { error: 'Something went wrong.', code: 'SERVER_UNAVAILABLE' },
  };
}

module.exports = { HttpError, publicError };
