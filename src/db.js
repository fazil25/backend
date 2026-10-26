const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

let mongoServer = null;

// Track connection state
let dbStatus = {
  isConnected: false,
  uri: '',
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

  const requestedUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/homestepin';
  const totalWorkers = parseInt(process.env.CLUSTER_TOTAL_WORKERS || '1', 10);
  const maxPoolSize = Math.max(15, Math.floor(100 / totalWorkers));
  const minPoolSize = Math.max(2, Math.floor(10 / totalWorkers));

  // Attempt 1: Direct connection to specified MONGODB_URI
  try {
    await mongoose.connect(requestedUri, {
      maxPoolSize,
      minPoolSize,
      serverSelectionTimeoutMS: 1500,
      connectTimeoutMS: 3000,
    });
    dbStatus.uri = requestedUri.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@'); // Redact credentials in logs
    dbStatus.source = 'external';
    return mongoose.connection;
  } catch (err) {
    // If external URI was explicitly configured to remote cloud (like mongodb+srv), throw error
    if (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes('127.0.0.1') && !process.env.MONGODB_URI.includes('localhost')) {
      throw err;
    }
  }

  // Attempt 2: Check for active local MongoDB instance URI file (e.g. if server.js or primary cluster is running)
  const uriFile = path.resolve(__dirname, '../data/active_mongo.json');
  const isSecondaryClusterWorker = parseInt(process.env.CLUSTER_WORKER_INDEX || '0', 10) > 0;

  if (isSecondaryClusterWorker) {
    // Wait for Primary / Worker 0 to initialize database (up to 60s)
    for (let waitStep = 0; waitStep < 120; waitStep++) {
      if (fs.existsSync(uriFile)) break;
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (fs.existsSync(uriFile)) {
    try {
      const { uri } = JSON.parse(fs.readFileSync(uriFile, 'utf8'));
      if (uri) {
        await mongoose.connect(uri, {
          maxPoolSize,
          minPoolSize,
          serverSelectionTimeoutMS: 4000,
        });
        dbStatus.uri = uri;
        dbStatus.source = 'shared-local-mongo';
        return mongoose.connection;
      }
    } catch (e) {
      // Stale or dead instance file, continue to Attempt 3
    }
  }

  if (isSecondaryClusterWorker) {
    throw new Error(`[Secondary Worker ${process.pid}] Timed out waiting for primary database initialization.`);
  }


  // Attempt 3: Persistent embedded MongoDB instance using MongoMemoryServer with disk storage
  try {
    console.log(`[MongoDB] Initializing persistent local MongoDB storage engine...`);
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const dataDir = path.resolve(__dirname, '../data/db');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    mongoServer = await MongoMemoryServer.create({
      binary: {
        version: '4.4.26',
      },
      instance: {
        dbName: 'homestepin',
        dbPath: dataDir,
        storageEngine: 'wiredTiger',
        launchTimeout: 60000,
      },
    });

    const embeddedUri = mongoServer.getUri();
    fs.writeFileSync(uriFile, JSON.stringify({ uri: embeddedUri, pid: process.pid }));

    await mongoose.connect(embeddedUri, {
      maxPoolSize: 100,
      minPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });

    dbStatus.uri = 'local-persistent-wiredTiger (data/db)';
    dbStatus.source = 'persistent-embedded';
    console.log(`[MongoDB] Persistent database online using WiredTiger engine at ${dataDir}`);

    try {
      const msgCol = mongoose.connection.collection('messages');
      const indexes = await msgCol.indexes();
      const legacyIdx = indexes.find(i => i.name === 'bookingId_1_clientMsgId_1');
      if (legacyIdx) {
        await msgCol.dropIndex('bookingId_1_clientMsgId_1');
        console.log('[MongoDB] Dropped legacy bookingId_1_clientMsgId_1 index for clean schema synchronization');
      }
    } catch (idxErr) {
      // Ignore if collection not created yet
    }

    return mongoose.connection;
  } catch (embeddedErr) {
    console.error(`[MongoDB Fatal] Could not establish database connection:`, embeddedErr.message);
    dbStatus.lastError = embeddedErr.message;
    throw embeddedErr;
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
        try { fs.unlinkSync(uriFile); } catch (e) {}
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
