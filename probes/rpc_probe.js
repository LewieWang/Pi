const { spawn } = require("child_process");
const PI = "C:/Users/lewie/.workbuddy/binaries/node/versions/22.22.2-6/pi.cmd";
const SESS = process.argv[2];
if (!SESS) { console.error("usage: node rpc_probe.js <session.jsonl>"); process.exit(2); }
const p = spawn(PI, ["--mode","rpc","--model","volcengine-ark/ark-code-latest","--session",SESS],
  { cwd: "D:/PI/workspace", shell: true, stdio: ["pipe","pipe","pipe"] });
let buf = "";
function onLine(line){
  if(!line.trim()) return; let rec; try{ rec = JSON.parse(line); }catch{ return; }
  if(rec.type === "response" && rec.command === "get_messages"){
    const msgs = (rec.data && rec.data.messages) || [];
    console.log("COUNT:", msgs.length);
    msgs.forEach((m, idx) => {
      const c = m.content;
      const ctype = Array.isArray(c) ? c.map(b => b && b.type).filter(Boolean).join("|") : typeof c;
      const prev = typeof c === "string" ? c : (Array.isArray(c) ? ((c.find(b => b && b.type === "text") || {}).text) : "");
      console.log(`#${idx} role=${m.role} content=[${ctype}] :: ${JSON.stringify(String(prev||"")).slice(0,55)}`);
    });
    try { p.stdin.end(); } catch(e){}
    p.kill(); process.exit(0);
  }
}
p.stdout.on("data", d => { buf += d; let i; while((i = buf.indexOf("\n"))>=0){ onLine(buf.slice(0,i).replace(/\r$/,"")); buf = buf.slice(i+1);} });
p.stderr.on("data", () => {});
p.on("exit", () => process.exit(0));
setTimeout(() => { try { p.stdin.write(JSON.stringify({type:"get_messages"})+"\n"); } catch(e){} }, 2500);
setTimeout(() => { console.log("TIMEOUT. buf head:", buf.slice(0,600)); process.exit(1); }, 25000);
