#!/usr/bin/python3
"""Forward mdadm's PROGRAM events to the packaged smart-notifier."""
import re
import os
from pathlib import Path
import stat
import subprocess
import sys
import syslog

DESCRIPTIONS = {
    'Fail': 'A RAID member has been marked faulty. Redundancy may be lost.',
    'FailSpare': 'A spare or replacement RAID member has failed.',
    'DegradedArray': 'The RAID array is missing an active member. Redundancy is reduced.',
    'DeviceDisappeared': 'A monitored RAID array has disappeared.',
    'SparesMissing': 'The array has fewer spare devices than configured.',
    'RebuildFinished': 'RAID maintenance has ended. This can be a consistency check, synchronization, or rebuild. Check the array status for the result.',
    'SpareActive': 'A spare has become an active RAID member. Check the array status.',
    'TestMessage': 'TEST ONLY: this verifies the mdadm desktop notification path. It does not indicate a drive failure.',
}

def maintenance_description(array, sysfs_root=Path('/sys/dev/block')):
    """Read a best-effort current snapshot, never alter an array or infer scheduling."""
    fallback = DESCRIPTIONS['RebuildFinished']
    try:
        device = os.stat(array)  # Follow /dev/md/name aliases to their block device.
        if not stat.S_ISBLK(device.st_mode):
            return fallback
        md = sysfs_root / f'{os.major(device.st_rdev)}:{os.minor(device.st_rdev)}' / 'md'
        def read(name):
            return (md / name).read_text().strip()
        action = read('last_sync_action')
        if read('sync_action') != 'idle':
            return fallback
        descriptions = {
            'check': 'RAID consistency check ended. Check logs to confirm completion.',
            'recover': 'RAID member recovery ended. Check array status to confirm recovery.',
            'recovery': 'RAID member recovery ended. Check array status to confirm recovery.',
            'resync': 'RAID synchronization ended. Check array status for the result.',
            'repair': 'RAID consistency repair ended. Check array status for the result.',
            'reshape': 'RAID reshape ended. Check array status for the result.',
        }
        description = descriptions.get(action, fallback)
        if action == 'check':
            details = []
            try:
                mismatches = int(read('mismatch_cnt'))
                if mismatches == 0:
                    details.append('No mismatches were reported.')
                elif mismatches > 0:
                    details.append(f'The check reported {mismatches} mismatched sectors. Check array status and logs.')
            except (OSError, ValueError):
                pass
            try:
                members = list(md.glob('dev-*/state'))
                if (read('degraded') == '0' and int(read('raid_disks')) > 0
                        and len(members) == int(read('raid_disks'))
                        and all(p.read_text().strip() == 'in_sync' for p in members)):
                    details.append('All RAID members are currently in sync.')
            except (OSError, ValueError):
                pass
            description += ' ' + (' '.join(details) or 'Check array status for the result.')
        # A new operation may have begun while reading the result.
        if read('sync_action') != 'idle' or read('last_sync_action') != action:
            return fallback
        return description
    except (OSError, ValueError):
        return fallback

def message_for(event, array, device=None):
    # Avoid routine discovery and progress windows at every boot or rebuild step.
    if event in ('NewArray', 'RebuildStarted') or re.fullmatch(r'Rebuild[0-9]{2}', event):
        return None
    description = DESCRIPTIONS.get(event, 'mdadm reported a RAID event. Check the system journal for details.')
    if event == 'RebuildFinished':
        description = maintenance_description(array)
    lines = ['RAID notification', '', description, '', f'Event: {event}', f'Array: {array}']
    if device:
        lines.append(f'Device: {device}')
    lines += ['', 'Check status: cat /proc/mdstat',
              'Identify drives by serial: lsblk -o NAME,MODEL,SERIAL',
              'Details: sudo journalctl -u mdmonitor.service --since today']
    return '\n'.join(lines) + '\n'

def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) not in (2, 3):
        print('Usage: smart-notifier-mdadm EVENT ARRAY [DEVICE]', file=sys.stderr)
        return 2
    message = message_for(*args)
    if message is None:
        return 0
    syslog.openlog('smart-notifier-mdadm', facility=syslog.LOG_DAEMON)
    try:
        subprocess.run(['/usr/bin/smart-notifier', '--notify'], input=message,
                       text=True, check=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as exc:
        error = f'Unable to submit {args[0]} notification for {args[1]}: {exc}'
        syslog.syslog(syslog.LOG_ERR, error)
        print(error, file=sys.stderr)
        return 1
    syslog.syslog(syslog.LOG_INFO, f'Submitted {args[0]} desktop notification for {args[1]}')
    return 0

if __name__ == '__main__':
    sys.exit(main())
