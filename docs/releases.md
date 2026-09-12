# Builds and releases

GitHub Actions tests every pushed branch and pull request and builds two
architecture-independent artifacts: a Debian/Ubuntu `.deb` and a portable
`.tar.gz` install archive. Download development packages from Actions artifacts;
stable versions appear on GitHub Releases only after the release pipeline passes.

## Local checks and packages

```sh
python3 -m unittest discover -s tests -v
npm ci --ignore-scripts --no-audit --no-fund
npm test
make clean packages
```

Package builds require Python 3, `dpkg-deb` (from `dpkg`), and standard Linux
shell/archive tools. Node 22.14+ is for release planning and its tests; it is not
a runtime dependency of the adapter. CI uses Node 24. A C compiler is not needed for this Python adapter. Packages are written under `dist/`, which must be empty before a build, and
can be built without root. Neither builder installs the adapter on the build host.

Package versions come from Git tags or an explicit `PACKAGE_VERSION`; an
untagged checkout produces a development version with its commit hash.

```sh
PACKAGE_VERSION=1.0.0 ./scripts/build-packages.sh
```

The Debian package installs executables and documentation and declares runtime
dependencies. It has no maintainer hooks that edit mdadm configuration. Enable
the connection explicitly after installation, and disable it before removal.
The install archive also requires separately installed runtime dependencies.

## Version policy

This repository follows velvet-scroll's automatic version policy:

- The first automated release from `main` is `1.0.0`.
- Ordinary subsequent main releases advance the minor, including fixes and docs.
- Maintenance branches named `N.N.x` advance only that line's patch version.
- Maintenance rejects features and breaking-change markers.
- Other branches and pull requests build development snapshots, never stable releases.
- Breaking-change notation alone does not authorize a major release.

For a deliberate major release, first merge a PR whose squash title is exactly
`chore(release): major 2` (substitute the next major), then dispatch **Build and
release** on that same main commit with `target_major` set to `2`. The gate checks
the actor's GitHub admin/maintain permission and the exact release marker. Leave
the input blank for an ordinary retry.

Version planning uses the triggering commit. Package manifests record its SHA,
version, architecture-independent designation, and SHA-256 checksums. Publication
validates those artifacts and uses a draft release until all assets are uploaded.
Reruns may finish an interrupted draft; they may not move existing tags or replace
published assets. Only the publication job receives repository-content write
permission. Pull-request jobs use a read-only token.

## Repository setup

The intended GitHub settings match velvet-scroll, adapted to these checks:

- **Smart Notifier mdadm validation**, **CodeQL validation**, and
  **Conventional PR title** required for changes through pull requests.
- Main and maintenance branches require linear history and resolved conversations;
  force pushes and deletion are blocked, as are changes to `v*` release tags.
- Squash merging uses PR title/body and deletes merged feature branches.
- GitHub Actions tokens default to read-only and cannot approve pull requests.
- CodeQL analyzes Python, JavaScript release tooling, and Actions workflows.
- Dependabot updates the build tooling and action dependencies.

Workflow files configure CI. Branch protections and security settings are GitHub
repository settings and must also be applied when a new remote is created.
There is no Pages deployment or website build.
