const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAINTENANCE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.x$/;
const BREAKING = /(?:^|\n)[a-z][a-z\d-]*(?:\([^\n)]*\))?!:|(?:^|\n)BREAKING[ -]CHANGE\s*:/i;
const FEATURE = /(?:^|\n)feat(?:\([^\n)]*\))?!?:/i;

function fail(message) {
  const error = new Error(message);
  error.name = 'ReleasePolicyError';
  error.code = 'ESMARTNOTIFIERMDADMRELEASEPOLICY';
  throw error;
}

function versionParts(version) {
  if (!VERSION.test(version ?? '')) {
    fail(`Expected a stable major.minor.patch release version, received ${version}.`);
  }
  const parts = version.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    fail(`Release version exceeds supported integer precision: ${version}.`);
  }
  return parts;
}

function increment(value) {
  if (!Number.isSafeInteger(value + 1)) fail('Release version exceeds supported integer precision.');
  return value + 1;
}

function releasePlan(context) {
  const { branch, commits = [], lastRelease = {}, env = {} } = context;
  const maintenance = MAINTENANCE.exec(branch?.name ?? '');
  if (branch?.name !== 'main' && !maintenance) {
    fail(`Releases are only allowed on main or a major.minor.x maintenance branch, received ${branch?.name}.`);
  }
  const expectedBranchType = maintenance ? 'maintenance' : 'release';
  if (branch.type && branch.type !== expectedBranchType) {
    fail(`Branch ${branch.name} must be configured as a ${expectedBranchType} branch.`);
  }
  if (commits.length === 0) return null;

  const previous = lastRelease.version ? versionParts(lastRelease.version) : null;
  const majorApproved = env.SMART_NOTIFIER_MDADM_MAJOR_APPROVED === 'true';

  if (maintenance) {
    if (majorApproved) fail('An approved major release can only run on main.');
    if (!previous || previous[0] !== Number(maintenance[1]) || previous[1] !== Number(maintenance[2])) {
      fail(`Maintenance branch ${branch.name} must descend from a release on its own major.minor line.`);
    }
    const prohibited = commits.find(({ message = '' }) => FEATURE.test(message) || BREAKING.test(message));
    if (prohibited) {
      fail(`Maintenance branches accept bug fixes and supporting changes only; feature or breaking commit ${prohibited.hash ?? '(unknown)'} must go to main.`);
    }
    return { type: 'patch', version: `${previous[0]}.${previous[1]}.${increment(previous[2])}` };
  }

  if (majorApproved) {
    // These values are an assertion from the trusted workflow, not authentication.
    // The workflow must check the dispatch actor's repository permission before
    // setting them. Commit authors, messages, and plugin options grant no access.
    const target = env.SMART_NOTIFIER_MDADM_TARGET_MAJOR;
    if (!previous || !/^[1-9]\d*$/.test(target ?? '') || Number(target) !== increment(previous[0])) {
      fail('An approved major target must be exactly one greater than the last released major.');
    }
    const approvedCommit = env.SMART_NOTIFIER_MDADM_MAJOR_COMMIT;
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(approvedCommit ?? '') || commits[0].hash !== approvedCommit) {
      fail('The approved major commit must be the current HEAD commit.');
    }
    if (commits[0].message.split(/\r?\n/, 1)[0] !== `chore(release): major ${target}`) {
      fail(`The approved HEAD commit subject must be exactly chore(release): major ${target}.`);
    }
    return { type: 'major', version: `${target}.0.0`, gitHead: approvedCommit };
  }

  // Reserve an explicit HEAD marker for the separately authorized dispatch.
  // Tagging it as an ordinary minor would consume the commit before dispatch.
  if (/^chore\(release\): major [1-9]\d*$/.test(commits[0].message.split(/\r?\n/, 1)[0])) {
    return null;
  }

  // Every ordinary main push with unreleased commits produces one minor release.
  // Semantic-release's first release is 1.0.0 when no release tag exists.
  return {
    type: 'minor',
    version: previous ? `${previous[0]}.${increment(previous[1])}.0` : '1.0.0',
  };
}

export function analyzeCommits(_pluginConfig, context) {
  return releasePlan(context)?.type ?? null;
}

export function verifyRelease(_pluginConfig, context) {
  const planned = releasePlan(context);
  if (!planned) fail('A release requires at least one eligible unreleased commit.');
  const next = context.nextRelease ?? {};
  if (next.type !== planned.type || next.version !== planned.version) {
    fail(`Branch ${context.branch.name} requires a ${planned.type} release at ${planned.version}; received ${next.type} ${next.version}.`);
  }
  if (planned.gitHead && next.gitHead !== planned.gitHead) {
    fail('The release HEAD differs from the approved major commit.');
  }
}
