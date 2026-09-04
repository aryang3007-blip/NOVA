#!/usr/bin/env python3
"""
AURA :: legacy root entry shim
==============================
Canonical server: server/serve.py. This shim exists so `python serve.py ...`
(launchers, tests, muscle memory) keeps working unchanged. New code should
import from the package: `from server import serve`.
"""
import os as _os
import sys as _sys

_AURA_ROOT = _os.path.dirname(_os.path.abspath(__file__))
if _AURA_ROOT not in _sys.path:
    _sys.path.insert(0, _AURA_ROOT)

from server.serve import *     # noqa: E402,F403  (say/c/glyph/UNICODE_OK/helpers)
from server.serve import main  # noqa: E402

if __name__ == "__main__":
    main()
