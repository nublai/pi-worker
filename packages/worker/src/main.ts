#!/usr/bin/env node
/** pi-worker supervisor entry: config, private directories, B2 socket, signals. */
import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './b2/app.js';
import { createB2Server, listenPrivate } from './b2/server.js';
import { resolvePaths } from './config.js';

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) {
    throw new Error(`${path} must be an owned, non-symlink 0700 directory`);
  }
}

const paths = resolvePaths();
// Every file and socket the supervisor creates is private from the moment it exists.
process.umask(0o077);
privateDir(paths.stateDir);
privateDir(dirname(paths.socketPath));

const app = createApp();
const server = createB2Server(app.handle);
await listenPrivate(server, paths.socketPath);
console.error(JSON.stringify({ event: 'listening', socket: paths.socketPath, pid: process.pid }));

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  server.close(() => {
    rmSync(paths.socketPath, { force: true });
    process.exit(0);
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
