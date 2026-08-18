# Stand-in for the USER'S ACTUAL machine, speaking real Ollama protocol.
import http.server, json, socketserver, time
MODELS = {
  "deepseek-r1:8b":     (5.2e9, "8.0B",  ["completion","thinking"]),
  "gemma2:2b":          (1.6e9, "2.6B",  ["completion"]),
  "gemma4:12b":         (7.0e9, "12.0B", ["completion","vision","tools"]),
  "gpt-oss:20b":        (13e9,  "20.9B", ["completion","tools"]),
  "qwen2.5-coder:14b":  (9e9,   "14.8B", ["completion","tools"]),
  "qwen2.5-coder:7b":   (4.7e9, "7.6B",  ["completion","tools"]),
  "qwen2.5vl:7b":       (6e9,   "7.6B",  ["completion","vision"]),
  "qwen3:30b-a3b":      (19e9,  "30.5B", ["completion","tools","thinking"]),
}
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
            return self._j({"capabilities":MODELS[m][2]} if m in MODELS else {"error":"nf"}, 200 if m in MODELS else 404)
        if self.path=="/api/chat":
            model=body.get("model","?")
            msgs=body.get("messages",[])
            imgs=sum(len(m.get("images") or []) for m in msgs)
            reply=f"[{model}] received {imgs} image(s). I can see a desk with a keyboard."
            self.send_response(200); self.send_header("Content-Type","application/x-ndjson"); self.end_headers()
            for w in reply.split(" "):
                self.wfile.write(json.dumps({"message":{"content":w+" "}}).encode()+b"\n"); self.wfile.flush(); time.sleep(0.01)
            self.wfile.write(json.dumps({"done":True}).encode()+b"\n"); self.wfile.flush(); return
        self._j({},404)
socketserver.TCPServer.allow_reuse_address=True
socketserver.ThreadingTCPServer(("127.0.0.1",11434),H).serve_forever()
