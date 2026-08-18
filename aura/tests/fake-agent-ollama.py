"""
Ollama stand-in that DRIVES THE AGENT LOOP like a real model would.

It returns one action per call, in a plausible order for the WhatsApp task,
and deliberately varies its JSON formatting the way real 7B models do.
"""
import http.server, json, socketserver, time, sys

MODELS = {
  "gemma2:2b":    (1.6e9, "2.6B", ["completion"]),
  "qwen2.5vl:7b": (6.0e9, "7.6B", ["completion","vision"]),
}

# Deliberately messy formats, in the order the agent should need them.
SCRIPT = [
  '{"action":"open_app","app":"whatsapp","why":"WhatsApp is not open yet"}',
  "```json\n{'action':'click','target':'search box','cell':'B2','why':'find the contact'}\n```",
  '{"action":"type","text":"Fiona Harris","why":"search for the contact",}',
  '{action: "click", target: "Fiona Harris", cell: "B4", why: "open the chat"}',
  'I will click the message box now (cell F8) to focus it.',
  '{"action":"type","text":"Hi","why":"the message body"}',
  '{"action":"press","key":"enter","why":"send it"}',
  '{"action":"done","reason":"message sent to Fiona Harris"}',
]
_i = {"n": 0}

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
        if self.path=="/__reset":
            _i["n"]=0; return self._j({"ok":True})
        self._j({},404)
    def do_POST(self):
        n=int(self.headers.get("Content-Length",0)); body=json.loads(self.rfile.read(n) or b"{}")
        if self.path=="/api/show":
            m=body.get("model")
            return self._j({"capabilities":MODELS[m][2]} if m in MODELS else {"error":"nf"},
                           200 if m in MODELS else 404)
        if self.path=="/api/chat":
            txt=" ".join(m.get("content","") for m in body.get("messages",[]))
            if "one action at a time" in txt.lower() or "single next action" in txt.lower():
                reply=SCRIPT[min(_i["n"], len(SCRIPT)-1)]; _i["n"]+=1
            else:
                reply='{"steps":[{"do":"hotkey","keys":"ctrl+w"}]}'
            self.send_response(200); self.send_header("Content-Type","application/x-ndjson"); self.end_headers()
            for w in reply.split(" "):
                self.wfile.write(json.dumps({"message":{"content":w+" "}}).encode()+b"\n"); self.wfile.flush(); time.sleep(0.002)
            self.wfile.write(json.dumps({"done":True}).encode()+b"\n"); self.wfile.flush(); return
        self._j({},404)

port=int(sys.argv[1]) if len(sys.argv)>1 else 11434
socketserver.TCPServer.allow_reuse_address=True
socketserver.ThreadingTCPServer(("127.0.0.1",port),H).serve_forever()
