#!/usr/bin/python3
"""Explicitly enable or disable mdadm PROGRAM integration; never run by dpkg."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

CONFIG = Path('/etc/mdadm/mdadm.conf')
TARGET = '/usr/sbin/smart-notifier-mdadm'
LEGACY = Path('/usr/local/sbin/mdadm-smart-notifier')
LEGACY_MARKER = b'# Managed by raid-notifications'
LOCK = Path('/run/lock/smart-notifier-mdadm-configure.lock')
BACKUPS = Path('/var/backups/smart-notifier-mdadm')


def read_regular(path):
    """Read one regular, unlinked-to-other-files inode without following symlinks."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError(f'Expected a regular file with one link: {path}')
        return source.read(), info


def legacy_is_managed():
    try:
        data, _ = read_regular(LEGACY)
    except OSError:
        return False
    return LEGACY_MARKER in data.splitlines()


def line_words(line):
    """Tokenize mdadm words, retaining raw spelling and the actual comment offset.

    Unlike shell syntax, a hash inside a word is literal and backslashes do
    not escape characters. Multiline quoted words require manual review.
    """
    words = []
    index = 0
    while index < len(line):
        if line[index] in ' \t\n':
            index += 1
            continue
        if line[index] == '#':
            return words, index
        start = index
        value = []
        while index < len(line) and line[index] not in ' \t\n':
            character = line[index]
            if character in ('"', "'"):
                index += 1
                close = line.find(character, index)
                if close == -1 or '\n' in line[index:close]:
                    raise RuntimeError('Unterminated or multiline quoted mdadm word needs manual review.')
                value.append(line[index:close])
                index = close + 1
            else:
                value.append(character)
                index += 1
        words.append((''.join(value), line[start:index]))
    return words, None


def program_keyword(word):
    return len(word) >= 3 and 'PROGRAM'.startswith(word.upper())


def configure(text, action, managed_legacy=False):
    """Transform a simple PROGRAM directive; preserve unrelated logical lines."""
    lines = text.split('\n')
    lines = [line + '\n' for line in lines[:-1]] + ([lines[-1]] if lines[-1] else [])
    programs = []
    previous_program = False
    for index, line in enumerate(lines):
        words, comment = line_words(line)
        if not words:
            continue
        fields = [word[0] for word in words]
        is_program = program_keyword(fields[0])
        if line.startswith((' ', '\t')):
            # Ordinary ARRAY, DEVICE, etc. continuations remain untouched.
            # An indented PROGRAM is not a directive; do not silently enable
            # around that likely configuration mistake or edit its parent.
            if previous_program or is_program:
                raise RuntimeError('Continued or indented PROGRAM syntax needs manual review.')
            continue
        previous_program = is_program
        if is_program:
            programs.append((index, fields, words, comment))
    if len(programs) > 1:
        raise RuntimeError('Multiple mdadm PROGRAM directives need manual review.')
    if programs:
        index, fields, words, comment = programs[0]
        # Recognize quoted/abbreviated keywords as conflicts, while editing
        # only the deliberately supported unquoted, full directive spelling.
        simple = all(value == raw for value, raw in words)
        if simple and fields == ['PROGRAM', TARGET]:
            if action == 'disable':
                lines[index] = lines[index][comment:] if comment is not None else ''
                return ''.join(lines)
            return text
        if simple and action == 'enable' and fields == ['PROGRAM', str(LEGACY)] and managed_legacy:
            lines[index] = lines[index].replace(str(LEGACY), TARGET, 1)
            return ''.join(lines)
        raise RuntimeError('An existing mdadm PROGRAM conflicts; refusing to replace or remove it.')
    if action == 'disable':
        return text
    return text + ('' if not text or text.endswith('\n') else '\n') + f'PROGRAM {TARGET}\n'


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def unchanged(path, before, info):
    current, current_info = read_regular(path)
    attrs = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid', 'st_gid')
    if current != before or any(getattr(current_info, key) != getattr(info, key) for key in attrs):
        raise RuntimeError('mdadm.conf changed during preparation; review it and retry.')


def atomic_write(path, data, before, info):
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            os.fchown(output.fileno(), info.st_uid, info.st_gid)
            os.fchmod(output.fileno(), stat.S_IMODE(info.st_mode))
            # Retain ACLs, security labels and other metadata where present.
            for key in os.listxattr(path, follow_symlinks=False):
                os.setxattr(output.fileno(), key, os.getxattr(path, key, follow_symlinks=False))
            os.fsync(output.fileno())
        unchanged(path, before, info)
        os.replace(name, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def configuration_lock():
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            raise RuntimeError('Unsafe configuration lock file.')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError('Another configuration command is running; retry later.') from exc
        yield
    finally:
        os.close(fd)


def backup_configuration(before):
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = BACKUPS.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError(f'Backup directory must be owned by root and private: {BACKUPS}')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ-')
    directory = Path(tempfile.mkdtemp(prefix=stamp, dir=BACKUPS))
    with (directory / 'mdadm.conf').open('xb') as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(before)
        output.flush()
        os.fsync(output.fileno())
    sync_directory(directory)
    sync_directory(BACKUPS)
    return directory / 'mdadm.conf'


def apply(action):
    if os.geteuid() != 0:
        raise RuntimeError('Run this command as root (with sudo).')
    if action == 'enable' and not all(os.access(path, os.X_OK) for path in (TARGET, '/usr/bin/smart-notifier')):
        raise RuntimeError('Install smart-notifier-mdadm and smart-notifier before enabling.')
    with configuration_lock():
        before, info = read_regular(CONFIG)
        after = configure(before.decode('utf-8', errors='surrogateescape'), action,
                          managed_legacy=legacy_is_managed()).encode('utf-8', errors='surrogateescape')
        backup = None
        if after != before:
            backup = backup_configuration(before)
            atomic_write(CONFIG, after, before, info)
            print(f'Configuration updated. Previous configuration: {backup}', flush=True)
        else:
            print(f'Configuration already {"enabled" if action == "enable" else "disabled"}.', flush=True)
        # Always restart, including retries after a previous restart failure.
        try:
            subprocess.run(['/usr/bin/systemctl', 'restart', 'mdmonitor.service'], check=True, timeout=60)
            subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', 'mdmonitor.service'], check=True, timeout=15)
        except (OSError, subprocess.SubprocessError) as exc:
            raise RuntimeError('mdmonitor restart/verification failed. Configuration remains '
                               f'{"enabled" if action == "enable" else "disabled"}; review the service and retry. '
                               + (f'Backup: {backup}. ' if backup else '') + str(exc)) from exc
    print(f'mdadm desktop notifications {"enabled" if action == "enable" else "disabled"}; mdmonitor is active.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('enable', 'disable'))
    args = parser.parse_args(argv)
    try:
        apply(args.action)
    except (RuntimeError, OSError, ValueError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
