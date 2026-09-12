import {readFileSync, readdirSync, writeFileSync, openSync, fstatSync, closeSync, constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const runGitHub = (args) => execFileSync('gh', args, {
  stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024,
});

function regularFile(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`Expected a regular file: ${path}`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function verifyArtifacts(plan, directory) {
  const files = [];
  for (const arch of ['all']) {
    const manifestName = `manifest-${arch}.json`;
    const manifest = JSON.parse(regularFile(join(directory, manifestName)));
    if (manifest.version !== plan.version || manifest.gitHead !== plan.gitHead || manifest.arch !== arch
      || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2) {
      throw new Error('Artifact manifest differs from release plan');
    }
    const expected = new Set([
      `smart-notifier-mdadm_${plan.version}_${arch}.deb`,
      `smart-notifier-mdadm-${plan.version}-linux-${arch}.tar.gz`,
    ]);
    for (const artifact of manifest.artifacts) {
      if (!artifact || !expected.delete(artifact.name)) throw new Error('Invalid or duplicate artifact name');
      if (!/^[a-f\d]{64}$/.test(artifact.sha256 ?? '')
        || sha256(regularFile(join(directory, artifact.name))) !== artifact.sha256) {
        throw new Error(`Artifact checksum mismatch: ${artifact.name}`);
      }
      files.push(artifact.name);
    }
    files.push(manifestName);
  }
  const metadata = ['release.json', 'SHA256SUMS'];
  const entries = readdirSync(directory);
  if (entries.some((name) => !files.includes(name) && !metadata.includes(name))) {
    throw new Error('Unexpected files in release artifact directory');
  }
  for (const name of metadata) {
    const path = join(directory, name);
    if (entries.includes(name)) regularFile(path);
  }
  writeFileSync(join(directory, 'release.json'), JSON.stringify({
    version: plan.version, gitHead: plan.gitHead, branch: plan.branch,
  }, null, 2) + '\n');
  files.push('release.json');
  writeFileSync(join(directory, 'SHA256SUMS'), files.slice().sort().map((name) =>
    `${sha256(regularFile(join(directory, name)))}  ${name}`).join('\n') + '\n');
  files.push('SHA256SUMS');
  return files.map((name) => {
    const bytes = regularFile(join(directory, name));
    return {name, size: bytes.length, sha256: sha256(bytes)};
  });
}

export function publishRelease({cwd = process.cwd(), env = process.env, runGh = runGitHub} = {}) {
  const plan = JSON.parse(regularFile(join(cwd, 'release-input/release-plan.json')));
  const repository = env.GITHUB_REPOSITORY;
  if (plan.release !== true || !stableVersion.test(plan.version) || plan.gitTag !== `v${plan.version}`) {
    throw new Error('Invalid stable release plan');
  }
  if (!/^[0-9a-f]{40}$/.test(plan.gitHead) || plan.gitHead !== env.EXPECTED_SHA || plan.gitHead !== env.GITHUB_SHA) {
    throw new Error('Release plan does not match this workflow commit');
  }
  const [major, minor, patch] = plan.version.split('.');
  if (plan.branch === 'main' ? patch !== '0' : plan.branch !== `${major}.${minor}.x`) {
    throw new Error('Release version does not match its branch');
  }
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  const directory = join(cwd, 'release-assets');
  // Finish all local verification before the first remote mutation.
  const artifacts = verifyArtifacts(plan, directory);
  const notesPath = join(cwd, 'release-notes.md');
  writeFileSync(notesPath, typeof plan.notes === 'string' ? plan.notes : `smart-notifier-mdadm ${plan.version}\n`);
  const gh = (...args) => runGh(args);
  const api = (path, {optional = false, method, fields = {}, typedFields = {}} = {}) => {
    const args = ['api', path];
    if (method) args.push('--method', method);
    for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`);
    for (const [key, value] of Object.entries(typedFields)) args.push('-F', `${key}=${value}`);
    try { return JSON.parse(gh(...args)); }
    catch (error) {
      if (optional && /\bHTTP 404\b/.test(String(error.stderr ?? ''))) return null;
      throw error;
    }
  };
  const prefix = `repos/${repository}`;
  const tagPath = `${prefix}/git/ref/tags/${plan.gitTag}`;
  const verifyTag = (tag) => {
    let object = tag?.object;
    const visited = new Set();
    while (object?.type === 'tag') {
      if (!/^[a-f\d]{40}$/.test(object.sha) || visited.has(object.sha) || visited.size >= 16) {
        throw new Error('Invalid annotated tag chain');
      }
      visited.add(object.sha);
      object = api(`${prefix}/git/tags/${object.sha}`).object;
    }
    if (object?.type !== 'commit' || object.sha !== plan.gitHead) {
      throw new Error('Existing tag points to different source; refusing to move it');
    }
  };
  const tag = api(tagPath, {optional: true});
  if (tag) verifyTag(tag);
  else {
    try {
      api(`${prefix}/git/refs`, {method: 'POST', fields: {ref: `refs/tags/${plan.gitTag}`, sha: plan.gitHead}});
    } catch (error) {
      // Another retry can win the create race; only an identical tag is usable.
      const concurrent = api(tagPath, {optional: true});
      if (!concurrent) throw error;
      verifyTag(concurrent);
    }
    verifyTag(api(tagPath));
  }
  const releasePath = `${prefix}/releases/tags/${plan.gitTag}`;
  const checkRelease = (release, expectedId) => {
    if (!release || release.tag_name !== plan.gitTag || !Number.isSafeInteger(release.id)
      || (expectedId !== undefined && release.id !== expectedId)
      || typeof release.draft !== 'boolean' || release.prerelease !== false) {
      throw new Error('Invalid stable GitHub release response');
    }
    return release;
  };
  const findRelease = () => {
    const release = api(releasePath, {optional: true});
    if (release) return checkRelease(release);
    // The tag endpoint can return 404 for drafts. The authenticated listing
    // includes them, even when the draft is beyond the first page of releases.
    const pages = JSON.parse(gh('api', `${prefix}/releases`, '--paginate', '--slurp'));
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new Error('Invalid GitHub release listing');
    }
    const matches = pages.flat().filter((item) => item?.tag_name === plan.gitTag);
    if (matches.length > 1) throw new Error('Multiple GitHub releases match the planned tag');
    return matches.length ? checkRelease(matches[0]) : null;
  };
  const verifyRemoteAssets = (release) => {
    const pages = JSON.parse(gh('api', `${prefix}/releases/${release.id}/assets`, '--paginate', '--slurp'));
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error('Invalid release asset response');
    const remote = pages.flat();
    if (remote.length !== artifacts.length) throw new Error('Release asset set differs from verified artifacts');
    for (const expected of artifacts) {
      const matches = remote.filter((asset) => asset.name === expected.name);
      if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== expected.size) {
        throw new Error(`Release asset missing, duplicate, incomplete, or wrong size: ${expected.name}`);
      }
      const asset = matches[0];
      let digest;
      if (typeof asset.digest === 'string' && /^sha256:[a-f\d]{64}$/.test(asset.digest)) {
        digest = asset.digest.slice(7);
      } else {
        if (!Number.isSafeInteger(asset.id)) throw new Error('Invalid release asset ID');
        const bytes = gh('api', `${prefix}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream');
        if (Buffer.byteLength(bytes) !== expected.size) throw new Error(`Downloaded release asset has wrong size: ${expected.name}`);
        digest = sha256(bytes);
      }
      if (digest !== expected.sha256) throw new Error(`Published artifact checksum mismatch: ${expected.name}`);
    }
  };
  let release = findRelease();
  if (release && !release.draft) {
    verifyRemoteAssets(release);
    verifyTag(api(tagPath));
    return {published: false, reused: true, url: `https://github.com/${repository}/releases/tag/${plan.gitTag}`};
  }
  if (!release) {
    release = checkRelease(api(`${prefix}/releases`, {
      method: 'POST',
      fields: {tag_name: plan.gitTag, target_commitish: plan.gitHead,
        name: `smart-notifier-mdadm ${plan.version}`, body: readFileSync(notesPath, 'utf8')},
      typedFields: {draft: true, prerelease: false},
    }));
  }
  const releaseId = release.id;
  const refreshRelease = () => checkRelease(api(`${prefix}/releases/${releaseId}`), releaseId);
  release = refreshRelease();
  if (!release.draft) throw new Error('Release became public before asset upload');
  gh('release', 'upload', plan.gitTag, '--repo', repository, '--clobber',
    ...artifacts.map(({name}) => join(directory, name)));
  release = refreshRelease();
  verifyRemoteAssets(release);
  verifyTag(api(tagPath));
  if (!release.draft) return {published: false, reused: true, url: `https://github.com/${repository}/releases/tag/${plan.gitTag}`};
  const latest = api(`${prefix}/releases/latest`, {optional: true});
  const newer = (a, b) => {
    const x = a.split('.').map(BigInt), y = b.split('.').map(BigInt);
    for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] > y[index];
    return false;
  };
  const markLatest = plan.branch === 'main' && (!latest
    || (typeof latest.tag_name === 'string' && stableVersion.test(latest.tag_name.slice(1))
      && latest.tag_name.startsWith('v') && newer(plan.version, latest.tag_name.slice(1))));
  gh('release', 'edit', plan.gitTag, '--repo', repository, '--draft=false', `--latest=${markLatest}`);
  const published = refreshRelease();
  if (published.draft) throw new Error('GitHub release is still a draft after publication');
  return {published: true, reused: false, url: `https://github.com/${repository}/releases/tag/${plan.gitTag}`};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = publishRelease();
  console.log(`${result.reused ? 'Release already published' : 'Published'}: ${result.url}`);
}
