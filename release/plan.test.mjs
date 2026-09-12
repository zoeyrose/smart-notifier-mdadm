import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planRelease } from './plan.mjs';

const commitEnvironment = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-01-01T12:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T12:00:00Z',
};

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, env: commitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'smart-notifier-mdadm-plan-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '--initial-branch=main');
  git(cwd, 'config', 'user.name', 'Release test');
  git(cwd, 'config', 'user.email', 'release-test@example.invalid');
  await writeFile(join(cwd, 'README.md'), '# smart-notifier-mdadm\n');
  git(cwd, 'add', 'README.md');
  const commit = (message) => {
    git(cwd, 'commit', '--allow-empty', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  return { cwd, commit };
}

test('the first release is 1.0.0', async (t) => {
  const { cwd, commit } = await fixture(t);
  const sha = commit('feat: first release');
  const result = await planRelease({ cwd, branch: 'main', sha });
  assert.equal(result.version, '1.0.0');
  assert.equal(result.gitTag, 'v1.0.0');
  assert.equal(result.gitHead, sha);
});

test('ordinary main commits, including breaking syntax, produce a minor release', async (t) => {
  const { cwd, commit } = await fixture(t);
  commit('feat: initial release');
  git(cwd, 'tag', 'v1.0.0');
  const sha = commit('feat!: replace the configuration format');
  const before = git(cwd, 'show-ref');
  const first = await planRelease({ cwd, branch: 'main', sha });
  const second = await planRelease({ cwd, branch: 'main', sha });
  assert.equal(first.version, '1.1.0');
  assert.equal(first.gitHead, sha);
  assert.deepEqual(second, first);
  assert.equal(git(cwd, 'show-ref'), before, 'dry-run must not alter source refs or tags');
});

test('an event behind the current remote branch still plans that exact event', async (t) => {
  const { cwd, commit } = await fixture(t);
  commit('feat: initial release');
  git(cwd, 'tag', 'v1.0.0');
  const sha = commit('fix: event commit');
  const newer = commit('feat: newer queued commit');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', newer);
  // Also exercise the environment that GitHub supplies on a detached checkout.
  git(cwd, 'checkout', '--detach', sha);
  const before = git(cwd, 'show-ref');
  const result = await planRelease({
    cwd, branch: 'main', sha,
    env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: newer },
  });
  assert.equal(result.release, true);
  assert.equal(result.version, '1.1.0');
  assert.equal(result.gitHead, sha);
  assert.match(result.notes, /event commit/);
  assert.doesNotMatch(result.notes, /newer queued commit/);
  assert.equal(git(cwd, 'show-ref'), before);
});

test('1.1.x produces 1.1.1 when main has already released 1.5.0', async (t) => {
  const { cwd, commit } = await fixture(t);
  const old = commit('feat: release one');
  git(cwd, 'tag', 'v1.1.0');
  const main = commit('feat: modern release');
  git(cwd, 'tag', 'v1.5.0');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', main);
  git(cwd, 'checkout', '-b', '1.1.x', old);
  const sha = commit('fix: backport a compatibility correction');
  git(cwd, 'update-ref', 'refs/remotes/origin/1.1.x', sha);
  const result = await planRelease({ cwd, branch: '1.1.x', sha });
  assert.equal(result.version, '1.1.1');
  assert.equal(result.gitTag, 'v1.1.1');
  assert.equal(result.gitHead, sha);
});

test('an already tagged event can resume interrupted publication', async (t) => {
  const { cwd, commit } = await fixture(t);
  const sha = commit('feat: initial release');
  git(cwd, 'tag', 'v1.0.0');
  const result = await planRelease({ cwd, branch: 'main', sha });
  assert.equal(result.release, true);
  assert.equal(result.reused, true);
  assert.equal(result.version, '1.0.0');
  assert.equal(result.gitHead, sha);
  assert.match(result.notes, /initial release/);
  assert.deepEqual(await planRelease({ cwd, branch: 'feature/test', sha }), {
    release: false, branch: 'feature/test', gitHead: sha,
  });
});

test('creating maintenance at its main .0 base does not republish the main release', async (t) => {
  const { cwd, commit } = await fixture(t);
  const sha = commit('feat: original main release');
  git(cwd, 'tag', 'v1.1.0');
  commit('feat: later main release');
  git(cwd, 'tag', 'v1.5.0');
  git(cwd, 'checkout', '-b', '1.1.x', sha);
  const before = git(cwd, 'show-ref');
  assert.deepEqual(await planRelease({ cwd, branch: '1.1.x', sha }), {
    release: false, branch: '1.1.x', gitHead: sha,
  });
  assert.equal(git(cwd, 'show-ref'), before);
});

test('maintenance retries reuse their own release line and annotated tags', async (t) => {
  const { cwd, commit } = await fixture(t);
  const old = commit('feat: older release');
  git(cwd, 'tag', 'v1.1.0');
  commit('feat: main development');
  git(cwd, 'tag', 'v1.5.0');
  git(cwd, 'checkout', '-b', '1.1.x', old);
  const sha = commit('fix: backport');
  git(cwd, 'tag', '-a', 'v1.1.1', '-m', 'Release 1.1.1');
  git(cwd, 'tag', 'v2.0.0');
  const result = await planRelease({ cwd, branch: '1.1.x', sha });
  assert.equal(result.reused, true);
  assert.equal(result.version, '1.1.1');
  assert.match(result.notes, /backport/);
  assert.doesNotMatch(result.notes, /older release|main development/);
});

test('the major marker stays unreleased until its exact SHA is approved', async (t) => {
  const { cwd, commit } = await fixture(t);
  commit('feat: initial release');
  git(cwd, 'tag', 'v1.5.0');
  const sha = commit('chore(release): major 2');
  assert.deepEqual(await planRelease({ cwd, branch: 'main', sha }), {
    release: false, branch: 'main', gitHead: sha,
  });
  const result = await planRelease({ cwd, branch: 'main', sha, env: {
    ...process.env, SMART_NOTIFIER_MDADM_MAJOR_APPROVED: 'true',
    SMART_NOTIFIER_MDADM_TARGET_MAJOR: '2', SMART_NOTIFIER_MDADM_MAJOR_COMMIT: sha,
  } });
  assert.equal(result.version, '2.0.0');
  assert.equal(result.gitHead, sha);
});

test('the event must be a real, full commit SHA', async (t) => {
  const { cwd, commit } = await fixture(t);
  const sha = commit('feat: initial release');
  await assert.rejects(planRelease({ cwd, branch: 'main', sha: sha.slice(0, 7) }), /full commit SHA/);
  await assert.rejects(planRelease({ cwd, branch: 'main', sha: '0'.repeat(40) }));
  git(cwd, 'tag', '-a', 'v1.0.0', '-m', 'Annotated release');
  await assert.rejects(planRelease({ cwd, branch: 'main', sha: git(cwd, 'rev-parse', 'v1.0.0') }), /not a tag object/);
});
