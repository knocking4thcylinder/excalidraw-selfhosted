const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

test("release imports legacy data, serves HTTP, survives restart and exports for rollback", { skip: process.env.RUN_BACKEND_CONTAINER_TESTS !== "1" }, async (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "whiteboard-release-"));
  const name = `whiteboard-release-test-${process.pid}`;
  const image = process.env.BACKEND_IMAGE || "excalidraw-api-elixir";
  const podman = (...args) => execFileSync("sudo", ["-n", "podman", ...args], { encoding: "utf8", timeout: 60000 });
  context.after(() => {
    try { podman("rm", "-f", name); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  for (const folder of ["legacy", "data", "export"]) mkdirSync(path.join(directory, folder));
  const documents = {
    "rooms.json": { room: { key: "secret", createdAt: 1, lastActiveAt: 2, hasScene: true } },
    "scenes.json": { room: { iv: "original-iv", ciphertext: "original-cipher", version: 1, updatedAt: 2 } },
    "folders.json": { folder: "Imported folder" },
    "codes.json": { "ABCD-EFGH": "https://deck/#room=room,secret" },
  };
  for (const [filename, document] of Object.entries(documents)) {
    writeFileSync(path.join(directory, "legacy", filename), JSON.stringify(document));
  }
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const ready = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`${base}/api/rooms`, { signal: AbortSignal.timeout(500) })).ok) return;
      } catch {}
      await delay(100);
    }
    assert.fail(`release failed to start: ${podman("logs", name)}`);
  };
  podman("run", "-d", "--name", name, "--network", "host",
    "-e", "RELEASE_DISTRIBUTION=none",
    "-e", `PORT=${port}`, "-e", "ERL_FLAGS=+S 4:4", "-e", "LEGACY_DATA_DIR=/legacy",
    "-v", `${directory}/legacy:/legacy:ro`, "-v", `${directory}/data:/data`, image);
  await ready();
  assert.equal((await (await fetch(`${base}/api/rooms`)).json()).rooms[0].key, "secret");
  assert.equal((await (await fetch(`${base}/api/resolve/abcd-efgh`)).json()).url, documents["codes.json"]["ABCD-EFGH"]);
  assert.equal((await (await fetch(`${base}/api/rooms/folders`)).json()).folders[0].name, "Imported folder");
  const sceneUrl = `${base}/api/rooms/room/scene?key=secret`;
  const first = await fetch(sceneUrl);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.equal(first.headers.get("content-length"), String(Buffer.byteLength(await first.text())));
  assert.equal((await fetch(sceneUrl, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(sceneUrl, { headers: { "If-None-Match": etag } })).status, 304);
  assert.equal((await fetch(sceneUrl.replace("secret", "wrong"), { headers: { "If-None-Match": etag } })).status, 403);
  const updated = await fetch(`${base}/api/rooms/room/scene`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "secret", iv: "new-iv", ciphertext: "new-cipher", sceneVersion: 2, isEmpty: false }),
  });
  assert.equal(updated.status, 200);
  podman("restart", "-t", "5", name);
  await ready();
  const saved = await fetch(sceneUrl);
  assert.equal(saved.headers.get("x-scene-revision"), "1");
  assert.equal((await saved.json()).ciphertext, "new-cipher");
  assert.equal((await (await fetch(`${sceneUrl}&slot=1`)).json()).ciphertext, "original-cipher");
  const empty = await fetch(`${base}/api/rooms/room/scene`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "secret", iv: "empty", ciphertext: "empty", sceneVersion: 0, isEmpty: true }),
  });
  assert.equal(empty.status, 409);
  for (const [filename, document] of Object.entries(documents)) {
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "legacy", filename), "utf8")), document);
  }
  podman("stop", "-t", "5", name);
  podman("run", "--rm", "--network", "host", "-e", `PORT=${port}`, "-e", "ERL_FLAGS=+S 4:4",
    "-e", "RELEASE_DISTRIBUTION=none",
    "-v", `${directory}/data:/data`, "-v", `${directory}/export:/export`, image,
    "/srv/bin/whiteboard", "eval", '{:ok, _} = Application.ensure_all_started(:whiteboard); Whiteboard.Export.run!("/export")');
  const readExport = (filename) => JSON.parse(podman("run", "--rm", "-v", `${directory}/export:/export:ro`, image, "cat", `/export/${filename}`));
  const scenes = readExport("scenes.json");
  assert.equal(scenes.room.ciphertext, "new-cipher");
  assert.equal(scenes.room.history[0].ciphertext, "original-cipher");
  assert.deepEqual(readExport("codes.json"), documents["codes.json"]);
});
