"""
AURA :: server package
======================
Canonical home of the AURA HTTP server and its action/document back-end:
serve.py (entry), bridge.py (action bridge), tools (devices, overlay,
vdesk, windows_mgr, organizer, automation, websearch, ollama_proxy).

Legacy root-level shims (`aura/serve.py`, `aura/bridge.py`, …) remain so
`python serve.py`, tests and the launchers keep working unchanged; new code
imports from here (`from server import bridge`).
"""
