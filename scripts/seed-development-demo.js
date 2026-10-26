#!/usr/bin/env node

/**
 * =========================================================================
 *  HOMESTEPIN — DEVELOPMENT DEMO DATA SEED SCRIPT
 * =========================================================================
 *  Explicitly seeds demo customers, workers, and sample bookings.
 *  Only to be run when explicitly testing with sample demo records.
 * =========================================================================
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { connectDb, disconnectDb } = require('../src/db');
const { seedDemoData } = require('../src/seed');

async function runSeed() {
  console.log('\n[HomeStepIn Seed] Initializing development demo seed...');
  await connectDb();
  await seedDemoData();
  console.log('[HomeStepIn Seed] Development demo seed completed successfully.\n');
  await disconnectDb();
}

if (require.main === module) {
  runSeed()
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[HomeStepIn Seed Fatal]:', err);
      await disconnectDb();
      process.exit(1);
    });
}

module.exports = { runSeed };
