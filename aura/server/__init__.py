"""
AURA :: server package
======================
Canonical home of the AURA HTTP server and its action/document back-end:
serve.py (entry), bridge.py (action bridge) and the tools (devices, overlay,
vdesk, windows_mgr, organizer, automation, websearch, ollama_proxy).

`aura/serve.py` is a thin root shim so `python serve.py` (launchers, tests,
muscle memory) keeps working. Everything else imports from here:
`from server import bridge` (tests do the same).
"""
