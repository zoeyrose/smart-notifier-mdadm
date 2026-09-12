#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semanticRelease from 'semantic-release';
import { generateNotes } from './notes.mjs';

const releaseDirectory = dirname(fileURLToPath(import.meta.url));
const isReleaseBranch = (branch) => branch === 'main' || /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.x$/.test(branch);
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// env-ci must inspect the temporary checkout, not the runner's event branch.
// Credentials are unnecessary: all semantic-release Git operations stay local.
function planningEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SystemRoot'].includes(key)
      || key.startsWith('SMART_NOTIFIER_MDADM_')));
}

function existingRelease(cwd, branch, gitHead) {
  const tags = git(cwd, 'tag', '--merged', gitHead, '--sort=-version:refname')
    .split('\n').filter((tag) => stableTag.test(tag));
  const matchesBranch = (tag) => {
    const [, major, minor, patch] = stableTag.exec(tag);
    // The .0 tag belongs to main: creating a maintenance branch at that base
    // must not retry publication with different branch metadata.
    return branch === 'main' ? patch === '0' : patch !== '0' && branch === `${major}.${minor}.x`;
  };
  const gitTag = tags.find((tag) => matchesBranch(tag)
    && git(cwd, 'rev-parse', `${tag}^{commit}`) === gitHead);
  if (!gitTag) return null;
  const previous = tags.slice(tags.indexOf(gitTag) + 1).find((tag) =>
    git(cwd, 'rev-parse', `${tag}^{commit}`) !== gitHead);
  const hashes = git(cwd, 'log', '--format=%H', previous ? `${previous}..${gitHead}` : gitHead)
    .split('\n').filter(Boolean);
  const version = gitTag.slice(1);
  const commits = hashes.map((hash) => ({ hash, message: git(cwd, 'show', '-s', '--format=%B', hash) }));
  return {
    release: true, reused: true, branch, version, gitHead, gitTag,
    notes: generateNotes({}, { nextRelease: { version }, commits }),
  };
}

/** Calculate a release at an immutable event commit without publishing anything. */
export async function planRelease({ cwd = process.cwd(), branch, sha, env = process.env }) {
  cwd = resolve(cwd);
  if (typeof branch !== 'string' || !branch) throw new Error('A branch is required');
  if (typeof sha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha)) {
    throw new Error('An exact, full commit SHA is required');
  }
  const gitHead = git(cwd, 'rev-parse', '--verify', `${sha}^{commit}`);
  if (gitHead !== sha.toLowerCase()) throw new Error('The SHA must identify a commit, not a tag object');
  const noRelease = { release: false, branch, gitHead };
  if (!isReleaseBranch(branch)) return noRelease;
  // A previous publication may have created its immutable tag before failing
  // while uploading assets. Reuse it so a retry can finish that same release.
  const existing = existingRelease(cwd, branch, gitHead);
  if (existing) return existing;

  const temporary = await mkdtemp(join(tmpdir(), 'smart-notifier-mdadm-release-'));
  try {
    const mirror = join(temporary, 'remote.git');
    const checkout = join(temporary, 'checkout');
    // A mirror also preserves semantic-release channel notes. --no-local avoids
    // sharing objects or refs that semantic-release might modify with the source.
    git(cwd, 'clone', '--mirror', '--no-local', '--', cwd, mirror);
    const refs = git(mirror, 'for-each-ref', '--format=%(refname) %(objectname)',
      'refs/heads', 'refs/remotes/origin').split('\n').filter(Boolean);
    const branches = new Map();
    for (const prefix of ['refs/heads/', 'refs/remotes/origin/']) {
      for (const line of refs) {
        const [ref, commit] = line.split(' ');
        if (ref.startsWith(prefix) && isReleaseBranch(ref.slice(prefix.length))) {
          branches.set(ref.slice(prefix.length), commit);
        }
      }
    }
    for (const line of refs) {
      const [ref] = line.split(' ');
      if (ref.startsWith('refs/heads/')) git(mirror, 'update-ref', '-d', ref);
    }
    branches.set(branch, gitHead);
    for (const [name, commit] of branches) {
      git(mirror, 'update-ref', `refs/heads/${name}`, commit);
    }
    git(mirror, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
    git(cwd, 'clone', '--no-local', '--branch', branch, '--', mirror, checkout);
    const result = await semanticRelease({
      repositoryUrl: mirror,
      dryRun: true,
      noCi: true,
      branches: ['+([0-9]).+([0-9]).x', 'main'],
      tagFormat: 'v${version}',
      plugins: [join(releaseDirectory, 'policy.mjs'), join(releaseDirectory, 'notes.mjs')],
    }, {
      cwd: checkout,
      env: planningEnvironment(env),
      stdout: process.stderr,
      stderr: process.stderr,
    });
    // Adding an existing release to a maintenance channel can return releases
    // without nextRelease; it is not a new package publication.
    if (!result?.nextRelease) return noRelease;
    const { version, gitTag, notes, gitHead: plannedHead } = result.nextRelease;
    if (plannedHead !== gitHead) throw new Error('Release planner changed the requested commit');
    return { release: true, branch, version, gitHead, gitTag, notes };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--branch', '--sha', '--output'].includes(name) || !args[index + 1]) {
      throw new Error('Usage: node release/plan.mjs --branch BRANCH --sha SHA [--output FILE]');
    }
    options[name.slice(2)] = args[index + 1];
  }
  const output = `${JSON.stringify(await planRelease(options), null, 2)}\n`;
  if (options.output) await writeFile(resolve(options.output), output);
  else process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
