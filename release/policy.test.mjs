import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCommits, verifyRelease } from './policy.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

function context(overrides = {}) {
  return {
    branch: { name: 'main', type: 'release', range: '>=1.0.0' },
    commits: [{ hash: HEAD, message: 'fix: correct mouse input' }],
    lastRelease: { version: '1.1.0', gitTag: 'v1.1.0', gitHead: OLD_HEAD },
    env: {},
    ...overrides,
  };
}

function verify(input, type, version, gitHead = HEAD) {
  verifyRelease({}, { ...input, nextRelease: { type, version, gitHead } });
}

function approvedMajor(overrides = {}) {
  return context({
    commits: [{ hash: HEAD, message: 'chore(release): major 2' }],
    env: {
      SMART_NOTIFIER_MDADM_MAJOR_APPROVED: 'true',
      SMART_NOTIFIER_MDADM_TARGET_MAJOR: '2',
      SMART_NOTIFIER_MDADM_MAJOR_COMMIT: HEAD,
    },
    ...overrides,
  });
}

for (const message of [
  'fix: correct mouse input',
  'feat: add a setting',
  'feat!: change input behavior',
  'fix(input)!: change input behavior',
  'refactor: replace the backend\n\nBREAKING CHANGE: old settings are unsupported',
  'docs: explain usage',
  'test: cover mouse input',
  'chore: refresh tooling',
  'Merge pull request #21 from contributor/feature',
  'A completely ordinary commit message',
]) {
  test(`main always selects minor without approval: ${message.split('\n')[0]}`, () => {
    const input = context({ commits: [{ hash: HEAD, message }] });
    assert.equal(analyzeCommits({}, input), 'minor');
    verify(input, 'minor', '1.2.0');
    assert.throws(() => verify(input, 'major', '2.0.0'), /requires a minor/);
  });
}

test('a batch of commits produces one minor increment with patch reset', () => {
  const input = context({
    lastRelease: { version: '1.50.7' },
    commits: [{ hash: HEAD, message: 'fix: one' }, { hash: OLD_HEAD, message: 'feat!: two' }],
  });
  assert.equal(analyzeCommits({}, input), 'minor');
  verify(input, 'minor', '1.51.0');
  assert.throws(() => verify(input, 'minor', '2.0.0'), /1\.51\.0/);
});

test('main has no fixed maximum minor number', () => {
  const input = context({ lastRelease: { version: '2.999.0' } });
  verify(input, 'minor', '2.1000.0');
});

test('an untagged main repository follows semantic-release first release 1.0.0', () => {
  const input = context({ lastRelease: {} });
  assert.equal(analyzeCommits({}, input), 'minor');
  verify(input, 'minor', '1.0.0');
  assert.throws(() => verify(input, 'major', '1.0.0'), /requires a minor/);
});

test('no commits produces no release', () => {
  const input = context({ commits: [] });
  assert.equal(analyzeCommits({}, input), null);
  assert.equal(analyzeCommits({}, approvedMajor({ commits: [] })), null);
  assert.throws(() => verify(input, 'minor', '1.2.0'), /at least one/);
});

test('maintenance stays on its minor line even after main has advanced', () => {
  const input = context({
    branch: { name: '1.1.x', type: 'maintenance', range: '>=1.1.0 <1.2.0' },
    branches: [{ name: 'main', type: 'release', range: '>=2.7.0' }],
  });
  assert.equal(analyzeCommits({}, input), 'patch');
  verify(input, 'patch', '1.1.1');
  input.lastRelease.version = '1.1.1';
  verify(input, 'patch', '1.1.2');
  assert.throws(() => verify(input, 'minor', '1.2.0'), /requires a patch/);
  assert.throws(() => verify(input, 'patch', '1.1.3'), /1\.1\.2/);
  assert.throws(() => verify(input, 'major', '2.0.0'), /requires a patch/);
});

for (const message of ['docs: update usage', 'refactor: simplify input', 'test: cover input', 'chore: refresh tooling', 'Merge pull request #22 from contributor/fix']) {
  test(`maintenance accepts supporting changes: ${message}`, () => {
    const input = context({ branch: { name: '1.1.x', type: 'maintenance' }, commits: [{ hash: HEAD, message }] });
    assert.equal(analyzeCommits({}, input), 'patch');
    verify(input, 'patch', '1.1.1');
  });
}

for (const message of ['feat: add a setting', 'feat(input): add a setting', 'fix!: incompatible fix', 'refactor(input)!: change behavior', 'fix: change\n\nBREAKING CHANGE: new config', 'fix: change\n\nBREAKING-CHANGE: new config', 'Merge pull request #23\n\nfeat: new setting']) {
  test(`maintenance rejects features and breaking changes: ${message.split('\n')[0]}`, () => {
    const input = context({ branch: { name: '1.1.x', type: 'maintenance' }, commits: [{ hash: HEAD, message }] });
    assert.throws(() => analyzeCommits({}, input), /bug fixes and supporting changes only/);
    assert.throws(() => verify(input, 'patch', '1.1.1'), /bug fixes and supporting changes only/);
  });
}

test('maintenance requires a previous release on its own line', () => {
  for (const lastRelease of [{}, { version: '1.0.0' }, { version: '1.2.0' }, { version: '2.1.0' }]) {
    assert.throws(() => analyzeCommits({}, context({ branch: { name: '1.1.x' }, lastRelease })), /own major.minor line/);
  }
});

test('unsupported branches and incompatible branch configuration are rejected', () => {
  for (const name of ['feature/example', 'next', '1.x', '01.1.x']) {
    assert.throws(() => analyzeCommits({}, context({ branch: { name } })), /only allowed on main/);
  }
  assert.throws(() => analyzeCommits({}, context({ branch: { name: 'main', type: 'prerelease' } })), /configured as a release/);
  assert.throws(() => analyzeCommits({}, context({ branch: { name: '1.1.x', type: 'release' } })), /configured as a maintenance/);
});

test('trusted workflow approval and matching HEAD authorize exactly the next major', () => {
  const input = approvedMajor();
  assert.equal(analyzeCommits({}, input), 'major');
  verify(input, 'major', '2.0.0');
  assert.throws(() => verify(input, 'major', '3.0.0'), /2\.0\.0/);
  assert.throws(() => verify(input, 'major', '2.1.0'), /2\.0\.0/);
  assert.throws(() => verify(input, 'major', '2.0.1'), /2\.0\.0/);
  assert.throws(() => verify(input, 'major', '2.0.0', OLD_HEAD), /differs from the approved/);
});

test('messages, commit authors, and plugin configuration cannot authorize majors', () => {
  const input = context({ commits: [{ hash: HEAD, message: 'chore(release): major 2', author: { email: 'maintainer@example.com' } }] });
  assert.equal(analyzeCommits({ majorApproved: true, targetMajor: 2 }, input), null);
  for (const flag of ['false', '1', 'TRUE', '']) {
    assert.equal(analyzeCommits({}, approvedMajor({ env: { ...approvedMajor().env, SMART_NOTIFIER_MDADM_MAJOR_APPROVED: flag } })), null);
  }
});

test('an unapproved major HEAD marker reserves its commit for manual dispatch', () => {
  const input = approvedMajor({ env: {} });
  assert.equal(analyzeCommits({}, input), null);
  assert.throws(() => verify(input, 'minor', '1.2.0'), /eligible unreleased commit/);
  assert.throws(() => verify(input, 'major', '2.0.0'), /eligible unreleased commit/);
  input.commits.unshift({ hash: OLD_HEAD, message: 'fix: another change after marker' });
  assert.equal(analyzeCommits({}, input), 'minor');
  verify(input, 'minor', '1.2.0', OLD_HEAD);
});

test('approval must bind the exact HEAD marker and cannot reuse an older marker', () => {
  for (const commits of [
    [{ hash: OLD_HEAD, message: 'chore(release): major 2' }],
    [{ hash: HEAD, message: 'fix: normal change' }, { hash: OLD_HEAD, message: 'chore(release): major 2' }],
    [{ hash: HEAD, message: 'chore(release): major 3' }],
    [{ hash: HEAD, message: 'chore(release): major 2 ' }],
  ]) {
    assert.throws(() => analyzeCommits({}, approvedMajor({ commits })), /approved/);
  }
  for (const hash of ['', 'HEAD', 'abc']) {
    const input = approvedMajor();
    input.env.SMART_NOTIFIER_MDADM_MAJOR_COMMIT = hash;
    assert.throws(() => analyzeCommits({}, input), /current HEAD/);
  }
});

test('major targets must increment the released major exactly once', () => {
  for (const target of ['', '1', '3', '02', '2.0', '-1', 'NaN']) {
    const input = approvedMajor();
    input.env.SMART_NOTIFIER_MDADM_TARGET_MAJOR = target;
    assert.throws(() => analyzeCommits({}, input), /exactly one greater/);
  }
  assert.throws(() => analyzeCommits({}, approvedMajor({ lastRelease: {} })), /exactly one greater/);
  assert.throws(() => analyzeCommits({}, approvedMajor({ branch: { name: '1.1.x', type: 'maintenance' } })), /only run on main/);
});

test('pre-release or invalid previous versions cannot bypass version guards', () => {
  for (const version of ['1.1.0-beta.1', 'v1.1.0', '01.1.0', 'invalid', '9007199254740992.0.0']) {
    assert.throws(() => analyzeCommits({}, context({ lastRelease: { version } })), /release version|integer precision/i);
  }
});
