// Short-code service for Excalidraw rooms.
// POST /api/code  {url: "https://host/#room=<id>,<key>"}  → {code: "ABCD-EFGH"}
// GET  /s/<CODE>                                         → 302 to the room
// Mapping is persisted to CODES_FILE (JSON). Deleting the file revokes all codes.
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3003;
const FILE = process.env.CODES_FILE || "/data/codes.json";

let codes = {};
try { codes = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

const save = () => {
  try { fs.writeFileSync(FILE, JSON.stringify(codes, null, 2)); } catch (e) { console.error("save failed", e); }
};

// no 0/O, 1/I/L — codes are human-typed
const ALPH = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function gen() {
  const raw = Array.from(crypto.randomBytes(8))
    .map((b) => ALPH[b % ALPH.length])
    .join("");
  return raw.slice(0, 4) + "-" + raw.slice(4);
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");

    if (req.method === "POST" && u.pathname === "/api/code") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { url } = JSON.parse(body);
          const m = (url || "").match(/#room=([A-Za-z0-9_-]+),([A-Za-z0-9_-]+)/);
          if (!m) { res.writeHead(400); res.end("bad url"); return; }
          const base = new URL(url).origin + new URL(url).pathname;
          const target = base + `#room=${m[1]},${m[2]}`;
          for (const [c, existing] of Object.entries(codes)) {
            if (existing === target) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ code: c }));
              return;
            }
          }
          let code = gen();
          while (codes[code]) code = gen();
          codes[code] = target;
          save();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ code }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    const m = u.pathname.match(/^\/s\/([A-Za-z0-9-]{4,12})/i);
    if (req.method === "GET" && m) {
      const url = codes[m[1].toUpperCase()];
      if (url) {
        res.writeHead(302, { Location: url });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("unknown code");
      return;
    }

    const r = u.pathname.match(/^\/api\/resolve\/([A-Za-z0-9-]{4,12})$/i);
    if (req.method === "GET" && r) {
      const url = codes[r[1].toUpperCase()];
      res.writeHead(url ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(url ? { url } : { error: "unknown code" }));
      return;
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end("short code service is running");
  })
  .listen(PORT, () => console.log("shortcode service on :" + PORT));
