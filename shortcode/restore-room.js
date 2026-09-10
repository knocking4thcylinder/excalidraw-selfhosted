// Restore a room's server snapshot from a local `.excalidraw` export.
// Usage: node restore-room.js <scene-url> <roomId> <roomKey> <export.excalidraw>
//   scene-url: e.g. https://host:8443/api/rooms/<roomId>/scene
// Encrypts exactly like the client's encryptData (AES-128-GCM, JWK octet key,
// random 12-byte IV) and POSTs {key, iv, ciphertext, sceneVersion, isEmpty}.
// The previous snapshot is pushed to server history, so this is reversible
// via GET .../scene?slot=1.
const crypto = require("crypto");
const fs = require("fs");

const [url, roomId, roomKey, file] = process.argv.slice(2);
if (!url || !roomId || !roomKey || !file) {
  console.error(
    "usage: node restore-room.js <scene-url> <roomId> <roomKey> <export.excalidraw>",
  );
  process.exit(1);
}

const exported = JSON.parse(fs.readFileSync(file, "utf8"));
const elements = exported.elements;
if (!Array.isArray(elements) || elements.length === 0) {
  console.error("export contains no elements");
  process.exit(1);
}

const key = Buffer.from(roomKey, "base64url");
if (key.length !== 16) {
  console.error(`room key decodes to ${key.length} bytes, expected 16`);
  process.exit(1);
}
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-128-gcm", key, iv);
const ciphertext = Buffer.concat([
  cipher.update(JSON.stringify(elements), "utf8"),
  cipher.final(),
  cipher.getAuthTag(),
]);

const sceneVersion = Math.max(
  0,
  ...elements.map((e) => (typeof e.version === "number" ? e.version : 0)),
);

fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    key: roomKey,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    sceneVersion,
    isEmpty: false,
  }),
})
  .then(async (resp) => {
    console.log("status:", resp.status, await resp.text());
    if (!resp.ok) {
      process.exit(1);
    }
    console.log(
      `restored ${elements.length} elements to room ${roomId} (sceneVersion ${sceneVersion})`,
    );
  })
  .catch((e) => {
    console.error("restore failed:", e.message);
    process.exit(1);
  });
