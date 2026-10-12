import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
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

let port = Number(process.env.BREWLOG_PORT || 3001);
if (!process.env.BREWLOG_PORT) {
  while (!(await canListen(port))) port += 1;
}

console.log(`Brewlog API port: ${port}`);
const child = spawn('yarn', ['concurrently', '-k', 'yarn dev:server', 'yarn dev:web'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: { ...process.env, BREWLOG_PORT: String(port) }
});
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
