import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeMajorRelease, runMajorGate } from './major-gate.mjs';

const HEAD = 'a'.repeat(40);

function setup({ event, env, permission = { permission: 'write', role_name: 'maintain' }, status = 200, sha = HEAD, subject = 'chore(release): major 2' } = {}) {
  const requests = [];
  const gitCalls = [];
  return {
    requests,
    gitCalls,
    event: event ?? { inputs: { target_major: '2' } },
    env: {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_ACTOR: 'maintainer',
      GITHUB_REPOSITORY: 'owner/smart-notifier-mdadm',
      GITHUB_TOKEN: 'test-token',
      GITHUB_SHA: HEAD,
      GITHUB_EVENT_PATH: '/event.json',
      GITHUB_ENV: '/github.env',
      ...env,
    },
    request: async (url, options) => {
      requests.push({ url, options });
      return { ok: status === 200, status, json: async () => permission };
    },
    runGit: (args) => {
      gitCalls.push(args);
      if (args[0] === 'rev-parse') return `${sha}\n`;
      assert.deepEqual(args, ['show', '-s', '--format=%s', sha]);
      return `${subject}\n`;
    },
  };
}

test('import is side-effect free and ordinary pushes require no authorization request', async () => {
  for (const event of [{}, { inputs: {} }, { inputs: { target_major: '' } }]) {
    const input = setup({ event, env: { GITHUB_EVENT_NAME: 'push' } });
    assert.equal(await authorizeMajorRelease(input), null);
    assert.deepEqual(input.requests, []);
    assert.deepEqual(input.gitCalls, []);
  }
});

test('GitHub API admin and maintain roles authorize the matching dispatch commit', async () => {
  for (const permission of [{ permission: 'admin' }, { permission: 'write', role_name: 'maintain' }, { permission: 'maintain' }]) {
    const input = setup({ permission });
    assert.deepEqual(await authorizeMajorRelease(input), { targetMajor: '2', sha: HEAD });
    assert.equal(input.requests.length, 1);
    assert.equal(input.requests[0].url, 'https://api.github.com/repos/owner/smart-notifier-mdadm/collaborators/maintainer/permission');
    assert.equal(input.requests[0].options.headers.Authorization, 'Bearer test-token');
    assert.equal(input.requests[0].options.redirect, 'error');
    assert.deepEqual(input.gitCalls, [['rev-parse', 'HEAD'], ['show', '-s', '--format=%s', HEAD]]);
  }
});

test('reruns authorize the triggering actor using the server, even when original actor differs', async () => {
  const input = setup({ env: { GITHUB_TRIGGERING_ACTOR: 'rerun-maintainer' } });
  await authorizeMajorRelease(input);
  assert.match(input.requests[0].url, /collaborators\/rerun-maintainer\/permission$/);
});

test('write, triage, read, and malformed permission responses cannot approve majors', async () => {
  for (const permission of [{ permission: 'write' }, { permission: 'read' }, { role_name: 'triage' }, {}, null, { user: { permissions: { admin: true } } }]) {
    const input = setup({ permission });
    await assert.rejects(authorizeMajorRelease(input), /Only repository administrators or maintainers/);
    assert.deepEqual(input.gitCalls, []);
  }
});

test('forged event actor or author email cannot override runner actor authorization', async () => {
  const input = setup({
    event: { inputs: { target_major: '2' }, sender: { login: 'admin', role_name: 'admin' }, head_commit: { author: { email: 'maintainer@example.com' } } },
    env: { GITHUB_ACTOR: 'contributor' },
    permission: { permission: 'write', role_name: 'write' },
  });
  await assert.rejects(authorizeMajorRelease(input), /Only repository administrators or maintainers/);
  assert.match(input.requests[0].url, /collaborators\/contributor\/permission$/);
});

test('an explicit workflow dispatch on main is mandatory', async () => {
  for (const env of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/1.1.x' }, { GITHUB_REF: 'refs/tags/v1.1.0' }]) {
    const input = setup({ env });
    await assert.rejects(authorizeMajorRelease(input), /explicit dispatch on main/);
    assert.deepEqual(input.requests, []);
  }
});

test('major targets reject invalid integers and shell or environment injection', async () => {
  for (const target_major of ['0', '-1', '02', '2.0', ' 2', '2 ', '9007199254740992', '2\nEVIL=true', '$(touch /tmp/evil)', '`id`', 2, true]) {
    const input = setup({ event: { inputs: { target_major } } });
    await assert.rejects(authorizeMajorRelease(input), /positive integer/);
    assert.deepEqual(input.requests, []);
    assert.deepEqual(input.gitCalls, []);
  }
});

test('missing credentials and malformed repository or actor fail before any network call', async () => {
  for (const env of [{ GITHUB_TOKEN: '' }, { GITHUB_REPOSITORY: '../evil' }, { GITHUB_REPOSITORY: 'owner/..' }, { GITHUB_REPOSITORY: 'owner/repo/path' }, { GITHUB_ACTOR: '' }, { GITHUB_ACTOR: '../admin' }]) {
    const input = setup({ env });
    await assert.rejects(authorizeMajorRelease(input), /required/);
    assert.deepEqual(input.requests, []);
  }
});

test('authorization HTTP errors and network errors fail closed', async () => {
  for (const status of [401, 403, 404, 500]) {
    const input = setup({ status });
    await assert.rejects(authorizeMajorRelease(input), new RegExp(`authorization \\(${status}\\)`));
    assert.deepEqual(input.gitCalls, []);
  }
  const input = setup();
  input.request = async () => { throw new Error('network unavailable'); };
  await assert.rejects(authorizeMajorRelease(input), /network unavailable/);
  assert.deepEqual(input.gitCalls, []);
});

test('HEAD must match the dispatch SHA and be a valid object id', async () => {
  for (const sha of ['b'.repeat(40), 'HEAD', 'abc', `${HEAD}\nEVIL=true`]) {
    const input = setup({ sha });
    await assert.rejects(authorizeMajorRelease(input), /match the GitHub dispatch SHA/);
    assert.equal(input.gitCalls.length, 1);
  }
});

test('HEAD subject must exactly match the requested major marker', async () => {
  for (const subject of ['fix!: breaking change', 'chore(release): major 3', 'chore(release): major 2 ', ' chore(release): major 2', 'chore(release): major 2\nextra', 'chore(release): major 2; echo unsafe']) {
    await assert.rejects(authorizeMajorRelease(setup({ subject })), /exact subject/);
  }
});

test('the CLI wrapper appends only validated approval values to GITHUB_ENV', async () => {
  const input = setup();
  const writes = [];
  const approved = await runMajorGate({
    ...input,
    readFile: (path, encoding) => {
      assert.equal(path, '/event.json');
      assert.equal(encoding, 'utf8');
      return JSON.stringify(input.event);
    },
    appendFile: (...args) => writes.push(args),
  });
  assert.deepEqual(approved, { targetMajor: '2', sha: HEAD });
  assert.deepEqual(writes, [['/github.env', `SMART_NOTIFIER_MDADM_MAJOR_APPROVED=true\nSMART_NOTIFIER_MDADM_TARGET_MAJOR=2\nSMART_NOTIFIER_MDADM_MAJOR_COMMIT=${HEAD}\n`]]);
});

test('the CLI wrapper writes nothing on ordinary pushes or failed authorization', async () => {
  for (const options of [{ event: {} }, { permission: { permission: 'write' } }, { subject: 'fix: ordinary change' }]) {
    const input = setup(options);
    const writes = [];
    const operation = runMajorGate({ ...input, readFile: () => JSON.stringify(input.event), appendFile: (...args) => writes.push(args) });
    if (options.event) assert.equal(await operation, null);
    else await assert.rejects(operation);
    assert.deepEqual(writes, []);
  }
});
