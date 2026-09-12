# Contributing

Keep the adapter small and reuse the packaged smart-notifier interface. Changes
must preserve existing mdadm configuration and avoid modifying RAID arrays.

Run `python3 -m unittest discover -s tests -v`. Tests must use temporary files and
mock subprocesses; never require real array degradation, root, or a live desktop.
Run release-tool tests with `npm ci --ignore-scripts --no-audit --no-fund` followed
by `npm test`. See [release documentation](docs/releases.md) for package checks.

Use Conventional Commit PR titles, for example `fix: preserve configuration comments`
or `test: cover notification timeout`. CI validates titles, tests, package builds,
and CodeQL analysis. Review changes to configuration writes and release credentials
especially carefully. The runtime has no third-party Python dependencies.
