const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

for (const script of [path.join(__dirname, "server.js"), path.join(__dirname, "../server.js")]) {
  test(`room folders: ${path.relative(path.join(__dirname, ".."), script)}`, async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "excalidraw-folders-"));
    let child;
    context.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    });
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const scene = { iv: "encrypted-iv", ciphertext: "encrypted-scene", version: 1, updatedAt: 1 };
    await writeFile(path.join(directory, "rooms.json"), JSON.stringify({
      legacy: { key: "secret", createdAt: 1, lastActiveAt: 1, hasScene: true },
    }));
    await writeFile(path.join(directory, "scenes.json"), JSON.stringify({ legacy: scene }));
    await writeFile(path.join(directory, "folders.json"), JSON.stringify({ "legacy-folder": "Legacy folder" }));

    const start = async () => {
      child = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          PORT: String(port),
          CODES_FILE: path.join(directory, "codes.json"),
          ROOMS_FILE: path.join(directory, "rooms.json"),
          SCENES_FILE: path.join(directory, "scenes.json"),
          FOLDERS_FILE: path.join(directory, "folders.json"),
        },
        stdio: "ignore",
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(child.exitCode, null, "server exited before becoming ready");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, { signal: AbortSignal.timeout(500) });
          if (response.ok) return;
        } catch {}
        await delay(25);
      }
      assert.fail("server did not become ready");
    };
    const request = async (pathname, method = "GET", payload) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    };
    await start();
    assert.deepEqual((await request("/api/rooms/folders")).body.folders, [{ id: "legacy-folder", name: "Legacy folder" }]);
    assert.equal((await request("/api/rooms/folders/legacy-folder", "DELETE")).status, 200);
    assert.equal((await request("/api/rooms")).body.rooms[0].folderId, undefined);
    const created = await request("/api/rooms/folders", "POST", { name: " School " });
    assert.equal(created.status, 200);
    const folder = created.body.folder;
    assert.equal(folder.name, "School");
    assert.equal((await request("/api/rooms/folders", "POST", { name: "school" })).status, 409);
    for (const name of ["", "  ", "a".repeat(65), 123]) {
      assert.equal((await request("/api/rooms/folders", "POST", { name })).status, 400);
    }
    assert.equal((await request("/api/rooms/legacy/folder", "POST", { key: "wrong", folderId: folder.id })).status, 403);
    for (const folderId of ["missing", "__proto__", 123, undefined]) {
      assert.equal((await request("/api/rooms/legacy/folder", "POST", { key: "secret", folderId })).status, 400);
    }
    assert.equal((await request("/api/rooms/legacy/folder", "POST", { key: "secret", folderId: folder.id })).status, 200);
    assert.equal((await request("/api/rooms")).body.rooms[0].folderId, folder.id);
    assert.equal((await request(`/api/rooms/folders/${folder.id}`, "POST", { name: "Classes" })).status, 200);
    assert.equal((await request("/api/rooms")).body.rooms[0].folderId, folder.id);
    const exited = once(child, "exit");
    child.kill();
    await exited;
    await start();
    assert.deepEqual((await request("/api/rooms/folders")).body.folders, [{ id: folder.id, name: "Classes" }]);
    assert.equal((await request("/api/rooms")).body.rooms[0].folderId, folder.id);
    const childFolder = (await request("/api/rooms/folders", "POST", { name: "Math", parentId: folder.id })).body.folder;
    const grandchild = (await request("/api/rooms/folders", "POST", { name: "Algebra", parentId: childFolder.id })).body.folder;
    assert.equal(childFolder.parentId, folder.id);
    assert.equal(grandchild.parentId, childFolder.id);
    assert.equal((await request("/api/rooms/folders", "POST", { name: "math", parentId: folder.id })).status, 409);
    const sameNameRoot = await request("/api/rooms/folders", "POST", { name: "Math", parentId: null });
    assert.equal(sameNameRoot.status, 200);
    assert.equal((await request(`/api/rooms/folders/${childFolder.id}`, "POST", { name: "Math", parentId: null })).status, 409);
    assert.equal((await request(`/api/rooms/folders/${sameNameRoot.body.folder.id}`, "DELETE")).status, 200);
    for (const parentId of ["missing", "__proto__", 123]) {
      assert.equal((await request("/api/rooms/folders", "POST", { name: "Invalid", parentId })).status, 400);
    }
    for (const parentId of [folder.id, childFolder.id, grandchild.id]) {
      assert.equal((await request(`/api/rooms/folders/${folder.id}`, "POST", { name: "Classes", parentId })).status, 400);
    }
    assert.equal((await request(`/api/rooms/folders/${childFolder.id}`, "POST", { name: "Mathematics" })).body.folder.parentId, folder.id);
    assert.equal((await request(`/api/rooms/folders/${childFolder.id}`, "POST", { name: "Mathematics", parentId: null })).status, 200);
    assert.equal((await request("/api/rooms/folders")).body.folders.find((entry) => entry.id === grandchild.id).parentId, childFolder.id);
    assert.equal((await request(`/api/rooms/folders/${childFolder.id}`, "POST", { name: "Mathematics", parentId: folder.id })).status, 200);
    const nestedExit = once(child, "exit");
    child.kill();
    await nestedExit;
    await start();
    const persistedFolders = (await request("/api/rooms/folders")).body.folders;
    assert.equal(persistedFolders.find((entry) => entry.id === childFolder.id).parentId, folder.id);
    assert.equal(persistedFolders.find((entry) => entry.id === grandchild.id).parentId, childFolder.id);
    assert.equal((await request("/api/rooms/legacy/folder", "POST", { key: "secret", folderId: null })).status, 200);
    assert.equal((await request("/api/rooms")).body.rooms[0].folderId, undefined);
    await request("/api/rooms/legacy/folder", "POST", { key: "secret", folderId: grandchild.id });
    assert.equal((await request(`/api/rooms/folders/${folder.id}`, "DELETE")).status, 200);
    assert.deepEqual((await request("/api/rooms/folders")).body.folders, []);
    const remainingRoom = (await request("/api/rooms")).body.rooms[0];
    assert.equal(remainingRoom.roomId, "legacy");
    assert.equal(remainingRoom.folderId, undefined);
    assert.equal(remainingRoom.hasScene, true);
    assert.equal((await request("/api/rooms/legacy/scene?key=secret")).body.ciphertext, scene.ciphertext);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "scenes.json"), "utf8")), { legacy: scene });
    assert.equal(JSON.parse(await readFile(path.join(directory, "rooms.json"), "utf8")).legacy.folderId, undefined);
    assert.equal((await request(`/api/rooms/folders/${folder.id}`, "DELETE")).status, 404);
  });
}
