// Background worker: consumes the MongoDB job queue and runs evaluations (calls agent endpoints, asks the Python engine).
import mongoose from 'mongoose';
import { loadConfig } from './config/env.js';
import { models } from './models/index.js';
import { createMongoRepos } from './repos/mongo.js';
import { buildWorker } from './composition.js';

const config = loadConfig();
if (!config.engineToken) { console.error('ENGINE_TOKEN is required for the worker. Run `npm run init:env` (it creates one).'); process.exit(1); }

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
await Promise.all(Object.values(models).map((m) => m.init()));

const { loop } = buildWorker({ repos: createMongoRepos(), config });
loop.start();
console.log(JSON.stringify({ level: 'info', msg: 'worker started', concurrency: config.workerConcurrency, engine: config.engineUrl }));

async function stop(signal) {
  console.log(JSON.stringify({ level: 'info', msg: 'worker stopping', signal }));
  await loop.stop();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
