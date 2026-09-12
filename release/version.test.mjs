import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {snapshotVersion, validateVersion} from './version.mjs';

test('artifact versions reject path, command and invalid SemVer syntax', () => {
  for (const version of ['1.2.3', '1.2.3-dev.42.gabcdef123456']) assert.equal(validateVersion(version), version);
  for (const version of ['01.2.3', '1.2', '1.2.3/evil', '$(id)', '1.2.3\nEVIL=1', undefined]) assert.throws(() => validateVersion(version));
});

test('snapshots use tags and exact commit identity without editing source files', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'smart-notifier-mdadm-version-'));
  const git = (...args) => execFileSync('git', args, {cwd, encoding:'utf8'}).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(cwd, 'README.md'), '# smart-notifier-mdadm\n');
    git('add', '.'); git('commit', '-m', 'feat: initial');
    let sha = git('rev-parse', 'HEAD');
    assert.equal(snapshotVersion(cwd, sha), `0.0.0-dev.1.g${sha.slice(0,12)}`);
    git('tag', 'v1.50.0'); git('commit', '--allow-empty', '-m', 'fix: next');
    sha = git('rev-parse', 'HEAD');
    assert.equal(snapshotVersion(cwd, sha), `1.50.0-dev.2.g${sha.slice(0,12)}`);
    assert.equal(git('status', '--porcelain'), '');
  } finally {rmSync(cwd, {recursive:true, force:true});}
});
