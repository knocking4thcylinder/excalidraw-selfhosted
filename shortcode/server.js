// Short-code service for Excalidraw rooms.
// POST /api/code  {url: "https://host/#room=<id>,<key>"}  → {code: "ABCD-EFGH"}
// GET  /s/<CODE>                                         → 302 to the room
// Mapping is persisted to CODES_FILE (JSON). Deleting the file revokes all codes.
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3003;
const FILE = process.env.CODES_FILE || "/data/codes.json";
const ROOMS_FILE = process.env.ROOMS_FILE || "/data/rooms.json";
const SCENES_FILE = process.env.SCENES_FILE || "/data/scenes.json";
const FOLDERS_FILE = process.env.FOLDERS_FILE || require("path").join(require("path").dirname(ROOMS_FILE), "folders.json");

let folders = {};
try { folders = JSON.parse(fs.readFileSync(FOLDERS_FILE, "utf8")); } catch {}
folders = Object.fromEntries(Object.entries(folders).map(([id, folder]) => [id, typeof folder === "string" ? { name: folder } : folder]));
const saveFolders = () => fs.writeFileSync(FOLDERS_FILE, JSON.stringify(folders, null, 2));

let codes = {};
try { codes = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
let rooms = {};
try { rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8")); } catch {}
let scenes = {};
try { scenes = JSON.parse(fs.readFileSync(SCENES_FILE, "utf8")); } catch {}

const save = () => {
  try { fs.writeFileSync(FILE, JSON.stringify(codes, null, 2)); } catch (e) { console.error("save failed", e); }
};
const saveRooms = () => {
  try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)); } catch (e) { console.error("save failed", e); }
};
const saveScenes = () => {
  try { fs.writeFileSync(SCENES_FILE, JSON.stringify(scenes, null, 2)); } catch (e) { console.error("save failed", e); }
};

// JSON reply for the /api/rooms endpoints — never cached (like /api/resolve).
// Content-Length is set explicitly: without it node uses chunked encoding,
// and chunked JSON bodies stall some proxied browsers on this tailnet
// (incident 2026-09-11: 3.8 MB scene snapshot never completed in-page while
// curl received it fine; small chunked bodies squeaked through).
const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};

// purely-alphanumeric ids are case-normalized; keys are case-sensitive, never normalized
const normId = (id) => (/^[A-Za-z0-9]+$/.test(id) ? id.toLowerCase() : id);

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

    if (req.method === "POST" && u.pathname === "/api/rooms") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let p = {};
        try { p = JSON.parse(body); } catch {}
        const { roomId, roomKey } = p;
        if (typeof roomId !== "string" || typeof roomKey !== "string" || !roomId || !roomKey) {
          json(res, 400, { error: "roomId and roomKey required" });
          return;
        }
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) {
          json(res, 400, { error: "invalid roomId" });
          return;
        }
        const id = normId(roomId);
        const room = rooms[id];
        if (room) {
          if (room.key !== roomKey) {
            json(res, 409, { error: "roomId already registered with a different key" });
            return;
          }
          room.lastActiveAt = Date.now();
          saveRooms();
          json(res, 200, { ok: true, created: false });
          return;
        }
        rooms[id] = { key: roomKey, createdAt: Date.now(), lastActiveAt: Date.now(), hasScene: false };
        saveRooms();
        json(res, 200, { ok: true, created: true });
      });
      return;
    }

    if (req.method === "GET" && u.pathname === "/api/rooms") {
      json(res, 200, {
        rooms: Object.entries(rooms)
          .map(([roomId, r]) => ({ roomId, key: r.key, createdAt: r.createdAt, lastActiveAt: r.lastActiveAt, hasScene: r.hasScene, ...(r.name ? { name: r.name } : {}), ...(r.folderId && Object.hasOwn(folders, r.folderId) ? { folderId: r.folderId } : {}) }))
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt),
      });
      return;
    }

    if (req.method === "GET" && u.pathname === "/api/rooms/folders") {
      json(res, 200, { folders: Object.entries(folders).map(([id, folder]) => ({ id, ...folder })) });
      return;
    }

    const folderRoute = u.pathname.match(/^\/api\/rooms\/folders(?:\/([A-Za-z0-9_-]{1,64}))?$/);
    if (folderRoute && (req.method === "POST" || req.method === "DELETE")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const id = folderRoute[1];
          if (id && !Object.hasOwn(folders, id)) { json(res, 404, { error: "unknown folder" }); return; }
          if (req.method === "DELETE") {
            if (!id) { json(res, 400, { error: "folder id required" }); return; }
            const nextFolders = { ...folders };
            const deletedIds = new Set([id]);
            let previousSize;
            do {
              previousSize = deletedIds.size;
              for (const [folderId, folder] of Object.entries(folders)) {
                if (deletedIds.has(folder.parentId)) deletedIds.add(folderId);
              }
            } while (deletedIds.size !== previousSize);
            for (const folderId of deletedIds) delete nextFolders[folderId];
            fs.writeFileSync(FOLDERS_FILE, JSON.stringify(nextFolders, null, 2));
            folders = nextFolders;
            for (const room of Object.values(rooms)) {
              if (deletedIds.has(room.folderId)) delete room.folderId;
            }
            saveRooms();
            json(res, 200, { ok: true });
            return;
          }
          const payload = JSON.parse(body);
          if (!payload || typeof payload !== "object") { json(res, 400, { error: "invalid folder" }); return; }
          const name = typeof payload.name === "string" ? payload.name.trim() : "";
          if (!name || name.length > 64) { json(res, 400, { error: "folder name must be 1–64 characters" }); return; }
          const parentId = payload.parentId === undefined ? (id ? folders[id].parentId ?? null : null) : payload.parentId;
          if (parentId !== null && (typeof parentId !== "string" || !Object.hasOwn(folders, parentId))) {
            json(res, 400, { error: "unknown parent folder" }); return;
          }
          let ancestorId = parentId;
          const ancestors = new Set();
          while (ancestorId !== null) {
            if (ancestorId === id || ancestors.has(ancestorId)) {
              json(res, 400, { error: "folder cannot contain itself" }); return;
            }
            ancestors.add(ancestorId);
            ancestorId = folders[ancestorId]?.parentId ?? null;
          }
          if (Object.entries(folders).some(([existingId, folder]) => existingId !== id && (folder.parentId ?? null) === parentId && folder.name.toLowerCase() === name.toLowerCase())) {
            json(res, 409, { error: "folder name already exists" }); return;
          }
          const folderId = id || crypto.randomUUID();
          const previousFolders = folders;
          const folder = { name, ...(parentId ? { parentId } : {}) };
          folders = { ...folders, [folderId]: folder };
          try { saveFolders(); } catch (error) { folders = previousFolders; throw error; }
          json(res, 200, { folder: { id: folderId, ...folder } });
        } catch (error) {
          json(res, error instanceof SyntaxError ? 400 : 500, { error: "could not save folder" });
        }
      });
      return;
    }

    const move = u.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/folder$/);
    if (req.method === "POST" && move) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const payload = JSON.parse(body);
          const room = rooms[normId(move[1])];
          if (!room) { json(res, 404, { error: "unknown room" }); return; }
          if (payload.key !== room.key) { json(res, 403, { error: "wrong key" }); return; }
          if (payload.folderId !== null && (typeof payload.folderId !== "string" || !Object.hasOwn(folders, payload.folderId))) {
            json(res, 400, { error: "unknown folder" }); return;
          }
          const previousFolderId = room.folderId;
          if (payload.folderId === null) delete room.folderId; else room.folderId = payload.folderId;
          try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)); } catch (error) {
            if (previousFolderId === undefined) delete room.folderId; else room.folderId = previousFolderId;
            throw error;
          }
          json(res, 200, { ok: true });
        } catch (error) {
          json(res, error instanceof SyntaxError ? 400 : 500, { error: "could not move room" });
        }
      });
      return;
    }

    const rn = u.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/rename$/);
    if (req.method === "POST" && rn) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let p = {};
        try { p = JSON.parse(body); } catch {}
        const id = normId(rn[1]);
        const room = rooms[id];
        if (!room) { json(res, 404, { error: "unknown room" }); return; }
        if (p.key !== room.key) { json(res, 403, { error: "wrong key" }); return; }
        if (typeof p.name !== "string") { json(res, 400, { error: "name must be a string" }); return; }
        const name = p.name.trim();
        if (name.length > 64) { json(res, 400, { error: "name too long" }); return; }
        if (name) room.name = name; else delete room.name;
        saveRooms();
        json(res, 200, { ok: true });
      });
      return;
    }

    const del = u.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,64})$/);
    if (req.method === "DELETE" && del) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let p = {};
        try { p = JSON.parse(body); } catch {}
        const id = normId(del[1]);
        const room = rooms[id];
        if (!room) { json(res, 404, { error: "unknown room" }); return; }
        const key = typeof p.key === "string" ? p.key : u.searchParams.get("key");
        if (key !== room.key) { json(res, 403, { error: "wrong key" }); return; }
        delete rooms[id];
        delete scenes[id];
        saveRooms();
        saveScenes();
        json(res, 200, { ok: true });
      });
      return;
    }

// Scene snapshots are versioned: every overwrite pushes the previous
// snapshot onto a capped history (HISTORY_SLOTS), so a bad save is always
// recoverable via GET ?slot=N. Since payloads are end-to-end encrypted,
// the server can't tell empty from full — the client declares isEmpty.
// Invariant (incident 2026-09-11): an empty scene NEVER replaces a
// non-empty snapshot (409); the client also skips such saves proactively.
const HISTORY_SLOTS = 10;

// Minimal audit trail (incident 2026-09-11): who reads/writes snapshots,
// from where (tailnet IP via Caddy's X-Forwarded-For), with what outcome.
// Invaluable when a room "opens empty" — shows whether the client ever
// asked, and what the server answered.
const peer = (req) =>
  req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?";

const audit = (req, msg) => {
  console.log(new Date().toISOString(), "AUDIT", peer(req), msg);
};

const snapOf = (s) => ({
  iv: s.iv,
  ciphertext: s.ciphertext,
  version: s.version ?? null,
  updatedAt: s.updatedAt,
  isEmpty: s.isEmpty === true,
});

    const hs = u.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/scene-history$/);
    if (req.method === "GET" && hs) {
      const id = normId(hs[1]);
      const room = rooms[id];
      if (!room) { json(res, 404, { error: "unknown room" }); return; }
      if (u.searchParams.get("key") !== room.key) { json(res, 403, { error: "wrong key" }); return; }
      const s = scenes[id];
      if (!s) { json(res, 404, { error: "no scene" }); return; }
      json(res, 200, {
        versions: [{ slot: 0, ...snapOf(s) },
          ...((s.history || []).map((h, i) => ({ slot: i + 1, ...snapOf(h) })))],
      });
      return;
    }

    const sm = u.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/scene$/);
    if (req.method === "GET" && sm) {
      const id = normId(sm[1]);
      const room = rooms[id];
      if (!room) { json(res, 404, { error: "unknown room" }); return; }
      if (u.searchParams.get("key") !== room.key) { json(res, 403, { error: "wrong key" }); return; }
      const s = scenes[id];
      if (!s) { json(res, 404, { error: "no scene" }); return; }
      // ?slot=N fetches an older snapshot: 0 = current (default),
      // 1..HISTORY_SLOTS = history depth. Used for manual recovery.
      const slot = Number(u.searchParams.get("slot") || 0);
      const pick = slot === 0 ? s : (s.history || [])[slot - 1];
      if (!pick) { json(res, 404, { error: "no such slot" }); return; }
      const out = snapOf(pick);
      audit(req, `GET scene ${id} slot=${slot} v=${out.version} -> 200`);
      json(res, 200, { iv: out.iv, ciphertext: out.ciphertext, version: out.version, updatedAt: out.updatedAt });
      return;
    }

    if (req.method === "POST" && sm) {
      const MAX = 5 * 1024 * 1024;
      if (Number(req.headers["content-length"] || 0) > MAX) {
        req.resume();
        json(res, 413, { error: "body too large" });
        return;
      }
      let body = "", size = 0, tooBig = false;
      req.on("data", (c) => {
        if (tooBig) return;
        size += c.length;
        if (size > MAX) { tooBig = true; json(res, 413, { error: "body too large" }); return; }
        body += c;
      });
      req.on("end", () => {
        if (tooBig) return;
        let p = {};
        try { p = JSON.parse(body); } catch {}
        const id = normId(sm[1]);
        const room = rooms[id];
        if (!room) { json(res, 404, { error: "unknown room" }); return; }
        if (p.key !== room.key) { json(res, 403, { error: "wrong key" }); return; }
        if (typeof p.iv !== "string" || typeof p.ciphertext !== "string" || !p.iv || !p.ciphertext) {
          json(res, 400, { error: "iv and ciphertext required" });
          return;
        }
        const prev = scenes[id];
        const declaresEmpty = p.isEmpty === true;
        const declaresNonEmpty = p.isEmpty === false;
        const incomingVersion =
          typeof p.sceneVersion === "number" ? p.sceneVersion : null;
        // Hard invariant: an empty scene never replaces a non-empty snapshot.
        // Payloads are opaque, so emptiness is inferred two ways: an explicit
        // isEmpty declaration (new clients), or a zero sceneVersion from a
        // client that doesn't declare non-empty (old clients: sceneVersion is
        // a sum of element versions, each >= 1, so 0 means empty). Saves that
        // declare nothing and carry a positive version stay backward
        // compatible; history still protects against those.
        const prevVersion =
          prev && typeof prev.version === "number" ? prev.version : null;
        const incomingEmpty =
          declaresEmpty ||
          (!declaresNonEmpty &&
            incomingVersion !== null &&
            incomingVersion <= 0);
        const prevNonEmpty =
          !!prev &&
          prev.isEmpty !== true &&
          !(prevVersion !== null && prevVersion <= 0);
        if (incomingEmpty && prevNonEmpty) {
          audit(req, `POST scene ${id} EMPTY v=${incomingVersion} -> 409`);
          json(res, 409, { error: "refusing empty overwrite" });
          return;
        }
        scenes[id] = {
          iv: p.iv,
          ciphertext: p.ciphertext,
          version: incomingVersion,
          updatedAt: Date.now(),
          isEmpty: declaresEmpty,
          history: prev
            ? [snapOf(prev), ...((prev.history || []).slice(0, HISTORY_SLOTS - 1))]
            : [],
        };
        room.hasScene = true;
        room.lastActiveAt = Date.now();
        saveRooms();
        saveScenes();
        audit(req, `POST scene ${id} v=${incomingVersion} empty=${!!declaresEmpty} -> 200`);
        json(res, 200, { ok: true });
      });
      return;
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end("short code service is running");
  })
  .listen(PORT, () => console.log("shortcode service on :" + PORT));
