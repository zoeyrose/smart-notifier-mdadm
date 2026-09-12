#!/bin/sh
set -eu

validate_version() {
    case "$1" in
        ''|*[!0-9A-Za-z.+~-]*) return 1 ;;
    esac
    printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-dev\.[1-9][0-9]*\.g[0-9a-f]{12})?$'
}

if [ "${PACKAGE_VERSION:-}" ]; then
    validate_version "$PACKAGE_VERSION" || { echo 'Invalid PACKAGE_VERSION' >&2; exit 1; }
    printf '%s\n' "$PACKAGE_VERSION"
    exit 0
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tag=$(git -C "$root" describe --tags --exact-match --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)
if [ "$tag" ]; then
    version=${tag#v}
else
    sha=$(git -C "$root" rev-parse --short=12 HEAD)
    count=$(git -C "$root" rev-list --count HEAD)
    base=$(git -C "$root" describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || printf 'v0.0.0')
    version="${base#v}-dev.${count}.g${sha}"
fi
validate_version "$version" || { echo 'Could not derive a valid package version' >&2; exit 1; }
printf '%s\n' "$version"

