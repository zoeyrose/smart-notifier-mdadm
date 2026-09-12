#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=${PACKAGE_VERSION:-$($root/scripts/version.sh)}
install -d "$root/dist"
if find "$root/dist" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo 'dist must be empty before building packages' >&2
    exit 1
fi
PACKAGE_VERSION=$version "$root/scripts/build-deb.sh"
PACKAGE_VERSION=$version "$root/scripts/build-archive.sh"
