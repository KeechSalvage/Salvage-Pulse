"""Generate spoken audio (macOS `say` + `afconvert`) for Tyler's demo calls.

Usage (from repo root):  PYTHONPATH=backend backend/.venv/bin/python backend/scripts/generate_demo_audio.py
Writes backend/uploads/<call_id>.wav (or $DATA_DIR/uploads).
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from demo_tyler_calls import SCENARIOS, ID_PREFIX  # noqa: E402
from demo_team_calls import TEAM  # noqa: E402

REP_VOICE = "Reed (English (US))"
RATE_WPM = 175
CUSTOMER_VOICES = {
    "Mike": "Rocko (English (US))",
    "Sarah": "Samantha",
    "Carlos": "Eddy (English (US))",
    "Linda": "Shelley (English (US))",
    "Dave": "Grandpa (English (US))",
    "Priya": "Flo (English (US))",
    "Tom": "Rocko (English (US))",
    "Jennifer": "Sandy (English (US))",
    "Robert": "Eddy (English (US))",
    "Amanda": "Samantha",
}
SAMPLE_RATE = 22050
MALE_POOL = ["Rocko (English (US))", "Grandpa (English (US))", "Junior", "Eddy (English (US))", "Reed (English (US))", "Fred", "Ralph"]
FEMALE_POOL = ["Samantha", "Flo (English (US))", "Shelley (English (US))", "Sandy (English (US))"]
FEMALE_NAMES = {"Rachel", "Beth", "Janet", "Olivia", "Monica", "Sophie", "Patricia", "Natalie", "Heather", "Allison", "Lucy",
                "Diane", "Renee", "Gloria", "Vivian", "Carmen", "Sarah", "Linda", "Priya", "Jennifer", "Amanda"}


def uploads_dir() -> str:
    d = os.environ.get("DATA_DIR")
    path = os.path.join(d, "uploads") if d else os.path.join(os.path.dirname(__file__), "..", "uploads")
    path = os.path.abspath(path)
    os.makedirs(path, exist_ok=True)
    return path


def synth(text: str, voice: str, out_wav: str, tmp: str) -> None:
    aiff = os.path.join(tmp, "t.aiff")
    subprocess.run(["say", "-v", voice, "-r", str(RATE_WPM), "-o", aiff, text], check=True)
    subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", f"LEI16@{SAMPLE_RATE}", "-c", "1", aiff, out_wav], check=True
    )


def pick_voice(first: str, idx: int, rep_voice: str) -> str:
    if first in CUSTOMER_VOICES:
        return CUSTOMER_VOICES[first]
    pool = FEMALE_POOL if first in FEMALE_NAMES else [v for v in MALE_POOL if v != rep_voice]
    return pool[idx % len(pool)]


def render(cid: str, scenario: dict, rep_voice: str, idx: int, out_dir: str) -> None:
    silence = b"\x00\x00" * int(SAMPLE_RATE * 0.45)
    cust_voice = pick_voice(scenario["customer"].split()[0], idx, rep_voice)
    frames = b""
    with tempfile.TemporaryDirectory() as tmp:
        for n, (role, text) in enumerate(scenario["turns"]):
            part = os.path.join(tmp, f"{n}.wav")
            synth(text, rep_voice if role == "rep" else cust_voice, part, tmp)
            with wave.open(part, "rb") as w:
                frames += w.readframes(w.getnframes()) + silence
    dest = os.path.join(out_dir, f"{cid}.wav")
    with wave.open(dest, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(frames)
    print(f"{cid}: {len(frames) / (2 * SAMPLE_RATE):.0f}s -> {dest}", flush=True)


def main() -> None:
    out_dir = uploads_dir()
    only = set(sys.argv[1:])  # optional rep prefixes, e.g. demo-cody-call-
    jobs = [(ID_PREFIX, SCENARIOS, REP_VOICE)] + [(m["prefix"], m["scenarios"], m["voice"]) for m in TEAM]
    for prefix, scenarios, rep_voice in jobs:
        if only and prefix not in only:
            continue
        for i, s in enumerate(scenarios, start=1):
            cid = f"{prefix}{i:02d}"
            if not only and os.path.exists(os.path.join(out_dir, f"{cid}.wav")) and prefix == ID_PREFIX:
                continue
            render(cid, s, rep_voice, i, out_dir)


if __name__ == "__main__":
    main()
