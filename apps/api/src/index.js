import mongoose from 'mongoose';
import { loadConfig } from './config/env.js';
import { createApp } from './app.js';
import { models } from './models/index.js';
import { createMongoRepos } from './repos/mongo.js';
import { buildServices,buildWorker } from './composition.js';

const config = loadConfig();

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
await Promise.all(Object.values(models).map((m) => m.init())); // make sure indexes (incl. unique + TTL) exist

const repos = createMongoRepos();
const services = buildServices({ repos, config });
const app = createApp({
  config,
  services,
  checks: { mongo: () => mongoose.connection.db.admin().ping() },
});

const server = app.listen(config.port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'api listening', port: config.port, env: config.nodeEnv }));
});

let workerLoop = null;
if (process.env.RUN_INLINE_WORKER === 'true') {
  if (!config.engineToken) {
    console.error('RUN_INLINE_WORKER needs ENGINE_TOKEN');
  } else {
    ({ loop: workerLoop } = buildWorker({ repos, config, services }));
    workerLoop.start();
    console.log(JSON.stringify({ level: 'info', msg: 'inline worker started', engine: config.engineUrl }));
  }
}

async function shutdown(signal) {
  if (workerLoop) await workerLoop.stop();
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  server.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
