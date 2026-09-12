import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {publishRelease, verifyArtifacts} from './publish.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture(t, {version = '1.2.0', branch = 'main'} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'smart-notifier-mdadm-publish-test-'));
  t.after(() => rmSync(cwd, {recursive: true, force: true}));
  mkdirSync(join(cwd, 'release-input'));
  const directory = join(cwd, 'release-assets');
  mkdirSync(directory);
  const plan = {release: true, version, gitTag: `v${version}`, gitHead: 'a'.repeat(40), branch, notes: 'Test release\n'};
  const savePlan = () => writeFileSync(join(cwd, 'release-input/release-plan.json'), JSON.stringify(plan));
  savePlan();
  for (const arch of ['all']) {
    const names = [
      `smart-notifier-mdadm_${version}_${arch}.deb`,
      `smart-notifier-mdadm-${version}-linux-${arch}.tar.gz`,
    ];
    const artifacts = names.map((name) => {
      const bytes = Buffer.from(`package bytes for ${name}\0\xff`, 'latin1');
      writeFileSync(join(directory, name), bytes);
      return {name, sha256: hash(bytes)};
    });
    writeFileSync(join(directory, `manifest-${arch}.json`), JSON.stringify({version, gitHead: plan.gitHead, arch, artifacts}));
  }
  const env = {GITHUB_REPOSITORY: 'owner/project', EXPECTED_SHA: plan.gitHead, GITHUB_SHA: plan.gitHead};
  return {cwd, directory, plan, env, savePlan};
}

function github(f, options = {}) {
  const calls = [];
  let tag = options.tag ?? null;
  let release = options.release ?? null;
  let assets = options.assets ?? [];
  const bodies = new Map();
  const absent = () => { throw Object.assign(new Error('Not found'), {stderr: Buffer.from('gh: Not Found (HTTP 404)')}); };
  const response = (value) => Buffer.from(JSON.stringify(value));
  const makeAssets = () => verifyArtifacts(f.plan, f.directory).map((asset, index) => {
    bodies.set(index + 1, readFileSync(join(f.directory, asset.name)));
    return {...asset, id: index + 1, state: 'uploaded', digest: `sha256:${asset.sha256}`};
  });
  const runGh = (args) => {
    calls.push(args);
    if (options.intercept) {
      const override = options.intercept(args, {tag, release, assets});
      if (override !== undefined) return override;
    }
    if (args[0] === 'api') {
      const path = args[1];
      if (path.includes('/git/ref/tags/')) return tag ? response(tag) : absent();
      if (path.endsWith('/git/refs')) {
        tag = {object: {type: 'commit', sha: f.plan.gitHead}};
        return response(tag);
      }
      if (path.includes('/git/tags/')) return response(options.annotated);
      if (path.endsWith('/releases/latest')) return options.latest ? response(options.latest) : absent();
      if (path.includes('/releases/tags/')) return release && !release.draft ? response(release) : absent();
      if (path.endsWith('/releases')) {
        if (args.includes('POST')) {
          assert.ok(args.includes('draft=true'));
          assert.ok(args.includes('prerelease=false'));
          release = {id: 42, tag_name: f.plan.gitTag, draft: true, prerelease: false};
          return response(release);
        }
        return response([[{id: 1, tag_name: 'v0.1.0', draft: false, prerelease: false}], release ? [release] : []]);
      }
      if (/\/releases\/\d+$/.test(path)) return release ? response(release) : absent();
      if (/\/releases\/\d+\/assets$/.test(path)) return response([assets.slice(0, 5), assets.slice(5)]);
      if (path.includes('/releases/assets/')) return bodies.get(Number(path.split('/').at(-1)));
    }
    if (args[0] === 'release' && args[1] === 'upload') {
      assert.equal(release.draft, true);
      assert.equal(args.filter((arg) => arg.startsWith(f.directory)).length, 5);
      assets = makeAssets();
      options.afterUpload?.(assets);
      return Buffer.from('');
    }
    if (args[0] === 'release' && args[1] === 'edit') {
      release.draft = false;
      return Buffer.from('');
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };
  return {calls, runGh, makeAssets, setAssets: (value) => {assets = value;}};
}

const published = (f) => ({id: 42, tag_name: f.plan.gitTag, draft: false, prerelease: false});
const immutableTag = (f) => ({object: {type: 'commit', sha: f.plan.gitHead}});
const invoke = (f, mock) => publishRelease({cwd: f.cwd, env: f.env, runGh: mock.runGh});
const edits = (mock) => mock.calls.filter((args) => args[0] === 'release' && args[1] === 'edit');

test('publishes only after verifying all five assets and rechecking the tag; reruns are idempotent', (t) => {
  const f = fixture(t);
  const mock = github(f);
  assert.equal(invoke(f, mock).published, true);
  assert.ok(edits(mock)[0].includes('--latest=true'));
  const publishedAt = mock.calls.findIndex((args) => args[0] === 'release' && args[1] === 'edit');
  const verificationAt = mock.calls.findIndex((args) => args[1]?.endsWith('/releases/42/assets'));
  assert.ok(verificationAt < publishedAt);
  assert.ok(mock.calls.slice(verificationAt, publishedAt).some((args) => args[1]?.includes('/git/ref/tags/')));
  assert.equal(invoke(f, mock).reused, true);
  assert.equal(edits(mock).length, 1);
  const sums = readFileSync(join(f.directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 4);
  for (const line of sums) {
    const [digest, name] = line.split('  ');
    assert.equal(digest, hash(readFileSync(join(f.directory, name))));
  }
});

test('local corruption, missing packages, wrong names, and symlinks fail before any GitHub call', async (t) => {
  for (const mutation of ['checksum', 'missing', 'architecture', 'unexpected', 'symlink', 'metadata-symlink', 'manifest-source']) {
    await t.test(mutation, (t) => {
      const f = fixture(t);
      const path = join(f.directory, 'smart-notifier-mdadm_1.2.0_all.deb');
      const manifestPath = join(f.directory, 'manifest-all.json');
      const manifest = JSON.parse(readFileSync(manifestPath));
      if (mutation === 'checksum') writeFileSync(path, 'tampered');
      if (mutation === 'missing') rmSync(path);
      if (mutation === 'unexpected') writeFileSync(join(f.directory, 'extra.txt'), 'unplanned');
      if (mutation === 'architecture') {manifest.artifacts[0].name = 'smart-notifier-mdadm_1.2.0_amd64.deb'; writeFileSync(manifestPath, JSON.stringify(manifest));}
      if (mutation === 'symlink') {rmSync(path); symlinkSync(manifestPath, path);}
      if (mutation === 'metadata-symlink') symlinkSync(join(f.cwd, 'missing-target'), join(f.directory, 'release.json'));
      if (mutation === 'manifest-source') {manifest.gitHead = 'b'.repeat(40); writeFileSync(manifestPath, JSON.stringify(manifest));}
      const mock = github(f);
      assert.throws(() => invoke(f, mock));
      assert.equal(mock.calls.length, 0);
    });
  }
});

test('invalid plan SHA, branch/version, and snapshot plans fail locally', async (t) => {
  for (const change of [{gitHead: 'b'.repeat(40)}, {branch: '1.1.x'}, {version: '1.2.1', gitTag: 'v1.2.1'}, {release: false}]) {
    await t.test(JSON.stringify(change), (t) => {
      const f = fixture(t); Object.assign(f.plan, change); f.savePlan();
      const mock = github(f);
      assert.throws(() => invoke(f, mock));
      assert.equal(mock.calls.length, 0);
    });
  }
});

test('existing tags are immutable and annotated tag cycles are rejected', async (t) => {
  for (const cycle of [false, true]) await t.test(String(cycle), (t) => {
    const f = fixture(t);
    const wrong = {object: {type: cycle ? 'tag' : 'commit', sha: 'b'.repeat(40)}};
    const mock = github(f, {tag: wrong, annotated: wrong});
    assert.throws(() => invoke(f, mock), cycle ? /tag chain/ : /refusing to move/);
    assert.equal(mock.calls.filter((args) => args.includes('POST') || args[0] === 'release').length, 0);
  });
});

test('published recovery verifies actual checksums, including binary download fallback', (t) => {
  const f = fixture(t);
  const mock = github(f, {tag: immutableTag(f), release: published(f)});
  const assets = mock.makeAssets();
  assets[0].digest = null;
  mock.setAssets(assets);
  assert.equal(invoke(f, mock).reused, true);
  assert.ok(mock.calls.some((args) => args.includes('Accept: application/octet-stream')));
  assert.equal(edits(mock).length, 0);
  assert.equal(mock.calls.filter((args) => args[0] === 'release').length, 0);
});

test('published mismatched, missing, duplicate, and incomplete assets cannot be accepted or overwritten', async (t) => {
  for (const mutation of ['digest', 'size', 'missing', 'duplicate', 'state']) await t.test(mutation, (t) => {
    const f = fixture(t);
    const mock = github(f, {tag: immutableTag(f), release: published(f)});
    const assets = mock.makeAssets();
    if (mutation === 'digest') assets[0].digest = `sha256:${'0'.repeat(64)}`;
    if (mutation === 'size') assets[0].size++;
    if (mutation === 'missing') assets.pop();
    if (mutation === 'duplicate') assets[1].name = assets[0].name;
    if (mutation === 'state') assets[0].state = 'starter';
    mock.setAssets(assets);
    assert.throws(() => invoke(f, mock));
    assert.equal(mock.calls.filter((args) => args[0] === 'release').length, 0);
  });
});

test('interrupted draft upload resumes, but corrupt uploads stay drafts', (t) => {
  const f = fixture(t);
  const draft = {...published(f), draft: true};
  const mock = github(f, {tag: immutableTag(f), release: draft, afterUpload: (assets) => {assets[0].digest = `sha256:${'0'.repeat(64)}`;}});
  assert.throws(() => invoke(f, mock), /checksum mismatch/);
  assert.equal(edits(mock).length, 0);
  assert.equal(draft.draft, true);
  const recovery = github(f, {tag: immutableTag(f), release: draft});
  assert.equal(invoke(f, recovery).published, true);
  assert.equal(recovery.calls.some((args) => args[0] === 'release' && args[1] === 'create'), false);
});

test('maintenance and older queued main releases never replace a newer latest release', async (t) => {
  for (const [version, branch] of [['1.1.1', '1.1.x'], ['1.2.0', 'main']]) await t.test(branch, (t) => {
    const f = fixture(t, {version, branch});
    const mock = github(f, {latest: {tag_name: 'v1.5.0'}});
    assert.equal(invoke(f, mock).published, true);
    assert.ok(edits(mock)[0].includes('--latest=false'));
  });
});

test('authentication failures are not mistaken for missing tags', (t) => {
  const f = fixture(t);
  const mock = github(f, {intercept: () => {throw Object.assign(new Error('Forbidden'), {stderr: 'HTTP 403'});}});
  assert.throws(() => invoke(f, mock), /Forbidden/);
  assert.equal(mock.calls.length, 1);
});

test('tag creation races can reuse only an identical commit', (t) => {
  const f = fixture(t);
  let raced = false;
  const mock = github(f, {intercept: (args) => {
    if (args[1]?.endsWith('/git/refs')) {
      raced = true;
      throw Object.assign(new Error('Already exists'), {stderr: 'HTTP 422'});
    }
    if (raced && args[1]?.includes('/git/ref/tags/')) return Buffer.from(JSON.stringify(immutableTag(f)));
  }});
  assert.equal(invoke(f, mock).published, true);
});

test('a tag moved after upload prevents publication', (t) => {
  const f = fixture(t);
  let moved = false;
  const mock = github(f, {
    tag: immutableTag(f),
    afterUpload: () => {moved = true;},
    intercept: (args) => {
      if (moved && args[1]?.includes('/git/ref/tags/')) {
        return Buffer.from(JSON.stringify({object: {type: 'commit', sha: 'b'.repeat(40)}}));
      }
    },
  });
  assert.throws(() => invoke(f, mock), /refusing to move/);
  assert.equal(edits(mock).length, 0);
});

test('valid annotated tags resolve to the exact source commit', (t) => {
  const f = fixture(t);
  const mock = github(f, {tag: {object: {type: 'tag', sha: 'b'.repeat(40)}}, annotated: immutableTag(f)});
  assert.equal(invoke(f, mock).published, true);
});

test('downloaded public assets are hashed when the API has no digest', (t) => {
  const f = fixture(t);
  let size;
  const mock = github(f, {
    tag: immutableTag(f), release: published(f),
    intercept: (args) => args.includes('Accept: application/octet-stream') ? Buffer.alloc(size) : undefined,
  });
  const assets = mock.makeAssets();
  size = assets[0].size;
  assets[0].digest = null;
  mock.setAssets(assets);
  assert.throws(() => invoke(f, mock), /checksum mismatch/);
  assert.equal(mock.calls.filter((args) => args[0] === 'release').length, 0);
});

test('recovers an existing draft from a later listing page when the tag endpoint returns 404', (t) => {
  const f = fixture(t);
  const draft = {...published(f), draft: true};
  const mock = github(f, {tag: immutableTag(f), release: draft});
  assert.equal(invoke(f, mock).published, true);
  assert.ok(mock.calls.some((args) => args[1]?.endsWith('/releases') && args.includes('--paginate') && args.includes('--slurp')));
  assert.equal(mock.calls.some((args) => args.includes('POST')), false, 'existing draft and tag must be reused');
  assert.equal(mock.calls.filter((args) => args[1]?.includes('/releases/tags/')).length, 1);
  assert.equal(mock.calls.filter((args) => args[1]?.endsWith('/releases/42')).length, 3);
});

test('new drafts retain the create response ID and do not require the tag endpoint to expose them', (t) => {
  const f = fixture(t);
  const mock = github(f);
  assert.equal(invoke(f, mock).published, true);
  const create = mock.calls.filter((args) => args[1]?.endsWith('/releases') && args.includes('POST'));
  assert.equal(create.length, 1);
  assert.ok(create[0].includes(`target_commitish=${f.plan.gitHead}`));
  assert.ok(create[0].includes(`tag_name=${f.plan.gitTag}`));
  assert.equal(mock.calls.filter((args) => args[1]?.includes('/releases/tags/')).length, 1);
  assert.equal(mock.calls.filter((args) => args[1]?.endsWith('/releases/42')).length, 3);
});

test('release refreshes reject a different ID before uploading assets', (t) => {
  const f = fixture(t);
  const mock = github(f, {intercept: (args, state) => {
    if (args[1]?.endsWith('/releases/42')) return Buffer.from(JSON.stringify({...state.release, id: 99}));
  }});
  assert.throws(() => invoke(f, mock), /Invalid stable GitHub release response/);
  assert.equal(mock.calls.some((args) => args[0] === 'release'), false);
});

test('ambiguous or malformed fallback listings fail before creating or uploading a release', async (t) => {
  for (const malformed of [false, true]) await t.test(String(malformed), (t) => {
    const f = fixture(t);
    const draft = {...published(f), draft: true};
    const mock = github(f, {tag: immutableTag(f), intercept: (args) => {
      if (args[1]?.endsWith('/releases')) {
        return Buffer.from(JSON.stringify(malformed ? [draft] : [[draft], [{...draft, id: 99}]]));
      }
    }});
    assert.throws(() => invoke(f, mock), malformed ? /Invalid GitHub release listing/ : /Multiple GitHub releases/);
    assert.equal(mock.calls.some((args) => args.includes('POST') || args[0] === 'release'), false);
  });
});
