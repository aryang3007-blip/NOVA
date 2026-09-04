"""
AURA :: Feature Registry (python)
=================================
ONE manifest — `services/manifest.json` — is read by the terminal, the app
frontend (js/features/registry.js), the python services and the tests. Nobody
hard-codes a feature list anymore; adding "diagrams" or a new theme touches
the manifest + the service, never ten call sites.

    from services.registry import feature, features, themes, transitions
"""

import json
import os
from typing import Any, Dict, List

_MANIFEST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifest.json")

_MANIFEST: Dict[str, Any] = {}


def _load() -> Dict[str, Any]:
    global _MANIFEST
    if not _MANIFEST:
        with open(_MANIFEST_PATH, "r", encoding="utf-8") as fh:
            _MANIFEST = json.load(fh)
    return _MANIFEST


def manifest() -> Dict[str, Any]:
    return _load()


def features() -> Dict[str, Any]:
    return _load().get("features", {})


def feature(fid: str) -> Dict[str, Any]:
    return features().get(fid) or {}


def themes() -> List[str]:
    return _load().get("themes", [])


def transitions() -> List[str]:
    return _load().get("transitions", [])


def animations() -> List[str]:
    return _load().get("animations", [])


def image_providers() -> List[Dict[str, Any]]:
    return _load().get("imageProviders", [])


def defaults(fid: str) -> Dict[str, Any]:
    return (feature(fid) or {}).get("defaults", {})


def canon(fid: str) -> Dict[str, Any]:
    """Everything one caller needs to run a feature, resolved to defaults."""
    f = feature(fid)
    d = dict(f or {})
    d.setdefault("defaults", defaults(fid))
    return d


if __name__ == "__main__":  # parity check helper used by the JS test
    import sys
    out = {
        "features": sorted(features().keys()),
        "themes": themes(), "transitions": transitions(),
        "animations": animations(), "imageProviders": image_providers(),
    }
    print(json.dumps(out, separators=(",", ":")))
