import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BuildInfo, DeploymentInfo } from '../shared/buildInfo.ts';

function git(root: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function version(root: string): string {
  return (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version;
}

function releaseCommit(root: string): string | null {
  const match = resolve(root).match(/\/releases\/(?:\.)?([0-9a-f]{40})(?:\.[^/]+\.tmp)?(?:\/|$)/);
  return match?.[1] || null;
}

export function sourceBuildInfo(root: string, environment: BuildInfo['environment']): BuildInfo {
  const gitCommit = git(root, ['rev-parse', 'HEAD']);
  const suppliedCommit = process.env.BREWLOG_BUILD_COMMIT;
  const commit = suppliedCommit && /^[0-9a-f]{40}$/.test(suppliedCommit) ? suppliedCommit
    : gitCommit && /^[0-9a-f]{40}$/.test(gitCommit) ? gitCommit : releaseCommit(root);
  return {
    version: version(root), environment, commit,
    dirty: environment === 'development' || !suppliedCommit
      ? !!git(root, ['status', '--porcelain', '--untracked-files=normal']) : false,
    builtAt: environment === 'production' ? process.env.BREWLOG_BUILD_TIME || new Date().toISOString() : null
  };
}

export function runtimeDeploymentInfo(root: string, distDir: string, development: boolean,
  startedAt: string): DeploymentInfo {
  if (development) return { ...sourceBuildInfo(root, 'development'), startedAt };
  try {
    const built = JSON.parse(readFileSync(resolve(distDir, 'build-info.json'), 'utf8')) as BuildInfo;
    if (built.environment === 'production' && built.version === version(root)
      && (built.commit === null || /^[0-9a-f]{40}$/.test(built.commit))
      && typeof built.dirty === 'boolean' && (built.builtAt === null || typeof built.builtAt === 'string')) {
      return { ...built, commit: built.commit || releaseCommit(root), startedAt };
    }
  } catch { /* Older builds may not contain deployment metadata. */ }
  return { ...sourceBuildInfo(root, 'production'), startedAt };
}
