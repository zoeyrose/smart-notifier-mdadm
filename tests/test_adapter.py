import importlib.util
import os
import stat
from types import SimpleNamespace
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / 'src' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

adapter = load('adapter', 'smart-notifier-mdadm.py')

class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.md = self.root / '9:127' / 'md'
        self.md.mkdir(parents=True)
        self.values = {'last_sync_action': 'check', 'sync_action': 'idle',
                       'mismatch_cnt': '0', 'degraded': '0', 'raid_disks': '2'}
        for name, value in self.values.items():
            (self.md / name).write_text(value)
        for member in ('a', 'b'):
            (self.md / f'dev-{member}').mkdir()
            (self.md / f'dev-{member}' / 'state').write_text('in_sync')

    def description(self):
        with patch.object(adapter.os, 'stat', return_value=SimpleNamespace(
                st_mode=stat.S_IFBLK, st_rdev=os.makedev(9, 127))):
            return adapter.maintenance_description('/dev/md/ubuntu-root', self.root)

    def test_named_array_uses_block_identity_and_reports_check_result(self):
        message = self.description()
        self.assertIn('RAID consistency check ended.', message)
        self.assertIn('Check logs to confirm completion.', message)
        self.assertNotIn('finished', message)
        self.assertIn('No mismatches were reported.', message)
        self.assertIn('All RAID members are currently in sync.', message)
        self.assertNotIn('scheduled', message.lower())

    def test_operations_and_unknown_action(self):
        for action, expected in [('recover', 'member recovery ended'),
                                 ('recovery', 'member recovery ended'),
                                 ('resync', 'synchronization ended'),
                                 ('repair', 'consistency repair ended'),
                                 ('reshape', 'reshape ended'),
                                 ('future', 'maintenance has ended')]:
            with self.subTest(action=action):
                (self.md / 'last_sync_action').write_text(action)
                message = self.description()
                self.assertIn(expected, message)
                self.assertNotIn('No mismatches', message)

    def test_mismatches_are_sectors_and_do_not_imply_repair(self):
        (self.md / 'mismatch_cnt').write_text('128')
        message = self.description()
        self.assertIn('128 mismatched sectors', message)
        self.assertNotIn('No mismatches', message)

    def test_missing_or_invalid_optional_results_do_not_claim_health(self):
        (self.md / 'mismatch_cnt').write_text('unknown')
        (self.md / 'degraded').unlink()
        message = self.description()
        self.assertIn('consistency check ended', message)
        self.assertIn('Check array status for the result', message)
        self.assertNotIn('in sync', message)

    def test_degraded_faulty_or_missing_members_do_not_claim_in_sync(self):
        for field, value in [('degraded', '1'), ('dev-a/state', 'faulty'),
                             ('raid_disks', '3')]:
            with self.subTest(field=field):
                path = self.md / field
                original = path.read_text()
                path.write_text(value)
                self.assertNotIn('All RAID members', self.description())
                path.write_text(original)

    def test_missing_sysfs_or_active_operation_uses_generic_fallback(self):
        (self.md / 'sync_action').write_text('check')
        self.assertEqual(self.description(), adapter.DESCRIPTIONS['RebuildFinished'])
        (self.md / 'last_sync_action').unlink()
        self.assertEqual(self.description(), adapter.DESCRIPTIONS['RebuildFinished'])

    def test_unavailable_or_non_block_array_does_not_prevent_notification(self):
        for result in [OSError('permission denied'), SimpleNamespace(st_mode=stat.S_IFREG)]:
            with self.subTest(result=result):
                kwargs = {'side_effect': result} if isinstance(result, OSError) else {'return_value': result}
                with patch.object(adapter.os, 'stat', **kwargs):
                    message = adapter.message_for('RebuildFinished', '/dev/md/example')
                self.assertIn('RAID maintenance has ended', message)

    def test_new_operation_during_snapshot_uses_fallback(self):
        original = Path.read_text
        reads = 0
        def changing_read(path, *args, **kwargs):
            nonlocal reads
            if path.name == 'sync_action':
                reads += 1
                if reads == 2:
                    return 'recover'
            return original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', changing_read):
            self.assertEqual(self.description(), adapter.DESCRIPTIONS['RebuildFinished'])

class NotificationTests(unittest.TestCase):
    def test_all_failures_and_unknown_events_are_displayed(self):
        for event in ('Fail', 'FailSpare', 'DegradedArray', 'DeviceDisappeared', 'SparesMissing', 'FutureEvent'):
            with self.subTest(event=event):
                message = adapter.message_for(event, '/dev/md127', '/dev/nvme0n1p2')
                self.assertIn(event, message)
                self.assertIn('/dev/nvme0n1p2', message)

    def test_discovery_and_progress_do_not_open_windows(self):
        for event in ('NewArray', 'RebuildStarted', 'Rebuild20'):
            self.assertIsNone(adapter.message_for(event, '/dev/md127'))
        self.assertIsNotNone(adapter.message_for('RebuildFinished', '/dev/md127'))

    def test_test_message_is_explicitly_harmless_and_uses_stdin(self):
        with patch.object(adapter.subprocess, 'run') as run, patch.object(adapter.syslog, 'syslog'):
            self.assertEqual(adapter.main(['TestMessage', '/dev/md127']), 0)
        call = run.call_args
        self.assertEqual(call.args[0], ['/usr/bin/smart-notifier', '--notify'])
        self.assertIn('TEST ONLY', call.kwargs['input'])
        self.assertIn('does not indicate a drive failure', call.kwargs['input'])
        self.assertFalse(call.kwargs.get('shell', False))

    def test_device_text_cannot_be_executed(self):
        with patch.object(adapter.subprocess, 'run') as run, patch.object(adapter.syslog, 'syslog'):
            adapter.main(['Fail', '/dev/md127', '$(touch /tmp/not-executed)'])
        self.assertIn('$(touch /tmp/not-executed)', run.call_args.kwargs['input'])
        self.assertEqual(run.call_args.args[0], ['/usr/bin/smart-notifier', '--notify'])

    def test_notification_failure_is_reported(self):
        with patch.object(adapter.subprocess, 'run', side_effect=subprocess.TimeoutExpired('smart-notifier', 15)), \
                patch.object(adapter.syslog, 'syslog') as log:
            self.assertEqual(adapter.main(['Fail', '/dev/md127']), 1)
            log.assert_called_once()

    def test_invalid_arguments_do_not_notify(self):
        with patch.object(adapter.subprocess, 'run') as run:
            self.assertEqual(adapter.main(['Fail']), 2)
            run.assert_not_called()

if __name__ == '__main__':
    unittest.main()
