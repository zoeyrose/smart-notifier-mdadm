import contextlib
import errno
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('configure', Path(__file__).resolve().parents[1] / 'src/smart-notifier-mdadm-configure.py')
configure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure)


class TransformTests(unittest.TestCase):
    def test_preserve_unrelated_configuration_and_idempotence(self):
        before = '# comment\nMAILADDR root\nARRAY /dev/md0 UUID=abc\n\n'
        after = configure.configure(before, 'enable')
        self.assertEqual(after, before + f'PROGRAM {configure.TARGET}\n')
        self.assertEqual(configure.configure(after, 'enable'), after)
        self.assertEqual(configure.configure(after, 'disable'), before)
        self.assertEqual(configure.configure(before, 'disable'), before)

    def test_conflicts_duplicates_and_abbreviations_fail_closed(self):
        for line in ('PROGRAM /other\n', 'pro /other\n', 'PROGRAM /usr/sbin/smart-notifier-mdadm argument\n',
                     f'PROGRAM {configure.TARGET}\nPROGRAM {configure.TARGET}\n'):
            for action in ('enable', 'disable'):
                with self.subTest(line=line, action=action), self.assertRaises(RuntimeError):
                    configure.configure(line, action)

    def test_migration_requires_exact_managed_legacy(self):
        before = f'PROGRAM {configure.LEGACY} # custom note\n'
        with self.assertRaises(RuntimeError):
            configure.configure(before, 'enable')
        self.assertEqual(configure.configure(before, 'enable', True), f'PROGRAM {configure.TARGET} # custom note\n')
        with self.assertRaises(RuntimeError):
            configure.configure(before, 'disable', True)

    def test_disable_retains_administrator_comment(self):
        self.assertEqual(configure.configure(f'PROGRAM {configure.TARGET} # note\n', 'disable'), '# note\n')

    def test_quoted_keywords_and_literal_hash_are_conflicts(self):
        for before in ('"PROGRAM" /other\n', "'pro' /other\n",
                       'PRO"GRAM" /other\n',
                       f'PROGRAM {configure.TARGET}#custom\n',
                       f'PROGRAM "{configure.TARGET}"\n'):
            for action in ('enable', 'disable'):
                with self.subTest(before=before, action=action), self.assertRaises(RuntimeError):
                    configure.configure(before, action)

    def test_program_continuations_and_indentation_require_review(self):
        for before in (f'MAILADDR root\n PROGRAM {configure.TARGET}\n',
                       f' PROGRAM {configure.TARGET}\n',
                       f'PROGRAM {configure.TARGET}\n /other\n',
                       f'PROGRAM\n {configure.TARGET}\n',
                       f'PROGRAM {configure.TARGET}\n# note\n /other\n'):
            for action in ('enable', 'disable'):
                with self.subTest(before=before, action=action), self.assertRaises(RuntimeError):
                    configure.configure(before, action)

    def test_normal_array_continuations_and_quotes_preserved(self):
        before = ('MAILADDR root\nARRAY /dev/md0\n'
                  ' UUID=abc name="host name"\n\n'
                  ' # comment\n devices=/dev/sda1,/dev/sdb1\n'
                  'ARRAY /dev/md1 UUID=def name=literal#hash\n')
        after = configure.configure(before, 'enable')
        self.assertEqual(after, before + f'PROGRAM {configure.TARGET}\n')
        self.assertEqual(configure.configure(after, 'disable'), before)

    def test_unterminated_quotes_fail_closed(self):
        with self.assertRaises(RuntimeError):
            configure.configure('MAILADDR "root\nPROGRAM /other\n', 'enable')

    def test_comment_quotes_and_hash_do_not_change_parsing(self):
        before = f'PROGRAM {configure.TARGET} # "unclosed quote and #\n'
        self.assertEqual(configure.configure(before, 'enable'), before)
        self.assertEqual(configure.configure(before, 'disable'), '# "unclosed quote and #\n')

    def test_only_space_tab_and_lf_separate_program_words(self):
        for suffix in ('\r', '\v', '\f', '\x85', '\u2028', '\u2029'):
            before = f'PROGRAM {configure.TARGET}{suffix}\n'
            for action in ('enable', 'disable'):
                with self.subTest(suffix=repr(suffix), action=action), self.assertRaises(RuntimeError):
                    configure.configure(before, action)

    def test_unrelated_physical_text_is_preserved(self):
        before = 'MAILADDR root\r\nARRAY /dev/md0 name=foo\u2028bar\n'
        after = configure.configure(before, 'enable')
        self.assertEqual(after, before + f'PROGRAM {configure.TARGET}\n')
        self.assertEqual(configure.configure(after, 'disable'), before)


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / 'mdadm.conf'
        self.before = b'# raw byte: \xff\nMAILADDR root\n'
        self.config.write_bytes(self.before)
        self.config.chmod(0o640)

    def test_atomic_write_preserves_mode_owner_and_contents(self):
        before, info = configure.read_regular(self.config)
        configure.atomic_write(self.config, b'new', before, info)
        self.assertEqual(self.config.read_bytes(), b'new')
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.config.stat().st_uid, info.st_uid)
        self.assertEqual(list(self.root.iterdir()), [self.config])

    def test_atomic_write_retains_extended_attributes(self):
        try:
            os.setxattr(self.config, 'user.notifier-test', b'preserved')
        except OSError as exc:
            if exc.errno in (errno.ENOTSUP, errno.EOPNOTSUPP):
                self.skipTest('Test filesystem does not support extended attributes')
            raise
        before, info = configure.read_regular(self.config)
        configure.atomic_write(self.config, b'updated', before, info)
        self.assertEqual(os.getxattr(self.config, 'user.notifier-test'), b'preserved')

    def test_concurrent_edit_prevents_replacement_and_cleans_temp(self):
        before, info = configure.read_regular(self.config)
        self.config.write_bytes(b'concurrent change')
        with self.assertRaises(RuntimeError):
            configure.atomic_write(self.config, b'new', before, info)
        self.assertEqual(self.config.read_bytes(), b'concurrent change')
        self.assertEqual(list(self.root.iterdir()), [self.config])

    def test_refuse_symlinks_and_multiple_links(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.config)
        with self.assertRaises(OSError):
            configure.read_regular(alias)
        alias.unlink()
        os.link(self.config, alias)
        with self.assertRaises(RuntimeError):
            configure.read_regular(self.config)

    def test_legacy_marker_must_be_a_complete_line(self):
        legacy = self.root / 'legacy'
        with patch.object(configure, 'LEGACY', legacy):
            self.assertFalse(configure.legacy_is_managed())
            legacy.write_bytes(b'# prefix ' + configure.LEGACY_MARKER)
            self.assertFalse(configure.legacy_is_managed())
            legacy.write_bytes(b'#!/usr/bin/python3\n' + configure.LEGACY_MARKER + b'\n')
            self.assertTrue(configure.legacy_is_managed())

    def test_lock_excludes_second_writer(self):
        with patch.object(configure, 'LOCK', self.root / 'lock'):
            with configure.configuration_lock():
                with self.assertRaises(RuntimeError):
                    with configure.configuration_lock():
                        self.fail('Second writer acquired lock')

    def test_enable_disable_backup_and_restart_failure(self):
        # Real filesystem transformations, with root/service boundaries mocked.
        backups = []
        def backup(data):
            path = self.root / f'backup-{len(backups)}'
            path.write_bytes(data)
            backups.append(path)
            return path
        with patch.object(configure, 'CONFIG', self.config), \
             patch.object(configure.os, 'geteuid', return_value=0), \
             patch.object(configure.os, 'access', return_value=True), \
             patch.object(configure, 'configuration_lock', contextlib.nullcontext), \
             patch.object(configure, 'legacy_is_managed', return_value=False), \
             patch.object(configure, 'backup_configuration', side_effect=backup), \
             patch.object(configure.subprocess, 'run') as run, contextlib.redirect_stdout(io.StringIO()):
            configure.apply('enable')
            enabled = self.before + f'PROGRAM {configure.TARGET}\n'.encode()
            self.assertEqual(self.config.read_bytes(), enabled)
            self.assertEqual(backups[0].read_bytes(), self.before)
            self.assertEqual(run.call_count, 2)
            run.side_effect = subprocess.CalledProcessError(1, 'systemctl')
            with self.assertRaisesRegex(RuntimeError, 'Configuration remains disabled'):
                configure.apply('disable')
            self.assertEqual(self.config.read_bytes(), self.before)
            self.assertEqual(backups[1].read_bytes(), enabled)
            run.side_effect = None
            configure.apply('disable')
            self.assertEqual(len(backups), 2)

    def test_backup_private_and_exact(self):
        with patch.object(configure, 'BACKUPS', self.root / 'backups'):
            path = configure.backup_configuration(self.before)
            self.assertEqual(path.read_bytes(), self.before)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_nonroot_refused_before_changes(self):
        with patch.object(configure.os, 'geteuid', return_value=1000), self.assertRaises(RuntimeError):
            configure.apply('disable')
        self.assertEqual(self.config.read_bytes(), self.before)


if __name__ == '__main__':
    unittest.main()
