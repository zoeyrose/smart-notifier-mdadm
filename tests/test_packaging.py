import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parents[1]


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "project with spaces"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "packaging" / "debian").mkdir(parents=True)
        (self.root / "src").mkdir()
        for path in (PROJECT / "scripts").iterdir():
            shutil.copy2(path, self.root / "scripts" / path.name)
        shutil.copy2(
            PROJECT / "packaging" / "debian" / "control.in",
            self.root / "packaging" / "debian" / "control.in",
        )
        for name in ("smart-notifier-mdadm.py", "smart-notifier-mdadm-configure.py"):
            script = self.root / "src" / name
            script.write_text("#!/usr/bin/python3\nimport sys\nif __name__ == '__main__': sys.exit(0)\n")
            script.chmod(0o755)
        (self.root / "README.md").write_text("# Fixture\n")
        (self.root / "LICENSE").write_text("fixture license\n")
        self.env = {**os.environ, "PACKAGE_VERSION": "1.2.3"}

    def run_script(self, name, **env):
        subprocess.run(
            [str(self.root / "scripts" / name)],
            cwd=self.root,
            env={**self.env, **env},
            check=True,
            text=True,
            capture_output=True,
        )

    def test_builds_exact_architecture_independent_artifact_set(self):
        self.run_script("build-packages.sh")
        self.assertEqual(
            {path.name for path in (self.root / "dist").iterdir()},
            {
                "smart-notifier-mdadm_1.2.3_all.deb",
                "smart-notifier-mdadm-1.2.3-linux-all.tar.gz",
            },
        )

    def test_debian_package_has_dependencies_files_and_no_maintainer_hooks(self):
        if not shutil.which("dpkg-deb"):
            self.skipTest("dpkg-deb is unavailable")
        self.run_script("build-deb.sh")
        package = self.root / "dist" / "smart-notifier-mdadm_1.2.3_all.deb"
        control = subprocess.run(
            ["dpkg-deb", "--field", package], check=True, text=True, capture_output=True
        ).stdout
        self.assertIn("Architecture: all", control)
        self.assertIn("Depends: python3 (>= 3.10), mdadm, smart-notifier", control)
        extracted = Path(self.temporary.name) / "deb"
        subprocess.run(["dpkg-deb", "--extract", package, extracted], check=True)
        for name in ("smart-notifier-mdadm", "smart-notifier-mdadm-configure"):
            installed = extracted / "usr" / "sbin" / name
            self.assertTrue(installed.stat().st_mode & stat.S_IXUSR)
            subprocess.run(["python3", "-m", "py_compile", installed], check=True)
        self.assertTrue((extracted / "usr/share/doc/smart-notifier-mdadm/README.md").is_file())
        self.assertTrue((extracted / "usr/share/doc/smart-notifier-mdadm/LICENSE").is_file())
        listing = subprocess.run(
            ["dpkg-deb", "--ctrl-tarfile", package], check=True, capture_output=True
        ).stdout
        with tarfile.open(fileobj=io.BytesIO(listing), mode="r:") as archive:
            self.assertEqual({Path(name).name for name in archive.getnames()} & {"preinst", "postinst", "prerm", "postrm"}, set())

    def test_archive_extracts_and_installs_into_isolated_root(self):
        self.run_script("build-archive.sh")
        archive_path = self.root / "dist" / "smart-notifier-mdadm-1.2.3-linux-all.tar.gz"
        unpacked = Path(self.temporary.name) / "archive"
        with tarfile.open(archive_path, "r:gz") as archive:
            self.assertTrue(all(not Path(member.name).is_absolute() and ".." not in Path(member.name).parts for member in archive.getmembers()))
            archive.extractall(unpacked)
        contents = unpacked / "smart-notifier-mdadm-1.2.3"
        destination = Path(self.temporary.name) / "install-root"
        subprocess.run(
            [str(contents / "install.sh")],
            env={**os.environ, "DESTDIR": str(destination)},
            check=True,
        )
        for name in ("smart-notifier-mdadm", "smart-notifier-mdadm-configure"):
            installed = destination / "usr" / "sbin" / name
            self.assertTrue(installed.stat().st_mode & stat.S_IXUSR)
            subprocess.run(["python3", "-m", "py_compile", installed], check=True)

    def test_debian_snapshot_version_sorts_before_stable(self):
        if not shutil.which("dpkg-deb"):
            self.skipTest("dpkg-deb is unavailable")
        self.run_script("build-deb.sh", PACKAGE_VERSION="1.2.3-dev.4.gabcdef123456")
        package = self.root / "dist" / "smart-notifier-mdadm_1.2.3-dev.4.gabcdef123456_all.deb"
        version = subprocess.run(
            ["dpkg-deb", "--field", package, "Version"], check=True, text=True, capture_output=True
        ).stdout.strip()
        self.assertEqual(version, "1.2.3~dev.4.gabcdef123456")
        self.assertEqual(
            subprocess.run(
                ["dpkg", "--compare-versions", version, "lt", "1.2.3"], check=False
            ).returncode,
            0,
        )


if __name__ == "__main__":
    unittest.main()
