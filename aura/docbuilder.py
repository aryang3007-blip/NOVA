"""
AURA :: Document Builder (compat shim)
=======================================
The real implementation lives in services/docgen/builder.py — this file
re-exports it so every legacy import (bridge.py, serve.py, tests, tooling)
resolves to ONE canonical module. Nothing may import new logic here.
"""
from services.docgen.builder import *          # noqa: F401,F403
from services.docgen.builder import (          # noqa: F401
    capabilities, build, build_pptx, build_xlsx, build_docx, validate_pptx,
    default_folder, THEMES, FONT_HEAD, FONT_BODY, MAX_SLIDES, MAX_ROWS,
    MAX_COLS, MAX_SECTIONS, MAX_TEXT, HAS_PPTX, HAS_XLSX, HAS_DOCX,
    _load_image, _image_px, _target_path, _slug, _clip, _theme, _rgb,
)
