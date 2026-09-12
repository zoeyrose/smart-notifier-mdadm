#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=${PACKAGE_VERSION:-$($root/scripts/version.sh)}
PACKAGE_VERSION=$version "$root/scripts/version.sh" >/dev/null
output=${OUTPUT_DIR:-$root/dist}
epoch=${SOURCE_DATE_EPOCH:-0}
case "$epoch" in ''|*[!0-9]*) echo 'SOURCE_DATE_EPOCH must be a nonnegative integer' >&2; exit 1 ;; esac
work=$(mktemp -d "${TMPDIR:-/tmp}/smart-notifier-mdadm-archive.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
name="smart-notifier-mdadm-${version}"

install -d "$work/$name/sbin" "$work/$name/share/doc/smart-notifier-mdadm"
install -m 0755 "$root/src/smart-notifier-mdadm.py" "$work/$name/sbin/smart-notifier-mdadm"
install -m 0755 "$root/src/smart-notifier-mdadm-configure.py" "$work/$name/sbin/smart-notifier-mdadm-configure"
install -m 0644 "$root/README.md" "$work/$name/share/doc/smart-notifier-mdadm/README.md"
install -m 0644 "$root/LICENSE" "$work/$name/share/doc/smart-notifier-mdadm/LICENSE"
install -m 0755 "$root/scripts/install-archive.sh" "$work/$name/install.sh"
install -d "$output"
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner -C "$work" -cf "$work/archive.tar" "$name"
gzip -n -9 "$work/archive.tar"
mv "$work/archive.tar.gz" "$output/${name}-linux-all.tar.gz"
