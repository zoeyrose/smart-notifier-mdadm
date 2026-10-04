<p align="center"><img src="assets/smart-notifier-mdadm.svg" width="112" alt="A lilac bell between two mirrored drives"></p>

# smart-notifier-mdadm

**A little purple bell for your RAID.**

Send mdadm RAID alerts to your desktop through the existing
[smart-notifier](https://packages.debian.org/stable/smart-notifier) application.
Created by [Zoey Rose](https://zoeysr.com), alongside
[velvet-scroll](https://github.com/zoeyrose/velvet-scroll).

A tiny Python adapter connects mdadm's `PROGRAM` hook to `smart-notifier --notify`.
Your existing mdadm monitor detects array events; smart-notifier displays its
usual warning window. There is no additional monitoring daemon or desktop app.

## Install

Supported integration: Debian/Ubuntu with systemd, mdadm, and the distribution's
smart-notifier package. The adapter is architecture independent. It does not
include or replace smart-notifier itself.

Download a `.deb` from [Releases](https://github.com/zoeyrose/smart-notifier-mdadm/releases),
then install that specific downloaded file and enable the connection:

```sh
sudo apt install ./smart-notifier-mdadm_<version>_all.deb
sudo smart-notifier-mdadm-configure enable
```

Replace `<version>` with the downloaded filename's version. Installation supplies
the commands; `enable` backs up and updates `/etc/mdadm/mdadm.conf`, then restarts
`mdmonitor.service`. It preserves array and mail settings and refuses to replace
an unrelated `PROGRAM` hook. See [installation and removal](docs/installation.md).

Log out and back in after first installing smart-notifier so its desktop listener
starts. For the current session, you can instead run `smart-notifier` as your
normal desktop user; leave it running while testing.

## Test a notification

While logged into your desktop:

```sh
sudo mdadm --monitor --scan --oneshot --test --no-sharing
```

Expect a **TEST ONLY** warning window for each monitored array. This does not
simulate a disk failure or deliberately degrade an array. `--no-sharing` prevents
spare movement and lets the test coexist with the normal monitor.

A successful command only confirms submission, not that a window appeared.
You need a logged-in desktop with smart-notifier listening. Notifications are
not queued for your next login and this adapter does not configure email.

## What appears

| Events | Behavior |
| --- | --- |
| Failed member or spare, degraded array, missing array or spares | Show a warning |
| RebuildFinished | Show the operation that ended when Linux exposes it: consistency check, recovery, synchronization, repair, or reshape; otherwise show a generic maintenance message |
| SpareActive | Show a status message; check the array to confirm recovery |
| TestMessage | Show an explicitly labeled test |
| NewArray, RebuildStarted, RebuildNN | Suppress routine discovery and progress |
| Unrecognized events | Show a generic warning with the event details |

Messages include the array, related device when provided, and commands to inspect
status. Submission failures go to stderr and syslog. This supplements smartd's
hardware-health warnings with mdadm's array-state warnings; neither guarantees
advance notice of every hardware failure.

mdadm also calls routine consistency-check completion `RebuildFinished`. The
adapter reads Linux sysfs through the array's block-device identity, including
named `/dev/md/` aliases, to distinguish these operations. For a check,
it includes the reported mismatch count and current member synchronization state
when available. These are best-effort snapshots, not a guarantee of drive health
or proof that the check was scheduled. Missing or unreadable status never prevents
the notification; an ongoing operation uses the generic maintenance wording.
`RebuildFinished` can also follow an aborted operation, so messages say "ended"
and advise confirming completion in the logs. Zero reported mismatches alone
does not prove that a full check completed.

## Development

Python 3.10+ and its standard library are sufficient for adapter/configuration
tests. Notification delivery requires the distribution's smart-notifier.

```sh
python3 -m unittest discover -s tests -v
```

See [builds and releases](docs/releases.md) for package builds and automatic
GitHub releases, and [contributing](CONTRIBUTING.md) for checks. No website is
included. Licensed under [MIT](LICENSE).
