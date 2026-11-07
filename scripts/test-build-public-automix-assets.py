import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("public_models", Path(__file__).with_name("build-public-automix-assets.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class Response(io.BytesIO):
    def geturl(self):
        return "https://public.example/model"


class PublicModelBuildTest(unittest.TestCase):
    def test_download_requires_locked_bytes_and_cleans_an_incomplete_input(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "weights.ckpt"
            with patch.object(builder, "urlopen", return_value=Response(b"different")):
                with self.assertRaisesRegex(ValueError, "mismatch"):
                    builder.download("https://public.example/model", target, "0" * 64)
            self.assertEqual(list(Path(root).iterdir()), [])
            with patch.object(builder, "urlopen", return_value=Response(b"locked")):
                builder.download("https://public.example/model", target, hashlib.sha256(b"locked").hexdigest())
            self.assertEqual(target.read_bytes(), b"locked")

    def test_download_rejects_http_and_preserves_an_existing_cache_entry(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "weights.ckpt"
            with self.assertRaisesRegex(ValueError, "HTTPS"):
                builder.download("http://public.example/model", target, "0" * 64)
            target.write_bytes(b"keep")
            with self.assertRaises(FileExistsError):
                builder.download("https://public.example/model", target, "0" * 64)
            self.assertEqual(target.read_bytes(), b"keep")

    def test_only_both_verified_release_graphs_are_published(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            exports = root / "exports"
            exports.mkdir()
            lock = {"models": {name: {"graphFile": name + ".tamg", "graphSha256": hashlib.sha256(name.encode()).hexdigest()}
                               for name in ["beat", "voice"]}}
            for name in lock["models"]:
                (exports / (name + ".tamg")).write_bytes(name.encode())
            (exports / "development.onnx").write_bytes(b"not shipped")
            builder.publish_graphs(exports, root / "output", lock)
            self.assertEqual(sorted(file.name for file in (root / "output").iterdir()), ["beat.tamg", "voice.tamg"])
            (exports / "voice.tamg").write_bytes(b"altered")
            with self.assertRaisesRegex(ValueError, "release lock"):
                builder.publish_graphs(exports, root / "failed", lock)
            self.assertFalse((root / "failed").exists())

    def test_existing_and_relative_build_directories_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            with self.assertRaisesRegex(ValueError, "absolute"):
                builder.build(Path("work"), root / "out", {})
            with self.assertRaisesRegex(ValueError, "new work"):
                builder.build(root, root / "out", {})
            self.assertFalse((root / "out").exists())

    def test_dependency_install_is_explicit_and_uses_the_existing_lock(self):
        lock = json.loads(builder.LOCK.read_text(encoding="utf-8"))
        with patch.object(builder, "run") as run:
            builder.install_dependencies(lock)
        commands = [list(call.args) for call in run.call_args_list]
        self.assertEqual(len(commands), 2)
        self.assertIn("https://download.pytorch.org/whl/cpu", commands[0])
        self.assertIn("torch==" + lock["development"]["torch"], commands[0])
        for name in ["tensorflow", "onnxruntime", "numpy", "einops", "rotary-embedding-torch"]:
            self.assertIn(name + "==" + lock["development"][name], commands[1])

    def test_source_and_converter_commands_use_locked_public_inputs(self):
        lock = json.loads(builder.LOCK.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            with patch.object(builder, "run") as run, patch.object(builder, "download") as download, patch.object(builder, "publish_graphs") as publish:
                builder.build(root / "work", root / "out", lock)
            commands = [[str(arg) for arg in call.args] for call in run.call_args_list]
            self.assertIn(["git", "-C", str(root / "work/beat-this"), "fetch", "--depth=1", "origin", lock["models"]["beat-this-small0"]["commit"]], commands)
            self.assertEqual(len([args for args in commands if "convert_models.py" in args[1]]), 2)
            self.assertEqual(download.call_count, len(lock["models"]["yamnet"]["sourceFiles"]) + 2)
            publish.assert_called_once_with(root / "work/exports", root / "out", lock)


if __name__ == "__main__":
    unittest.main()
