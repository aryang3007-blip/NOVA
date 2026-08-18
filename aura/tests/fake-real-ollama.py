"""
Ollama stand-in that behaves like the USER'S REAL MACHINE.

Crucially it does NOT return perfect JSON on demand. Real 7B vision models:
  - wrap JSON in prose or markdown fences
  - sometimes emit single quotes or trailing commas
  - sometimes answer in plain English instead of JSON
  - sometimes name a cell with a space, or lowercase

If /do only works against a stub that returns pristine JSON, /do does not work.
"""
import http.server, json, socketserver, time, sys, random

MODELS = {
  "moondream:latest": (1.7e9, "1.7B", ["completion","vision"]),
  "gemma2:2b":        (1.6e9, "2.6B", ["completion"]),
  "qwen2.5vl:7b":     (6.0e9, "7.6B", ["completion","vision"]),
  "gemma4:12b":       (7.0e9, "12.0B",["completion","vision","tools"]),
}

# Cycle through the messy shapes a real model actually produces.
MESSY = [
  'Sure! Here is the plan:\n```json\n{"steps":[{"do":"click","target":"Close button","cell":"L1"}]}\n```\nLet me know if that helps.',
  "{'steps': [{'do': 'click', 'target': 'X', 'cell': 'L1'}]}",
  '{"steps":[{"do":"click","target":"Close","cell":"L 1"},]}',
  'I can see a window. To close it, click the X in the top right corner (cell L1).',
  '```\n{"steps":[{"do":"hotkey","keys":"ctrl+w"}]}\n```',
]
_n = {"i": 0}

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _j(self,o,c=200):
        b=json.dumps(o).encode(); self.send_response(c)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path=="/api/tags":
            return self._j({"models":[{"name":n,"size":int(s),"modified_at":"2026-07-01T00:00:00Z",
                "details":{"family":n.split(':')[0],"parameter_size":p}} for n,(s,p,_) in MODELS.items()]})
        self._j({},404)
    def do_POST(self):
        n=int(self.headers.get("Content-Length",0)); body=json.loads(self.rfile.read(n) or b"{}")
        if self.path=="/api/show":
            m=body.get("model")
            return self._j({"capabilities":MODELS[m][2]} if m in MODELS else {"error":"nf"},
                           200 if m in MODELS else 404)
        if self.path=="/api/chat":
            model=body.get("model","?"); msgs=body.get("messages",[])
            txt=" ".join(m.get("content","") for m in msgs)
            if model.startswith("moondream"):
                reply="a screenshot of a computer"       # real behaviour
            elif "STRICT JSON" in txt or "steps" in txt:
                reply=MESSY[_n["i"] % len(MESSY)]; _n["i"]+=1
            elif "Transcribe" in txt:
                reply="File  Edit  View\nUntitled Document\nSave   Cancel\nX"
            else:
                reply=f"[{model}] I can see your screen."
            self.send_response(200); self.send_header("Content-Type","application/x-ndjson"); self.end_headers()
            for w in reply.split(" "):
                self.wfile.write(json.dumps({"message":{"content":w+" "}}).encode()+b"\n"); self.wfile.flush(); time.sleep(0.003)
            self.wfile.write(json.dumps({"done":True}).encode()+b"\n"); self.wfile.flush(); return
        self._j({},404)

port = int(sys.argv[1]) if len(sys.argv)>1 else 11434
socketserver.TCPServer.allow_reuse_address=True
socketserver.ThreadingTCPServer(("127.0.0.1",port),H).serve_forever()
