export function generateNotes(_config, {nextRelease, commits = []}) {
  return `smart-notifier-mdadm ${nextRelease.version}\n\n` + commits.map(({hash, message}) =>
    `- ${message.split('\n')[0]} (${hash.slice(0, 7)})`).join('\n') +
    '\n\nPackages contain the same source commit. See docs/installation.md for host input permissions.\n';
}
