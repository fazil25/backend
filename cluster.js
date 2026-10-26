/**
 * HOMESTEPIN — MULTI-PROCESS CLUSTER CONTROLLER
 * 
 * Configurable worker topology (e.g. 2, 4, 8 workers).
 * Features:
 * - Round-robin TCP socket distribution across workers on PORT=4001
 * - Cross-worker WebSocket fanout via IPC bus (CLUSTER_WS_BROADCAST)
 * - Self-healing worker supervision: crashes automatically restart clean replacements
 * - Scaled MongoDB connection pool coordination to avoid database overload
 */

const cluster = require('cluster');
const os = require('os');
const path = require('path');
const fs = require('fs');

const NUM_WORKERS = parseInt(process.env.CLUSTER_WORKERS || '4', 10);

// Guard against accidental double clustering (e.g. running inside PM2 cluster mode)
if (process.env.NODE_APP_INSTANCE !== undefined && (process.env.exec_mode === 'cluster_mode' || process.env.instances)) {
  console.error('\n🛑 [FATAL] DOUBLE CLUSTERING DETECTED!');
  console.error('`cluster.js` manages worker processes internally. Do NOT launch it with `pm2 start -i <instances>`.');
  console.error('Recommended options:');
  console.error('  1. Native Node cluster: `node backend/cluster.js`');
  console.error('  2. PM2 as process supervisor (fork mode): `pm2 start backend/cluster.js --name homestepin-cluster`');
  console.error('  3. PM2 managing workers directly: `pm2 start backend/server.js -i 4 --name homestepin-api`\n');
  process.exit(1);
}

if (cluster.isPrimary || cluster.isMaster) {
  console.log(`========================================================================`);
  console.log(`🚀 HOMESTEPIN MULTI-PROCESS CLUSTER CONTROLLER (PRIMARY PID: ${process.pid})`);
  console.log(`   Configured Workers: ${NUM_WORKERS} | Available CPU Cores: ${os.cpus().length}`);
  console.log(`========================================================================\n`);


  // Inter-process router for WebSocket broadcast synchronization
  function forwardClusterMessage(senderWorker, message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'CLUSTER_WS_BROADCAST') {
      for (const id in cluster.workers) {
        const targetWorker = cluster.workers[id];
        if (targetWorker && targetWorker.id !== senderWorker.id && targetWorker.isConnected()) {
          try {
            targetWorker.send(message);
          } catch (err) {
            // Non-fatal IPC forwarding error
          }
        }
      }
    }
  }

  // Fork workers sequentially so Worker 0 initializes MongoDB storage cleanly
  async function startWorkers() {
    console.log(`[Primary] Starting Worker 0 to establish database initialization...`);
    const worker0 = cluster.fork({
      CLUSTER_WORKER_INDEX: '0',
      CLUSTER_TOTAL_WORKERS: String(NUM_WORKERS),
    });
    worker0.on('message', (msg) => forwardClusterMessage(worker0, msg));

    // Wait for Worker 0 to establish persistent MongoDB and write active_mongo.json (up to 60s)
    const mongoUriFile = path.resolve(__dirname, 'data/active_mongo.json');
    for (let waitCount = 0; waitCount < 120; waitCount++) {
      if (fs.existsSync(mongoUriFile)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 1500));


    for (let i = 1; i < NUM_WORKERS; i++) {
      console.log(`[Primary] Starting Worker ${i}...`);
      const worker = cluster.fork({
        CLUSTER_WORKER_INDEX: String(i),
        CLUSTER_TOTAL_WORKERS: String(NUM_WORKERS),
      });
      worker.on('message', (msg) => forwardClusterMessage(worker, msg));
      await new Promise((r) => setTimeout(r, 800));
    }

    console.log(`\n✔ [Primary] All ${NUM_WORKERS} cluster workers are active and operational.\n`);
  }

  startWorkers();

  cluster.on('online', (worker) => {
    console.log(`  [Worker Online] PID: ${worker.process.pid} (Worker ID: ${worker.id})`);
  });

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`⚠️ [Worker Exit] PID: ${worker.process.pid} died (code: ${code}, signal: ${signal}).`);
    if (!worker.exitedAfterDisconnect) {
      console.log(`  🔄 [Self-Healing] Spawning replacement worker to preserve cluster capacity...`);
      const replacement = cluster.fork({
        CLUSTER_WORKER_INDEX: String(worker.id - 1),
        CLUSTER_TOTAL_WORKERS: String(NUM_WORKERS),
      });
      replacement.on('message', (msg) => forwardClusterMessage(replacement, msg));
    }
  });

  // Graceful cluster shutdown handling
  let isShuttingDown = false;
  const shutdownCluster = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('\n[Cluster Primary] Initiating graceful cluster shutdown...');
    for (const id in cluster.workers) {
      const w = cluster.workers[id];
      if (w && w.isConnected()) {
        w.disconnect();
      }
    }
    setTimeout(() => process.exit(0), 3000);
  };

  process.on('SIGTERM', shutdownCluster);
  process.on('SIGINT', shutdownCluster);

} else {
  // Worker process runs server.js
  const { startServer } = require('./server.js');
  startServer().catch((err) => {
    console.error(`[Worker ${process.pid} Startup Fatal]:`, err.message);
    process.exit(1);
  });
}
