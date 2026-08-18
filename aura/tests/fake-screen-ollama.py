# Ollama stand-in for screen-agent tests: a small OCR model + a chat model.
import http.server, json, socketserver, time
MODELS = {
  "moondream:latest": (1.7e9, "1.7B", ["completion","vision"]),
  "gemma2:2b":        (1.6e9, "2.6B", ["completion"]),
  "qwen2.5vl:7b":     (6.0e9, "7.6B", ["completion","vision"]),
  "gemma4:12b":       (7.0e9, "12.0B",["completion","vision","tools"]),
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
            return self._j({"capabilities":MODELS[m][2]} if m in MODELS else {"error":"nf"},
                           200 if m in MODELS else 404)
        if self.path=="/api/chat":
            model=body.get("model","?"); msgs=body.get("messages",[])
            imgs=sum(len(m.get("images") or []) for m in msgs)
            txt=" ".join(m.get("content","") for m in msgs)
            # moondream behaves like the real thing: almost nothing back.
            if model.startswith("moondream"):
                reply="a screenshot"
            elif "Find:" in txt:
                # locate() - must be checked BEFORE the planner branch, since
                # its prompt also mentions the grid.
                reply="C4"
            elif "STRICT JSON" in txt and "grid" in txt.lower():
                reply='{"steps":[{"do":"click","target":"Send","cell":"C4"},{"do":"type","text":"hello"}]}'
            elif "Transcribe" in txt:
                reply=f"[{model}] OCR({imgs} img): File Edit View\nSave\nCancel\nError: disk full"
            elif "STRICT JSON" in txt:
                reply='{"steps":[{"do":"click","target":"Save"},{"do":"hotkey","keys":"ctrl+s"}]}'
            else:
                reply=f"[{model}] answered with {imgs} image(s). The screen shows an error: disk full."
            self.send_response(200); self.send_header("Content-Type","application/x-ndjson"); self.end_headers()
            for w in reply.split(" "):
                self.wfile.write(json.dumps({"message":{"content":w+" "}}).encode()+b"\n"); self.wfile.flush(); time.sleep(0.005)
            self.wfile.write(json.dumps({"done":True}).encode()+b"\n"); self.wfile.flush(); return
        self._j({},404)
socketserver.TCPServer.allow_reuse_address=True
socketserver.ThreadingTCPServer(("127.0.0.1",11434),H).serve_forever()
