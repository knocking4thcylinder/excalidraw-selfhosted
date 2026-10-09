const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

test("encrypted patches survive restart, reduce cached transfers and export losslessly", {
  skip: process.env.RUN_BACKEND_CONTAINER_TESTS !== "1",
}, async (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "whiteboard-sync-release-"));
  const name = `whiteboard-sync-test-${process.pid}`;
  const image = process.env.BACKEND_IMAGE || "excalidraw-api-elixir";
  const podman = (...args) => execFileSync("sudo", ["-n", "podman", ...args], { encoding: "utf8", timeout: 60000 });
  context.after(() => {
    try { podman("rm", "-f", name); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  for (const folder of ["data", "export"]) mkdirSync(path.join(directory, folder));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const ready = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/api/rooms`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
      await delay(100);
    }
    assert.fail("isolated backend did not start");
  };
  const secret = randomBytes(16);
  const key = secret.toString("base64url");
  const encrypted = (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-128-gcm", secret, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
    return { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64") };
  };
  const decrypted = (value) => {
    const encrypted = Buffer.from(value.ciphertext, "base64");
    const decipher = createDecipheriv("aes-128-gcm", secret, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(encrypted.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString());
  };
  const replay = (manifest) => {
    let elements = decrypted(manifest);
    for (const record of manifest.patches) {
      const patch = decrypted(record);
      const values = new Map(elements.map((element) => [element.id, element]));
      for (const id of patch.removedIds) values.delete(id);
      for (const element of patch.upserts) values.set(element.id, element);
      elements = patch.order ? patch.order.map((id) => values.get(id)) : [...values.values()];
    }
    return elements;
  };
  const save = (method, value) => fetch(`${base}/api/rooms/room/scene`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify({ key, isEmpty: false, syncVersion: 1, ...value }),
  });
  podman("run", "-d", "--name", name, "--network", "host", "-e", `PORT=${port}`,
    "-e", "RELEASE_DISTRIBUTION=none",
    "-e", "ERL_FLAGS=+S 4:4", "-e", "SCENE_SYNC_ENABLED=true", "-v", `${directory}/data:/data`, image);
  await ready();
  assert.equal((await fetch(`${base}/api/rooms`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId: "room", roomKey: key }),
  })).status, 200);
  const original = Array.from({ length: 40 }, (_, index) => ({ id: `shape-${index}`, type: "rectangle", x: index * 100, y: 0, width: 100, height: 100, version: 1 }));
  const initial = await save("POST", { ...encrypted(original), baseEtag: null, sceneVersion: 40 });
  assert.equal(initial.status, 200);
  const baseEtag = initial.headers.get("etag");
  const variants = [500, 700].map((position) => ({ ...original[0], x: position, version: 2 }));
  const writes = await Promise.all(variants.map((element) => save("PATCH", {
    ...encrypted({ format: 1, upserts: [element], removedIds: [] }), baseEtag, sceneVersion: 41,
  })));
  assert.deepEqual(writes.map((response) => response.status).sort(), [200, 412]);
  const winner = writes.findIndex((response) => response.status === 200);
  const expected = [variants[winner], ...original.slice(1)];
  const latest = writes[winner].headers.get("etag");
  const sceneUrl = `${base}/api/rooms/room/scene?key=${key}&sync=1`;
  const full = await fetch(sceneUrl);
  const fullBody = await full.text();
  assert.deepEqual(replay(JSON.parse(fullBody)), expected);
  const tail = await fetch(`${sceneUrl}&since=${encodeURIComponent(baseEtag)}`);
  const tailBody = await tail.text();
  assert.ok(tailBody.length < fullBody.length / 4);
  assert.equal(JSON.parse(tailBody).iv, undefined);
  assert.equal((await fetch(sceneUrl, { headers: { "If-None-Match": latest } })).status, 304);
  assert.equal((await fetch(`${base}/api/rooms/room/scene?key=${key}`)).status, 409);
  podman("restart", "-t", "5", name);
  await ready();
  assert.deepEqual(replay(await (await fetch(sceneUrl)).json()), expected);
  const checkpoint = await save("POST", { ...encrypted(expected), baseEtag: latest, sceneVersion: 41 });
  assert.equal(checkpoint.status, 200);
  const finalElements = [{ ...expected[0], x: 900, version: 3 }, ...expected.slice(1)];
  assert.equal((await save("PATCH", { ...encrypted({ format: 1, upserts: [finalElements[0]], removedIds: [] }), baseEtag: checkpoint.headers.get("etag"), sceneVersion: 42 })).status, 200);
  podman("stop", "-t", "5", name);
  podman("run", "--rm", "--network", "host", "-e", `PORT=${port}`, "-e", "ERL_FLAGS=+S 4:4",
    "-e", "RELEASE_DISTRIBUTION=none",
    "-v", `${directory}/data:/data`, "-v", `${directory}/export:/export`, image,
    "/srv/bin/whiteboard", "eval", '{:ok, _} = Application.ensure_all_started(:whiteboard); Whiteboard.Export.run!("/export")');
  const scene = JSON.parse(podman("run", "--rm", "-v", `${directory}/export:/export:ro`, image, "cat", "/export/scenes.json")).room;
  assert.equal(scene.patches.length, 1);
  assert.deepEqual(replay(scene), finalElements);
  assert.deepEqual(replay(scene.history[0]), expected);
});
