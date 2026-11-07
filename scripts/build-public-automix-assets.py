"""Reproduce the locked public graphs in a disposable Python 3.12 build stage.

The output contains only the two release graphs. Development frameworks,
checkpoints and conversion diagnostics stay in the separate work directory.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "audio-engine/automix-native/dependencies.lock.json"


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, destination, expected):
    if urlparse(url).scheme != "https":
        raise ValueError("Public model inputs require HTTPS")
    partial = destination.with_suffix(destination.suffix + ".partial")
    if destination.exists() or partial.exists():
        raise FileExistsError("Use a new public input destination")
    count = 0
    try:
        with urlopen(Request(url, headers={"User-Agent": "TwilightEcho-public-model-builder"}), timeout=60) as response:
            if urlparse(response.geturl()).scheme != "https":
                raise ValueError("Public model redirect must retain HTTPS")
            with partial.open("xb") as stream:
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    if count > 256 * 1024 * 1024:
                        raise ValueError("Public model input exceeds 256 MiB")
                    stream.write(chunk)
        if digest(partial) != expected:
            raise ValueError(f"Locked public input mismatch: {destination.name}")
        partial.rename(destination)
    finally:
        partial.unlink(missing_ok=True)


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def install_dependencies(lock):
    development = lock["development"]
    run(sys.executable, "-m", "pip", "install",
        "--index-url", "https://download.pytorch.org/whl/cpu",
        f"torch=={development['torch']}", f"torchaudio=={development['torchaudio']}")
    names = ["tensorflow", "tf-keras", "tf2onnx", "numpy", "onnx", "onnxruntime",
             "soundfile", "scipy", "einops", "rotary-embedding-torch", "soxr"]
    run(sys.executable, "-m", "pip", "install",
        *(f"{name}=={development[name]}" for name in names))


def publish_graphs(exports, output, lock):
    graphs = [(exports / model["graphFile"], model["graphSha256"]) for model in lock["models"].values()]
    # Validate all graphs before publishing even the first file.
    for file, expected in graphs:
        if digest(file) != expected:
            raise ValueError(f"Converted graph differs from release lock: {file.name}")
    output.mkdir()  # A new output directory is required; never replace an asset cache.
    for file, _ in graphs:
        shutil.copyfile(file, output / file.name)


def build(work, output, lock):
    if not work.is_absolute() or not output.is_absolute():
        raise ValueError("Work and output directories must be absolute")
    if work.exists() or output.exists():
        raise ValueError("Use new work and output directories")
    work.mkdir(parents=True)
    beat = lock["models"]["beat-this-small0"]
    voice = lock["models"]["yamnet"]
    reference = work / "beat-this"
    run("git", "init", reference)
    run("git", "-C", reference, "remote", "add", "origin", beat["source"])
    run("git", "-C", reference, "fetch", "--depth=1", "origin", beat["commit"])
    run("git", "-C", reference, "checkout", "--detach", "FETCH_HEAD")
    yamnet = work / "yamnet"
    yamnet.mkdir()
    for name, expected in voice["sourceFiles"].items():
        if Path(name).name != name:
            raise ValueError("Model source file must be a basename")
        download(f"https://raw.githubusercontent.com/tensorflow/models/{voice['commit']}/research/audioset/yamnet/{name}", yamnet / name, expected)
    exports = work / "exports"
    exports.mkdir()
    converter = ROOT / "audio-engine/automix-native/tools/convert_models.py"
    for name, model, source, suffix in [("beat-this", beat, reference, ".ckpt"), ("yamnet", voice, yamnet, ".h5")]:
        weights = work / (name + suffix)
        download(model["weightsUrl"], weights, model["weightsSha256"])
        run(sys.executable, converter, name, source, weights, exports / (name + ".onnx"))
    publish_graphs(exports, output, lock)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--install-dependencies", action="store_true")
    args = parser.parse_args()
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    if f"{sys.version_info.major}.{sys.version_info.minor}" != lock["development"]["python"]:
        raise RuntimeError("Use the Python version in the public dependency lock")
    if not args.work.is_absolute() or not args.output.is_absolute() or args.work.exists() or args.output.exists():
        raise ValueError("Use new, absolute work and output directories")
    if args.install_dependencies:
        install_dependencies(lock)
    build(args.work, args.output, lock)
