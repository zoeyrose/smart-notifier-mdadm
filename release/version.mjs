import {execFileSync} from 'node:child_process';

export function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev\.\d+\.g[0-9a-f]{7,40})?$/.test(version)) throw new Error('Invalid package version');
  return version;
}

// CI snapshots identify the event commit even when it already has a stable tag.
export function snapshotVersion(cwd, sha) {
  const git = (...args) => execFileSync('git', args, {cwd, encoding:'utf8'}).trim();
  const count = git('rev-list', '--count', sha);
  const short = git('rev-parse', '--short=12', sha);
  let base = '0.0.0';
  try {
    const tag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', sha);
    if (/^v\d+\.\d+\.\d+$/.test(tag)) base = tag.slice(1);
  } catch { /* Before the first stable release. */ }
  return validateVersion(`${base}-dev.${count}.g${short}`);
}
