# Minimal Ollama stand-in to prove the proxy + streaming path end-to-end.
import http.server, json, socketserver, time
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        if self.path=="/api/tags":
            b=json.dumps({"models":[{"name":"qwen2.5:3b","size":1900000000,
                "details":{"family":"qwen2","parameter_size":"3.1B"}}]}).encode()
            self.send_response(200); self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
        else: self.send_response(404); self.end_headers()
    def do_POST(self):
        n=int(self.headers.get("Content-Length",0)); body=json.loads(self.rfile.read(n) or b"{}")
        # Real Ollama (>=0.6.0) reports what a model can actually do here.
        if self.path=="/api/show":
            b=json.dumps({"capabilities":["completion","tools"],
                          "details":{"family":"qwen2","parameter_size":"3.1B"}}).encode()
            self.send_response(200); self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
            return
        self.send_response(200); self.send_header("Content-Type","application/x-ndjson"); self.end_headers()
        if self.path=="/api/chat":
            for w in ["AURA ","ONLINE ","via ","proxy"]:
                self.wfile.write(json.dumps({"message":{"content":w}}).encode()+b"\n"); self.wfile.flush(); time.sleep(0.05)
            self.wfile.write(json.dumps({"done":True}).encode()+b"\n")
        elif self.path=="/api/pull":
            for pct in (0,45,100):
                self.wfile.write(json.dumps({"status":"downloading","completed":pct,"total":100}).encode()+b"\n")
                self.wfile.flush(); time.sleep(0.05)
            self.wfile.write(json.dumps({"status":"success"}).encode()+b"\n")
        self.wfile.flush()
socketserver.TCPServer.allow_reuse_address=True
socketserver.TCPServer(("127.0.0.1",11599),H).serve_forever()
