#!/bin/sh
set -eu

prefix=/usr
if [ "${PREFIX:-/usr}" != /usr ]; then
    echo 'PREFIX must be /usr to match the mdadm PROGRAM path' >&2
    exit 1
fi
destination=${DESTDIR:-}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -d "$destination$prefix/sbin" "$destination$prefix/share/doc/smart-notifier-mdadm"
install -m 0755 "$here/sbin/smart-notifier-mdadm" "$destination$prefix/sbin/smart-notifier-mdadm"
install -m 0755 "$here/sbin/smart-notifier-mdadm-configure" "$destination$prefix/sbin/smart-notifier-mdadm-configure"
install -m 0644 "$here/share/doc/smart-notifier-mdadm/README.md" "$destination$prefix/share/doc/smart-notifier-mdadm/README.md"
install -m 0644 "$here/share/doc/smart-notifier-mdadm/LICENSE" "$destination$prefix/share/doc/smart-notifier-mdadm/LICENSE"
