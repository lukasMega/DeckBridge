#!/usr/bin/env python3
"""Build independent scanner samples. No DeckBridge source enters artifacts."""

import argparse
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import sys
import tomllib
import urllib.request
import zipfile
import zlib

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "artifacts"
PROD = ROOT.parent.parent


def check_versions():
    prod_mise = tomllib.loads((PROD / "mise.toml").read_text())
    prod_pkg = json.loads((PROD / "src-tauri/package.json").read_text())
    sample_pkg = json.loads((ROOT / "tauri/package.json").read_text())
    if prod_pkg["devDependencies"] != sample_pkg["devDependencies"]:
        raise RuntimeError("PoC Tauri CLI differs from production")
    if (PROD / "src-tauri/pnpm-lock.yaml").read_bytes() != (ROOT / "tauri/pnpm-lock.yaml").read_bytes():
        raise RuntimeError("PoC pnpm lockfile differs from production")
    prod_lock = tomllib.loads((PROD / "src-tauri/Cargo.lock").read_text())
    sample_lock = tomllib.loads((ROOT / "tauri/src-tauri/Cargo.lock").read_text())
    for name in ("tauri", "tauri-build"):
        prod_version = next(item["version"] for item in prod_lock["package"] if item["name"] == name)
        sample_version = next(item["version"] for item in sample_lock["package"] if item["name"] == name)
        if prod_version != sample_version:
            raise RuntimeError(f"PoC {name} differs from production: {sample_version} != {prod_version}")
    return prod_mise["env"]["TXIKI_VERSION"]


def run(*args, cwd=ROOT):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def png_chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def make_icon():
    path = ROOT / "tauri/src-tauri/icons/icon.ico"
    pixels = b"".join(b"\x00" + bytes((39, 123, 231, 255)) * 32 for _ in range(32))
    png = (b"\x89PNG\r\n\x1a\n" +
           png_chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 6, 0, 0, 0)) +
           png_chunk(b"IDAT", zlib.compress(pixels)) + png_chunk(b"IEND", b""))
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 32, 32, 0, 0, 1, 32, len(png), 22)
    path.write_bytes(header + entry + png)
    path.with_suffix(".png").write_bytes(png)


def runtime(path, txiki_tag):
    if path:
        return Path(path).resolve()
    if os.name != "nt" and platform.machine() != "arm64":
        raise RuntimeError("Pass --tjs for macOS Intel runtime")
    target_platform = "windows-x86_64" if os.name == "nt" else "macos-arm64"
    archive = ROOT / f"txiki-slim-ffi-{target_platform}.zip"
    url = ("https://github.com/lukasMega/txiki.js-with-slim-builds/releases/"
           f"download/{txiki_tag}/{archive.name}")
    print("Downloading", url, flush=True)
    urllib.request.urlretrieve(url, archive)
    with zipfile.ZipFile(archive) as zipped:
        name = "tjs.exe" if os.name == "nt" else "tjs"
        matches = [item for item in zipped.namelist() if Path(item).name == name]
        if len(matches) != 1:
            raise RuntimeError(f"Expected one {name}; found {len(matches)}")
        binary = OUT / name
        binary.write_bytes(zipped.read(matches[0]))
        binary.chmod(0o755)
    archive.unlink()
    return binary


def build_c():
    if os.name == "nt":
        run("cl", "/nologo", "/O2", str(ROOT / "samples/hello.c"),
            f"/Fo{OUT / 'hello-c.obj'}", f"/Fe{OUT / 'hello-c.exe'}")
        run("cl", "/nologo", "/O2", "/LD", str(ROOT / "samples/hello-lib.c"),
            f"/Fo{OUT / 'hello-native.obj'}", f"/Fe{OUT / 'hello-native.dll'}")
        run("cl", "/nologo", "/O2", str(ROOT / "samples/hello-tray.c"),
            f"/Fo{OUT / 'hello-tray.obj'}", f"/Fe{OUT / 'hello-tray.exe'}",
            "/link", "/SUBSYSTEM:WINDOWS", "shell32.lib", "user32.lib")
        return OUT / "hello-native.dll"
    run("clang", "-O2", str(ROOT / "samples/hello.c"), "-o", OUT / "hello-c")
    run("clang", "-O2", "-dynamiclib", str(ROOT / "samples/hello-lib.c"),
        "-o", OUT / "libhello-native.dylib")
    return OUT / "libhello-native.dylib"


def embedded_js(library):
    compressed = base64.b64encode(gzip.compress(library.read_bytes(), mtime=0)).decode()
    return f"""import FFI from 'tjs:ffi';
const data = Uint8Array.from(atob('{compressed}'), char => char.charCodeAt(0));
const stream = new DecompressionStream('gzip');
const writer = stream.writable.getWriter();
const written = writer.write(data).then(() => writer.close());
const chunks = [];
for await (const chunk of stream.readable) chunks.push(chunk);
await written;
const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
let offset = 0;
for (const chunk of chunks) {{ bytes.set(chunk, offset); offset += chunk.length; }}
const path = `${{tjs.tmpDir}}/hello-native-${{tjs.pid}}{library.suffix}`;
await tjs.writeFile(path, bytes);
const lib = FFI.dlopen(path, {{ hello_value: {{ args: [], returns: 'int' }} }});
console.log('hello', lib.symbols.hello_value());
lib.close();
"""


def build_txiki(tjs, library):
    suffix = ".exe" if os.name == "nt" else ""
    stock = OUT / ("tjs.exe" if suffix else "tjs")
    if stock.resolve() != tjs.resolve():
        shutil.copy2(tjs, stock)
    run(tjs, "compile", ROOT / "samples/hello.js", OUT / f"hello-txiki{suffix}")
    script = OUT / "hello-embedded.js"
    script.write_text(embedded_js(library))
    run(tjs, "compile", script, OUT / f"hello-txiki-library{suffix}")
    run(tjs, "run", script)
    script.unlink()


def build_tauri():
    make_icon()
    tauri = ROOT / "tauri"
    cli = os.environ.get("TAURI_CLI")
    if not cli:
        run("pnpm", "install", "--frozen-lockfile", cwd=tauri)
    bundles = "nsis" if os.name == "nt" else "app"
    command = [cli] if cli else ["pnpm", "tauri"]
    run(*command, "build", "--bundles", bundles, cwd=tauri)
    target = tauri / "src-tauri/target/release"
    exe = "hello-tauri.exe" if os.name == "nt" else "hello-tauri"
    shutil.copy2(target / exe, OUT / exe)
    if os.name == "nt":
        installers = list((target / "bundle/nsis").glob("*-setup.exe"))
        if len(installers) != 1:
            raise RuntimeError(f"Expected one NSIS installer; found {len(installers)}")
        shutil.copy2(installers[0], OUT / "hello-tauri-setup.exe")
    else:
        app = target / "bundle/macos/HelloTauri.app"
        run("hdiutil", "create", "-ov", "-format", "UDZO", "-volname", "HelloTauri",
            "-srcfolder", app, OUT / "hello-tauri.dmg")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tjs", help="Existing txiki runtime path")
    parser.add_argument("--tauri", action="store_true", help="Build Tauri executable and installer")
    options = parser.parse_args()
    txiki_tag = check_versions()
    OUT.mkdir(exist_ok=True)
    library = build_c()
    build_txiki(runtime(options.tjs, txiki_tag), library)
    if options.tauri:
        build_tauri()
    for path in sorted(OUT.iterdir()):
        if path.suffix in {".obj", ".lib", ".exp"}:
            path.unlink()
            continue
        if path.is_file():
            print(hashlib.sha256(path.read_bytes()).hexdigest(), path.name)


if __name__ == "__main__":
    main()
