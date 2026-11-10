const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

let mongoServer = null;

const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
const isHostedEnvironment = nodeEnv === 'production' || nodeEnv === 'staging';
const isLocalMongoUri = uri => /localhost|127\.0\.0\.1/i.test(uri || '');

const dbStatus = {
  isConnected: false,
  source: '',
  lastError: null,
};

mongoose.connection.on('connected', () => {
  dbStatus.isConnected = true;
  dbStatus.lastError = null;
  console.log(`[MongoDB] Connected successfully (ReadyState: ${mongoose.connection.readyState})`);
});

mongoose.connection.on('disconnected', () => {
  dbStatus.isConnected = false;
  console.log('[MongoDB] Disconnected.');
});

mongoose.connection.on('reconnected', () => {
  dbStatus.isConnected = true;
  console.log('[MongoDB] Reconnected successfully.');
});

mongoose.connection.on('error', err => {
  dbStatus.isConnected = false;
  dbStatus.lastError = err.message;
  console.error('[MongoDB Error] Database connection issue:', err.message);
});

async function connectDb() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  const configuredUri = (process.env.MONGODB_URI || '').trim();

  // A hosted service must use a real external database. Never silently fall
  // back to localhost, a local URI file, or MongoMemoryServer on Render.
  if (isHostedEnvironment && !configuredUri) {
    throw new Error(`[MongoDB] MONGODB_URI is required when NODE_ENV=${nodeEnv}. Set it to your MongoDB Atlas connection string in Render Environment Variables.`);
  }

  if (isHostedEnvironment && isLocalMongoUri(configuredUri)) {
    throw new Error('[MongoDB] Render cannot use localhost/127.0.0.1 as its database. Set MONGODB_URI to your MongoDB Atlas connection string.');
  }

  const requestedUri = configuredUri || 'mongodb://127.0.0.1:27017/homestepin';
  const parsedWorkers = Number.parseInt(process.env.CLUSTER_TOTAL_WORKERS || '1', 10);
  const totalWorkers = Number.isFinite(parsedWorkers) && parsedWorkers > 0 ? parsedWorkers : 1;
  const maxPoolSize = Math.max(5, Math.floor(40 / totalWorkers));
  const minPoolSize = Math.min(2, maxPoolSize);

  try {
    await mongoose.connect(requestedUri, {
      maxPoolSize,
      minPoolSize,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
    dbStatus.source = configuredUri ? 'configured-external' : 'local';
    dbStatus.lastError = null;
    return mongoose.connection;
  } catch (err) {
    dbStatus.lastError = err.message;

    // Do not hide invalid Atlas credentials, DNS, TLS, or network errors by
    // trying another database. Embedded MongoDB is development-only.
    if (isHostedEnvironment || (configuredUri && !isLocalMongoUri(configuredUri))) {
      throw new Error(`[MongoDB] Could not connect to the configured database: ${err.message}`);
    }
  }

  const uriFile = path.resolve(__dirname, '../data/active_mongo.json');
  const workerIndex = Number.parseInt(process.env.CLUSTER_WORKER_INDEX || '0', 10);
  const isSecondaryClusterWorker = Number.isFinite(workerIndex) && workerIndex > 0;

  if (isSecondaryClusterWorker) {
    for (let waitStep = 0; waitStep < 120; waitStep++) {
      if (fs.existsSync(uriFile)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  if (fs.existsSync(uriFile)) {
    try {
      const { uri } = JSON.parse(fs.readFileSync(uriFile, 'utf8'));
      if (uri) {
        await mongoose.connect(uri, {
          maxPoolSize,
          minPoolSize,
          serverSelectionTimeoutMS: 5000,
        });
        dbStatus.source = 'shared-local-mongo';
        dbStatus.lastError = null;
        return mongoose.connection;
      }
    } catch (err) {
      // Ignore stale local worker files and try the development fallback.
    }
  }

  if (isSecondaryClusterWorker) {
    throw new Error(`[Secondary Worker ${process.pid}] Timed out waiting for primary database initialization.`);
  }

  // Keep the embedded database only as a local-development fallback.
  try {
    console.log('[MongoDB] Starting development-only MongoMemoryServer fallback...');
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const dataDir = path.resolve(__dirname, '../data/db');
    fs.mkdirSync(dataDir, { recursive: true });

    mongoServer = await MongoMemoryServer.create({
      binary: {
        // MongoDB 7.0.3 supports Debian 12; MongoDB 4.4.x does not.
        version: process.env.MONGOMS_VERSION || '7.0.3',
      },
      instance: {
        dbName: 'homestepin',
        dbPath: dataDir,
        storageEngine: 'wiredTiger',
        launchTimeout: 60000,
      },
    });

    const embeddedUri = mongoServer.getUri();
    fs.mkdirSync(path.dirname(uriFile), { recursive: true });
    fs.writeFileSync(uriFile, JSON.stringify({ uri: embeddedUri, pid: process.pid }), { mode: 0o600 });

    await mongoose.connect(embeddedUri, {
      maxPoolSize,
      minPoolSize,
      serverSelectionTimeoutMS: 10000,
    });

    dbStatus.source = 'development-embedded';
    dbStatus.lastError = null;
    console.log(`[MongoDB] Development database online at ${dataDir}`);

    try {
      const msgCol = mongoose.connection.collection('messages');
      const indexes = await msgCol.indexes();
      const legacyIdx = indexes.find(index => index.name === 'bookingId_1_clientMsgId_1');
      if (legacyIdx) {
        await msgCol.dropIndex('bookingId_1_clientMsgId_1');
        console.log('[MongoDB] Dropped legacy bookingId_1_clientMsgId_1 index.');
      }
    } catch (indexError) {
      // The messages collection may not exist yet.
    }

    return mongoose.connection;
  } catch (err) {
    dbStatus.lastError = err.message;
    console.error('[MongoDB Fatal] Could not establish a development database connection:', err.message);
    throw err;
  }
}

async function disconnectDb() {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongoServer) {
      const uriFile = path.resolve(__dirname, '../data/active_mongo.json');
      if (fs.existsSync(uriFile)) {
        try { fs.unlinkSync(uriFile); } catch (err) { /* best-effort cleanup */ }
      }
      await mongoServer.stop({ doCleanup: false, force: false });
      mongoServer = null;
    }
    dbStatus.isConnected = false;
    console.log('[MongoDB] Connection closed cleanly.');
  } catch (err) {
    console.error('[MongoDB Error] Error during disconnection:', err.message);
  }
}

function getDbHealth() {
  const readyStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return {
    status: mongoose.connection.readyState === 1 ? 'healthy' : 'degraded',
    readyState: readyStates[mongoose.connection.readyState] || 'unknown',
    isConnected: mongoose.connection.readyState === 1,
    source: dbStatus.source,
    error: dbStatus.lastError,
  };
}

module.exports = {
  connectDb,
  disconnectDb,
  getDbHealth,
};
