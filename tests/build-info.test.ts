import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeDeploymentInfo, sourceBuildInfo } from '../server/buildInfo.ts';

test('archive releases report their commit even without a git checkout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yeast-build-info-'));
  const commit = 'a'.repeat(40);
  const release = join(directory, 'releases', commit);
  const temporary = join(directory, 'releases', `.${commit}.run-1.tmp`);
  mkdirSync(join(release, 'dist'), { recursive: true });
  mkdirSync(temporary);
  writeFileSync(join(release, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(release, 'dist', 'build-info.json'), JSON.stringify({ version: '0.1.0',
    environment: 'production', commit: null, dirty: false, builtAt: '2026-10-15T00:00:00Z' }));
  const previous = process.env.BREWLOG_BUILD_COMMIT;
  delete process.env.BREWLOG_BUILD_COMMIT;
  try {
    assert.equal(sourceBuildInfo(temporary, 'production').commit, commit);
    assert.equal(runtimeDeploymentInfo(release, join(release, 'dist'), false, 'now').commit, commit);
  } finally {
    if (previous === undefined) delete process.env.BREWLOG_BUILD_COMMIT;
    else process.env.BREWLOG_BUILD_COMMIT = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
