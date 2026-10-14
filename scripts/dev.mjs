import { existsSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const check = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-sqlite.ts'], {
  cwd: projectRoot,
  stdio: 'inherit'
});
if (check.status !== 0) process.exit(check.status || 1);

const socketPath = resolve(projectRoot, '.brewlog-api.sock');
function socketIsLive() {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socketPath);
    connection.once('connect', () => { connection.destroy(); resolve(true); });
    connection.once('error', (error) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}
if (await socketIsLive()) throw new Error(`Brewlog API already running at ${socketPath}`);
if (existsSync(socketPath)) unlinkSync(socketPath);
console.log(`Brewlog API socket: ${socketPath}`);
const child = spawn('yarn', ['concurrently', '-k', 'yarn dev:server', 'yarn dev:web'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: { ...process.env, BREWLOG_DEV_SOCKET: socketPath, BREWLOG_DEV_ROOT: projectRoot }
});
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
