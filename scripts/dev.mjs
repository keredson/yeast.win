import { existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

function canListen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

const explicitPort = process.env.BREWLOG_PORT;
let port = explicitPort ? Number(explicitPort)
  : 20_000 + createHash('sha256').update(realpathSync(projectRoot)).digest().readUInt16BE(0) % 10_000;
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid BREWLOG_PORT: ${explicitPort}`);
}
if (explicitPort && !(await canListen(port))) {
  throw new Error(`BREWLOG_PORT ${port} is already in use`);
}
if (!explicitPort) {
  const firstPort = port;
  while (!(await canListen(port))) {
    port = port === 29_999 ? 20_000 : port + 1;
    if (port === firstPort) throw new Error('No free Brewlog development API port');
  }
}

console.log(`Brewlog API port: ${port}`);
const child = spawn('yarn', ['concurrently', '-k', 'yarn dev:server', 'yarn dev:web'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: { ...process.env, BREWLOG_PORT: String(port), BREWLOG_DEV_ROOT: projectRoot }
});
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
