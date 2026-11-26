#!/usr/bin/env python3
"""Builds the seed corpora for the fuzz targets (docs/FUZZING.md).

    tests/fuzz/extract_seeds.py <out-dir> [<preset-dir> ...]

Writes <out-dir>/<target>/ for each of the four targets:

  fuzz_preset_parser, fuzz_shader_passes   every .milk file, copied whole
  fuzz_hlsl_transpile                      each warp_N / comp_N / *_passN_ shader, joined the
                                           way PresetFileParser::GetCode() joins it
  fuzz_eval_compile                        each per_frame_ / per_frame_init_ / per_pixel_ /
                                           wavecode / shapecode equation block

plus the checked-in tests/fuzz/seeds/<target>/ files. Preset dirs default to presets/tests
and the parser/compat fixtures under tests/libprojectM/data. Only the standard library is
used, so CI needs nothing but python3.
"""

import hashlib
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_PRESET_DIRS = [
    REPO / "presets" / "tests",
    REPO / "tests" / "libprojectM" / "data" / "PresetFileParser",
    REPO / "tests" / "libprojectM" / "data" / "PresetCompat",
]
TARGETS = ["fuzz_preset_parser", "fuzz_shader_passes", "fuzz_hlsl_transpile", "fuzz_eval_compile"]

# A code key is <prefix><index>; GetCode() walks index = 1, 2, ... until one is missing.
CODE_KEY = re.compile(r"^(?P<prefix>.*?)(?P<index>\d+)$")
SHADER_PREFIX = re.compile(r"^(warp_|comp_|warp_pass\d+_|comp_pass\d+_)$")
EQUATION_PREFIX = re.compile(
    r"^(per_frame_|per_frame_init_|per_pixel_|"
    r"wave_\d+_per_frame|wave_\d+_per_point|wave_\d+_init|"
    r"wavecode_\d+_per_frame|wavecode_\d+_per_point|wavecode_\d+_init|"
    r"shape_\d+_per_frame|shape_\d+_init|shapecode_\d+_per_frame|shapecode_\d+_init)$"
)


def parse_preset(data):
    """Key -> value, like PresetFileParser::ParseLine(): first ' ' or '=' splits, keys lowercased."""
    values = {}
    for line in re.split(r"[\r\n]", data):
        match = re.search(r"[ =]", line)
        if not match or match.start() == 0:
            continue
        key = line[: match.start()].lower()
        values.setdefault(key, line[match.start() + 1 :])
    return values


def code_blocks(values, prefix_pattern):
    """Yields (prefix, code) for every prefix matching the pattern, joined like GetCode()."""
    prefixes = set()
    for key in values:
        match = CODE_KEY.match(key)
        if match and prefix_pattern.match(match.group("prefix")):
            prefixes.add(match.group("prefix"))
    for prefix in sorted(prefixes):
        lines = []
        index = 1
        while prefix + str(index) in values:
            line = values[prefix + str(index)]
            lines.append(line[1:] if line.startswith("`") else line)
            index += 1
        code = "".join(line + "\n" for line in lines)
        if code.strip():
            yield prefix, code


def write_unique(directory, stem, payload):
    digest = hashlib.sha1(payload).hexdigest()[:12]
    (directory / f"{stem}-{digest}").write_bytes(payload)


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    out = Path(argv[1])
    preset_dirs = [Path(p) for p in argv[2:]] or DEFAULT_PRESET_DIRS

    for target in TARGETS:
        (out / target).mkdir(parents=True, exist_ok=True)
        checked_in = REPO / "tests" / "fuzz" / "seeds" / target
        if checked_in.is_dir():
            for seed in sorted(checked_in.iterdir()):
                if seed.is_file() and not seed.name.startswith("."):
                    shutil.copyfile(seed, out / target / seed.name)

    counts = dict.fromkeys(TARGETS, 0)
    for preset_dir in preset_dirs:
        for preset in sorted(preset_dir.glob("*.milk")):
            raw = preset.read_bytes()
            for target in ("fuzz_preset_parser", "fuzz_shader_passes"):
                shutil.copyfile(preset, out / target / preset.name)
                counts[target] += 1
            values = parse_preset(raw.decode("latin-1"))
            for prefix, code in code_blocks(values, SHADER_PREFIX):
                write_unique(out / "fuzz_hlsl_transpile", preset.stem + "-" + prefix.rstrip("_"), code.encode("latin-1"))
                counts["fuzz_hlsl_transpile"] += 1
            for prefix, code in code_blocks(values, EQUATION_PREFIX):
                write_unique(out / "fuzz_eval_compile", preset.stem + "-" + prefix.rstrip("_"), code.encode("latin-1"))
                counts["fuzz_eval_compile"] += 1

    for target in TARGETS:
        print(f"{target}: {counts[target]} seeds from presets -> {out / target}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
