# Installation and operation

## Requirements

Use Debian or Ubuntu with Python 3.10+, systemd, mdadm, and smart-notifier.
The configuration helper expects `/etc/mdadm/mdadm.conf` and `mdmonitor.service`.
The graphical window and session autostart belong to the smart-notifier package.

The `.deb` declares its runtime dependencies. Its installation does not rewrite
mdadm configuration or restart monitoring automatically. After installation run:

```sh
sudo smart-notifier-mdadm-configure enable
```

The helper adds `PROGRAM /usr/sbin/smart-notifier-mdadm`, saves a timestamped
backup under `/var/backups/smart-notifier-mdadm`, and restarts and checks the
monitor. Repeating enable is supported. Review reported errors: a failed restart
can leave the new configuration in place; the helper prints the backup location.

Existing array declarations, email settings, and comments are preserved.
A conflicting or duplicate PROGRAM must be resolved manually: mdadm has one
notification-program slot. The helper also recognizes the earlier locally
prepared `/usr/local/sbin/mdadm-smart-notifier` adapter when its ownership marker
matches, and can migrate that exact hook. It does not delete the old script.

## Check delivery

Start the packaged desktop listener by logging out/in or running `smart-notifier`
in a terminal as the normal desktop user. Then test the entire mdadm route:

```sh
sudo mdadm --monitor --scan --oneshot --test --no-sharing
```

For an adapter-only test, without scanning arrays:

```sh
sudo /usr/sbin/smart-notifier-mdadm TestMessage /dev/md/example
```

Both should display a clearly labeled test window. The second uses a fictitious
array name; it does not read or change that device. Do not fail a live drive just
to test the notifier.

## Troubleshooting

```sh
systemctl status mdmonitor.service
sudo journalctl -u mdmonitor.service --since today
sudo journalctl -t smart-notifier-mdadm --since today
cat /proc/mdstat
```

A logged `Submitted` message means smart-notifier accepted the subprocess input,
not that a desktop listener acknowledged it. Check the user's listener if no
window appears. The adapter passes plain text on stdin with a 15-second timeout.
It does not guess a display, switch user sessions, or invoke a shell.

If `MAILADDR root` is configured without a mail transport, mdadm may also report
an email error. Email delivery is separate from the desktop adapter.

Monitor startup depends on the distribution and the presence of an active,
monitored redundant array. Check the service after reboot. The adapter does not
add boot services, scheduled array checks, or a persistent notification queue.

## Removal

Disable the hook before removing the package, so mdadm does not retain a path to
a removed executable:

```sh
sudo smart-notifier-mdadm-configure disable
sudo apt remove smart-notifier-mdadm
```

Disable removes only this project's PROGRAM hook and restarts monitoring.
Unrelated PROGRAM hooks are not replaced. Backups remain available for manual
recovery. Do not blindly restore an old complete mdadm.conf if array settings
have since changed.

## References

- [mdadm monitor events and PROGRAM arguments](https://manpages.debian.org/trixie/mdadm/mdadm.8.en.html)
- [Debian smart-notifier package](https://packages.debian.org/stable/smart-notifier)
