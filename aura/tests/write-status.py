#!/usr/bin/env python3
"""AURA :: write STATUS.json from a run-all battery + print the loud verdict.

Called by tests/run-all.sh at the end of EVERY battery (green or red):

    python3 tests/write-status.py --pass 1200 --fail 0 --failed none
    python3 tests/write-status.py --pass 1198 --fail 2 --failed test-x test-y

Writes aura/STATUS.json and prints the FEATURE_STATUS line + verdict.
Exit code mirrors the verdict (0 = GREEN, 1 = RED).
"""
import argparse
import datetime
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
AURA_ROOT = HERE.parent.parent
STATUS_PATH = AURA_ROOT / "STATUS.json"

# What this tree claims to be. Updated by hand when a feature lands or moves;
# the test battery underneath is what keeps the claims honest.
FEATURES = {
    "wake": "service-v2 + python/porcupine/browser routing",
    "proactive": "4-rule notify engine (toast + optional voice)",
    "bridge": "ask/strict only (open removed)",
    "docgen": "core-owned outline pin (L1, registry+doc-agent share)",
    "ppt": "maintained",
}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--pass", dest="n_pass", type=int, required=True)
    ap.add_argument("--fail", dest="n_fail", type=int, required=True)
    ap.add_argument("--failed", dest="failed_list", nargs="*", default=["none"],
                    help="failed suite names, or the single word 'none'")
    args = ap.parse_args(argv)

    failed_suites = [] if args.failed_list == ["none"] else list(args.failed_list)
    verdict = "GREEN" if (args.n_fail == 0 and not failed_suites) else "RED"

    payload = {
        "generated": datetime.datetime.now(datetime.timezone.utc)
                     .isoformat(timespec="seconds"),
        "verdict": verdict,
        "asserts": {"pass": args.n_pass, "fail": args.n_fail},
        "failed_suites": failed_suites,
        "features": FEATURES,
    }
    STATUS_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    feats = " | ".join(f"{k}={v}" for k, v in FEATURES.items())
    print(f"FEATURE_STATUS: {feats}")
    print(f"VERDICT: {verdict}  (PASS {args.n_pass}  FAIL {args.n_fail}  "
          f"suites failed: {len(failed_suites)}) -> {STATUS_PATH.name}")
    return 0 if verdict == "GREEN" else 1


if __name__ == "__main__":
    sys.exit(main())
