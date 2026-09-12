#!/usr/bin/python3
"""Forward mdadm's PROGRAM events to the packaged smart-notifier."""
import re
import subprocess
import sys
import syslog

DESCRIPTIONS = {
    'Fail': 'A RAID member has been marked faulty. Redundancy may be lost.',
    'FailSpare': 'A spare or replacement RAID member has failed.',
    'DegradedArray': 'The RAID array is missing an active member. Redundancy is reduced.',
    'DeviceDisappeared': 'A monitored RAID array has disappeared.',
    'SparesMissing': 'The array has fewer spare devices than configured.',
    'RebuildFinished': 'RAID rebuilding has ended. Check the array status to confirm success.',
    'SpareActive': 'A spare has become an active RAID member. Check the array status.',
    'TestMessage': 'TEST ONLY: this verifies the mdadm desktop notification path. It does not indicate a drive failure.',
}

def message_for(event, array, device=None):
    # Avoid routine discovery and progress windows at every boot or rebuild step.
    if event in ('NewArray', 'RebuildStarted') or re.fullmatch(r'Rebuild[0-9]{2}', event):
        return None
    description = DESCRIPTIONS.get(event, 'mdadm reported a RAID event. Check the system journal for details.')
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
