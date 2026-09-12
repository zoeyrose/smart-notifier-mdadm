import importlib.util
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
