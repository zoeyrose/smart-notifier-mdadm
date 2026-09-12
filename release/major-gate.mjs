import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

// env must come from the GitHub runner. Neither event payload claims nor commit
// authors establish permission: GitHub's collaborator API authorizes the actor.
export async function authorizeMajorRelease({ event, env, request = fetch, runGit = git }) {
  const targetMajor = event.inputs?.target_major ?? '';
  if (targetMajor === '') return null;
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Major releases require an explicit dispatch on main');
  }
  if (typeof targetMajor !== 'string' || !/^[1-9]\d*$/.test(targetMajor) || !Number.isSafeInteger(Number(targetMajor))) {
    throw new Error('Target major must be a positive integer within supported precision');
  }
  const actor = env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR;
  const repository = env.GITHUB_REPOSITORY;
  if (typeof actor !== 'string' || !/^[a-z\d][a-z\d_-]*(?:\[bot\])?$/i.test(actor)) {
    throw new Error('A valid GitHub runner actor is required');
  }
  if (typeof repository !== 'string' || !/^[a-z\d][a-z\d_-]*\/[a-z\d_.-]+$/i.test(repository) || ['.', '..'].includes(repository.split('/')[1])) {
    throw new Error('A valid GitHub owner/repository is required');
  }
  if (typeof env.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN.trim()) {
    throw new Error('A GitHub token is required to verify maintainer authorization');
  }
  const response = await request(`https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Could not verify maintainer authorization (${response.status})`);
  const permissions = await response.json();
  if (!['admin', 'maintain'].includes(permissions?.permission) && !['admin', 'maintain'].includes(permissions?.role_name)) {
    throw new Error('Only repository administrators or maintainers can approve a major release');
  }
  const sha = runGit(['rev-parse', 'HEAD']).trim();
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha) || sha !== env.GITHUB_SHA) {
    throw new Error('Checked-out HEAD must match the GitHub dispatch SHA');
  }
  const subject = runGit(['show', '-s', '--format=%s', sha]).replace(/\r?\n$/, '');
  if (subject !== `chore(release): major ${targetMajor}`) {
    throw new Error('HEAD must have the exact subject chore(release): major TARGET');
  }
  return { targetMajor, sha };
}

export async function runMajorGate({
  env = process.env,
  readFile = readFileSync,
  appendFile = appendFileSync,
  request = fetch,
  runGit = git,
} = {}) {
  const event = JSON.parse(readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const approved = await authorizeMajorRelease({ event, env, request, runGit });
  if (approved) {
    appendFile(env.GITHUB_ENV, `SMART_NOTIFIER_MDADM_MAJOR_APPROVED=true\nSMART_NOTIFIER_MDADM_TARGET_MAJOR=${approved.targetMajor}\nSMART_NOTIFIER_MDADM_MAJOR_COMMIT=${approved.sha}\n`);
  }
  return approved;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMajorGate();
}
