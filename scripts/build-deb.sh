#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "${PACKAGE_VERSION:-}" ]; then version=$PACKAGE_VERSION; else version=$("$root/scripts/version.sh"); fi
PACKAGE_VERSION=$version "$root/scripts/version.sh" >/dev/null
debian_version=$(printf '%s\n' "$version" | sed 's/-dev\./~dev./')
output=${OUTPUT_DIR:-$root/dist}
work=$(mktemp -d "${TMPDIR:-/tmp}/smart-notifier-mdadm-deb.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM

PACKAGE_VERSION=$version "$root/scripts/stage-package.sh" "$work/root"
install -d "$work/root/DEBIAN"
sed "s/@VERSION@/$debian_version/g" "$root/packaging/debian/control.in" > "$work/root/DEBIAN/control"
install -d "$output"
dpkg-deb --root-owner-group --build "$work/root" "$output/smart-notifier-mdadm_${version}_all.deb"
