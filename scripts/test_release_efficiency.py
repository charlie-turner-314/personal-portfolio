"""Offline safety tests: python3 -m unittest discover -s scripts -p 'test_release_efficiency.py'."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("promotion", Path(__file__).with_name("promote-release-image.py"))
promotion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promotion)
SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64
IMAGES = {p: {"config": {"Labels": {"org.opencontainers.image.revision": SHA}}} for p in ("linux/amd64", "linux/arm64")}
prune_spec = importlib.util.spec_from_file_location("prune", Path(__file__).with_name("prune-release-images.py"))
prune = importlib.util.module_from_spec(prune_spec)
prune_spec.loader.exec_module(prune)
native_spec = importlib.util.spec_from_file_location("native", Path(__file__).with_name("assemble-native-images.py"))
native = importlib.util.module_from_spec(native_spec)
native_spec.loader.exec_module(native)


class ReleaseWorkflowTests(unittest.TestCase):
    def test_bundle_overrides_skipped_ancestor_but_requires_promoted_images(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/docker-build.yml").read_text()
        bundle = workflow.split("  release_bundle:\n", 1)[1]
        condition = next(line.strip() for line in bundle.splitlines() if line.strip().startswith("if:"))
        self.assertEqual(condition, "if: ${{ !cancelled() && startsWith(github.ref, 'refs/tags/v') && needs.build.result == 'success' }}")
        self.assertIn("    needs: [build]", bundle)


class NativeAssemblyTests(unittest.TestCase):
    def configs(self, arch, revision=SHA):
        return {f"linux/{arch}": {"architecture": arch, "os": "linux", "config": {"Labels": {"org.opencontainers.image.revision": revision}}}}

    def test_tested_platforms_are_assembled_by_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            for arch in ("amd64", "arm64"):
                (Path(directory) / f"{arch}.txt").write_text(DIGEST)
            with patch.object(native.promotion, "inspect", side_effect=[self.configs("amd64"), self.configs("arm64"), {"digest": DIGEST}, IMAGES]), patch.object(native.promotion, "docker") as docker:
                native.assemble("registry/app", SHA, directory)
                docker.assert_called_once_with("create", "--tag", "registry/app:sha-" + SHA, "registry/app@" + DIGEST, "registry/app@" + DIGEST)

    def test_wrong_cpu_or_revision_cannot_be_published(self):
        for config in [self.configs("arm64"), self.configs("amd64", "c" * 40)]:
            with tempfile.TemporaryDirectory() as directory:
                (Path(directory) / "amd64.txt").write_text(DIGEST)
                with patch.object(native.promotion, "inspect", return_value=config), patch.object(native.promotion, "docker") as docker:
                    with self.assertRaises(ValueError):
                        native.assemble("registry/app", SHA, directory)
                    docker.assert_not_called()

    def test_missing_platform_artifact_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(native.promotion, "docker") as docker:
            with self.assertRaises(FileNotFoundError):
                native.assemble("registry/app", SHA, directory)
            docker.assert_not_called()

    def test_invalid_digest_is_not_used_as_a_tag(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(native.promotion, "docker") as docker:
            (Path(directory) / "amd64.txt").write_text("edge")
            with self.assertRaises(ValueError):
                native.assemble("registry/app", SHA, directory)
            docker.assert_not_called()


class PruneTests(unittest.TestCase):
    def test_only_unused_obsolete_owned_version_tags(self):
        repo = sorted(prune.REPOSITORIES)[0]
        rows = [{"Repository": repo, "Tag": tag, "ID": image} for tag, image in
                [("v0.1.0", "old"), ("v0.1.1", "running"), ("v0.1.2", "previous"),
                 ("v0.1.3", "current"), ("edge", "edge"), ("sha-abc", "sha")]]
        rows.append({"Repository": "other/project", "Tag": "v0.1.0", "ID": "other"})
        self.assertEqual(prune.candidates(rows, {"v0.1.2", "v0.1.3"}, {"running"}), [repo + ":v0.1.0"])


class MaintenanceTests(unittest.TestCase):
    def run_release(self, mode, failure=""):
        with tempfile.TemporaryDirectory(prefix="portfolio-release-test-") as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            script = root / "scripts/pi-release.sh"
            script.write_text(Path(__file__).with_name("pi-release.sh").read_text())
            env_file = root / "production.env"
            env_file.write_text("APP_VERSION=v0.1.2\n")
            bin_dir = root / "bin"
            bin_dir.mkdir()
            fake = '''#!/usr/bin/env python3
import os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(name + " " + " ".join(args) + "\\n")
if name == "git" and "rev-parse" in args:
    print("a" * 40)
elif name == "docker":
    if "pull" in args and os.environ.get("FAIL_PHASE") == "pull": sys.exit(1)
    if "run" in args and "migrate" in args and os.environ.get("FAIL_PHASE") == "migrate": sys.exit(1)
    if "inspect" in args and "image" in args and "revision" in " ".join(args): print("a" * 40)
    elif "inspect" in args and ".State.Running" in " ".join(args): print("old-" + args[1])
    elif "exec" in args and "pg_dump" in " ".join(args): print("test dump")
elif name == "python3":
    if "-" in args: sys.stdin.read()
    print("{}")
'''
            # Use the real interpreter explicitly so the python3 shim cannot recurse.
            fake = fake.replace("#!/usr/bin/env python3", "#!" + os.sys.executable)
            for name in ("git", "docker", "python3", "tar"):
                executable = bin_dir / name
                executable.write_text(fake)
                executable.chmod(0o755)
            log = root / "calls"
            result = subprocess.run(["bash", str(script), "v0.1.3", str(env_file), *mode], env={**os.environ, "PATH": str(bin_dir) + ":" + os.environ["PATH"], "CALL_LOG": str(log), "FAIL_PHASE": failure}, capture_output=True, text=True)
            return result, log.read_text()

    def test_normal_pull_precedes_stop(self):
        result, calls = self.run_release([])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(calls.index(" pull "), calls.index(" stop "))
        self.assertNotIn("docker start", calls)

    def test_maintenance_stop_precedes_pull(self):
        result, calls = self.run_release(["--maintenance"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(calls.index(" stop "), calls.index(" pull "))

    def test_pull_failure_restarts_original_containers(self):
        result, calls = self.run_release(["--maintenance"], "pull")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("docker start old-personal-portfolio-app", calls)
        self.assertNotIn(" up ", calls)

    def test_migration_failure_does_not_roll_back(self):
        result, calls = self.run_release(["--maintenance"], "migrate")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("docker start", calls)
        self.assertNotIn(" up ", calls)


class PromotionTests(unittest.TestCase):
    def test_both_architectures_required(self):
        promotion.validate_images(IMAGES, SHA)
        with self.assertRaises(ValueError):
            promotion.validate_images({"linux/amd64": IMAGES["linux/amd64"]}, SHA)
        with self.assertRaises(ValueError):
            promotion.validate_images(IMAGES, "c" * 40)

    def test_existing_identical_release_is_noop(self):
        with patch.object(promotion, "inspect", side_effect=[{"digest": DIGEST}, IMAGES, {"digest": DIGEST}, {"digest": DIGEST}]), patch.object(promotion, "docker") as docker:
            promotion.promote("registry/app", SHA, "v1.2.3")
            docker.assert_not_called()

    def test_different_release_cannot_be_overwritten(self):
        with patch.object(promotion, "inspect", side_effect=[{"digest": DIGEST}, IMAGES, {"digest": "other"}]), patch.object(promotion, "docker") as docker:
            with self.assertRaises(ValueError):
                promotion.promote("registry/app", SHA, "v1.2.3")
            docker.assert_not_called()

    def test_pins_source_before_creating_tag(self):
        absent = subprocess.CalledProcessError(1, "docker", stderr="manifest unknown")
        with patch.object(promotion, "inspect", side_effect=[{"digest": DIGEST}, IMAGES, absent, {"digest": DIGEST}]) as inspect, patch.object(promotion, "docker") as docker:
            promotion.promote("registry/app", SHA, "v1.2.3")
            self.assertEqual(inspect.call_args_list[1].args, ("registry/app@" + DIGEST, "Image"))
            docker.assert_called_once_with("create", "--tag", "registry/app:v1.2.3", "registry/app@" + DIGEST)

    def test_registry_errors_do_not_authorize_overwrite(self):
        error = subprocess.CalledProcessError(1, "docker", stderr="unauthorized")
        with patch.object(promotion, "inspect", side_effect=[{"digest": DIGEST}, IMAGES, error]), patch.object(promotion, "docker") as docker:
            with self.assertRaises(subprocess.CalledProcessError):
                promotion.promote("registry/app", SHA, "v1.2.3")
            docker.assert_not_called()

    def test_missing_source_has_bounded_wait(self):
        with patch.object(promotion, "inspect", side_effect=subprocess.CalledProcessError(1, "docker")):
            with self.assertRaises(RuntimeError):
                promotion.promote("registry/app", SHA, "v1.2.3", wait_seconds=0)

    def test_inputs_reject_moving_tags_and_short_shas(self):
        for commit, tag in [(SHA, "edge"), ("abc", "v1.2.3")]:
            with self.assertRaises(ValueError):
                promotion.promote("registry/app", commit, tag)


if __name__ == "__main__":
    unittest.main()
