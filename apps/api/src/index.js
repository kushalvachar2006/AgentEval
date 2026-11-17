import mongoose from 'mongoose';
import { loadConfig } from './config/env.js';
import { createApp } from './app.js';
import { models } from './models/index.js';
import { createMongoRepos } from './repos/mongo.js';
import { buildServices } from './composition.js';

const config = loadConfig();

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
await Promise.all(Object.values(models).map((m) => m.init())); // make sure indexes (incl. unique + TTL) exist

const services = buildServices({ repos: createMongoRepos(), config });
const app = createApp({
  config,
  services,
  checks: { mongo: () => mongoose.connection.db.admin().ping() },
});

const server = app.listen(config.port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'api listening', port: config.port, env: config.nodeEnv }));
});

async function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  server.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
