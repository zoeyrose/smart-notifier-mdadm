#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
destination=${1:?usage: stage-package.sh DESTINATION}
version=${PACKAGE_VERSION:-$($root/scripts/version.sh)}
PACKAGE_VERSION=$version "$root/scripts/version.sh" >/dev/null

install -d "$destination/usr/sbin" "$destination/usr/share/doc/smart-notifier-mdadm"
install -m 0755 "$root/src/smart-notifier-mdadm.py" "$destination/usr/sbin/smart-notifier-mdadm"
install -m 0755 "$root/src/smart-notifier-mdadm-configure.py" "$destination/usr/sbin/smart-notifier-mdadm-configure"
install -m 0644 "$root/README.md" "$destination/usr/share/doc/smart-notifier-mdadm/README.md"
install -m 0644 "$root/LICENSE" "$destination/usr/share/doc/smart-notifier-mdadm/LICENSE"

