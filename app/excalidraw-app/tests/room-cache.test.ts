import { clear, createStore } from "idb-keyval";
import { vi } from "vitest";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import type { FileId, FractionalIndex } from "@excalidraw/element/types";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";

import { getSyncableElements } from "../data";
import {
  cacheFolders,
  cacheRoomFiles,
  cacheRooms,
  cacheRoomScene,
  clearRoomMemoryCache,
  deleteRoomDraft,
  flushRoomCache,
  forgetCachedRoom,
  getRoomCacheGeneration,
  getRoomChanges,
  invalidateCachedRoomScene,
  readCachedFolders,
  readCachedRoomFiles,
  readCachedRooms,
  readCachedRoomScene,
  readRoomDraft,
  saveRoomDraft,
} from "../data/roomCache";

const scene = (version = 1) =>
  getSyncableElements(
    restoreElements(
      [
        API.createElement({
          id: "drawing",
          type: "rectangle",
          x: 10,
          y: 20,
          width: 100,
          height: 100,
          index: "a0" as FractionalIndex,
        }),
      ],
      null,
    ),
  ).map((element) => ({ ...element, version, versionNonce: version }));

const fileData = (id = "image"): BinaryFileData => ({
  id: id as FileId,
  dataURL: "data:image/png;base64,test" as DataURL,
  mimeType: "image/png",
  created: 1,
});

beforeEach(async () => {
  await flushRoomCache();
  await clear(createStore("excalidraw-rooms-db", "cache"));
  clearRoomMemoryCache();
});

afterEach(() => vi.restoreAllMocks());

describe("persistent room cache", () => {
  it("does not resurrect deleted drafts when a closing session flushes its backup", async () => {
    await cacheRoomScene("deleted-room", "key", {
      etag: '"one"',
      elements: scene(),
    });
    await saveRoomDraft("deleted-room", "key", scene(2));
    const forgetting = forgetCachedRoom("deleted-room", "key");
    await saveRoomDraft("deleted-room", "key", scene(3));
    await forgetting;
    expect(await readRoomDraft("deleted-room", "key")).toBeNull();
    await saveRoomDraft("deleted-room", "key", scene(4));
    expect(await readRoomDraft("deleted-room", "key")).toBeNull();
    await cacheRoomScene("deleted-room", "key", {
      etag: '"new"',
      elements: scene(5),
    });
    await saveRoomDraft("deleted-room", "key", scene(6));
    expect((await readRoomDraft("deleted-room", "key"))?.[0].version).toBe(6);
  });
  it("scopes confirmed scenes and drafts to both room id and key", async () => {
    await cacheRoomScene("room", "key", { etag: '"one"', elements: scene() });
    await saveRoomDraft("room", "key", scene(2));
    expect(
      (await readCachedRoomScene("room", "key"))?.elements[0].version,
    ).toBe(1);
    expect((await readRoomDraft("room", "key"))?.[0].version).toBe(2);
    expect(await readCachedRoomScene("room", "wrong")).toBeNull();
    expect(await readRoomDraft("other", "key")).toBeNull();
    await invalidateCachedRoomScene("room", "key");
    expect(await readCachedRoomScene("room", "key")).toBeNull();
    expect(await readRoomDraft("room", "key")).not.toBeNull();
    await deleteRoomDraft("room", "key");
    expect(await readRoomDraft("room", "key")).toBeNull();
  });

  it("captures writes before later canvas mutation and returns independent reads", async () => {
    const elements = scene();
    const saving = cacheRoomScene("room", "key", { etag: '"one"', elements });
    Object.assign(elements[0], { x: 999 });
    await saving;
    const cached = await readCachedRoomScene("room", "key");
    expect(cached?.elements[0].x).toBe(10);
    Object.assign(cached!.elements[0], { x: 500 });
    expect((await readCachedRoomScene("room", "key"))?.elements[0].x).toBe(10);
  });

  it("bounds confirmed cache retention without evicting recovery drafts", async () => {
    await saveRoomDraft("oldest", "key", scene(2));
    for (let index = 0; index < 33; index++) {
      await cacheRoomScene(`room-${index}`, "key", {
        etag: '"one"',
        elements: scene(),
      });
    }
    expect(await readCachedRoomScene("room-0", "key")).toBeNull();
    expect(await readCachedRoomScene("room-32", "key")).not.toBeNull();
    expect(await readRoomDraft("oldest", "key")).not.toBeNull();
  });

  it("persists registry and folder metadata independently", async () => {
    const rooms = [
      {
        roomId: "room",
        key: "key",
        createdAt: 1,
        lastActiveAt: 2,
        hasScene: true,
      },
    ];
    const folders = [
      { id: "parent", name: "School" },
      { id: "child", name: "Math", parentId: "parent" },
    ];
    await cacheRooms(rooms);
    await cacheFolders(folders);
    expect(await readCachedRooms()).toEqual(rooms);
    expect(await readCachedFolders()).toEqual(folders);
    await cacheRooms([]);
    expect(await readCachedRooms()).toEqual([]);
    expect(await readCachedFolders()).toEqual(folders);
  });

  it("does not mistake unchanged cached elements for edits, including server-side removals", () => {
    const original = scene();
    expect(getRoomChanges(original, original)).toEqual([]);
    const edited = scene(2);
    expect(getRoomChanges(original, edited)).toEqual(edited);
    const deleted = scene();
    Object.assign(deleted[0], { isDeleted: true });
    expect(getRoomChanges(original, deleted)).toEqual(deleted);
    expect(getRoomChanges([], original)).toEqual(original);
  });

  it("keeps serving RAM when IndexedDB is unavailable and recovers on later writes", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transaction = vi
      .spyOn(IDBDatabase.prototype, "transaction")
      .mockImplementation(() => {
        throw new DOMException("Storage unavailable", "QuotaExceededError");
      });
    await expect(
      cacheRoomScene("room", "key", { etag: '"one"', elements: scene() }),
    ).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalled();
    expect((await readCachedRoomScene("room", "key"))?.etag).toBe('"one"');
    expect(await readCachedRoomScene("cold-room", "key")).toBeNull();
    transaction.mockRestore();
    await cacheRoomScene("room", "key", { etag: '"two"', elements: scene() });
    expect((await readCachedRoomScene("room", "key"))?.etag).toBe('"two"');
    await flushRoomCache();
    clearRoomMemoryCache();
    expect((await readCachedRoomScene("room", "key"))?.etag).toBe('"two"');
  });
});

describe("in-memory room cache", () => {
  it("reads scenes, drafts, and files through RAM after the first read or write", async () => {
    await cacheRoomScene("room", "key", { etag: '"one"', elements: scene() });
    await saveRoomDraft("room", "key", scene(2));
    await cacheRoomFiles("room", "key", [fileData()]);
    await flushRoomCache();
    clearRoomMemoryCache();
    expect((await readCachedRoomScene("room", "key"))?.etag).toBe('"one"');
    expect((await readRoomDraft("room", "key"))?.[0].version).toBe(2);
    expect(
      (await readCachedRoomFiles("room", "key", [fileData().id]))[0]?.dataURL,
    ).toBe("data:image/png;base64,test");
    await clear(createStore("excalidraw-rooms-db", "cache"));
    expect((await readCachedRoomScene("room", "key"))?.etag).toBe('"one"');
    expect((await readRoomDraft("room", "key"))?.[0].version).toBe(2);
    expect(
      (await readCachedRoomFiles("room", "key", [fileData().id]))[0]?.dataURL,
    ).toBe("data:image/png;base64,test");
  });

  it("hands out independent copies for scene, draft, and file reads", async () => {
    await cacheRoomScene("room", "key", { etag: '"one"', elements: scene() });
    await saveRoomDraft("room", "key", scene(2));
    await cacheRoomFiles("room", "key", [fileData()]);
    const cachedScene = await readCachedRoomScene("room", "key");
    const cachedDraft = await readRoomDraft("room", "key");
    const cachedFiles = await readCachedRoomFiles("room", "key", [
      fileData().id,
    ]);
    Object.assign(cachedScene!.elements[0], { x: 1234 });
    Object.assign(cachedDraft![0], { x: 4321 });
    cachedFiles[0].dataURL = "mutated" as DataURL;
    expect((await readCachedRoomScene("room", "key"))?.elements[0].x).toBe(10);
    expect((await readRoomDraft("room", "key"))?.[0].x).toBe(10);
    expect(
      (await readCachedRoomFiles("room", "key", [fileData().id]))[0]?.dataURL,
    ).toBe("data:image/png;base64,test");
  });

  it("invalidates RAM immediately and never lets a stale async read repopulate it", async () => {
    await cacheRoomScene("room", "key", { etag: '"one"', elements: scene() });
    await saveRoomDraft("room", "key", scene(2));
    await flushRoomCache();
    clearRoomMemoryCache();
    const staleScene = readCachedRoomScene("room", "key");
    const staleDraft = readRoomDraft("room", "key");
    invalidateCachedRoomScene("room", "key");
    deleteRoomDraft("room", "key");
    expect(await staleScene).toBeNull();
    expect(await staleDraft).toBeNull();
    expect(await readCachedRoomScene("room", "key")).toBeNull();
    expect(await readRoomDraft("room", "key")).toBeNull();
  });

  it("answers an in-flight read with the freshest RAM copy after a write", async () => {
    await cacheRoomScene("room", "key", { etag: '"one"', elements: scene() });
    await flushRoomCache();
    clearRoomMemoryCache();
    const stale = readCachedRoomScene("room", "key");
    cacheRoomScene("room", "key", { etag: '"two"', elements: scene(2) });
    expect((await stale)?.etag).toBe('"two"');
    expect((await readCachedRoomScene("room", "key"))?.etag).toBe('"two"');
  });

  it("bounds RAM to the eight most recently used rooms", async () => {
    for (let index = 0; index < 9; index++) {
      await cacheRoomScene(`room-${index}`, "key", {
        etag: '"one"',
        elements: scene(),
      });
    }
    await flushRoomCache();
    await clear(createStore("excalidraw-rooms-db", "cache"));
    expect((await readCachedRoomScene("room-8", "key"))?.etag).toBe('"one"');
    expect(await readCachedRoomScene("room-0", "key")).toBeNull();
  });

  it("clears RAM without touching persisted entries", async () => {
    await cacheRoomScene("room", "key", { etag: '"one"', elements: scene() });
    await saveRoomDraft("room", "key", scene(2));
    await cacheRoomFiles("room", "key", [fileData()]);
    await flushRoomCache();
    const generation = getRoomCacheGeneration("room", "key");
    clearRoomMemoryCache();
    expect(getRoomCacheGeneration("room", "key")).not.toBe(generation);
    expect((await readCachedRoomScene("room", "key"))?.etag).toBe('"one"');
    expect((await readRoomDraft("room", "key"))?.[0].version).toBe(2);
    expect(
      (await readCachedRoomFiles("room", "key", [fileData().id]))[0]?.id,
    ).toBe(fileData().id);
  });
});

describe("room cache generations", () => {
  it("invalidates a resident scene when persistent retention expires it", async () => {
    await cacheRoomScene("expires", "key", {
      etag: '"one"',
      elements: scene(),
    });
    const generation = getRoomCacheGeneration("expires", "key");
    for (let index = 0; index < 32; index++) {
      await readCachedRoomScene("expires", "key");
      await cacheRoomScene(`expiry-${index}`, "key", {
        etag: '"one"',
        elements: scene(),
      });
    }
    expect(getRoomCacheGeneration("expires", "key")).not.toBe(generation);
    expect(await readCachedRoomScene("expires", "key")).toBeNull();
  });

  it("advances on scene and draft content changes but not on file-only writes", async () => {
    expect(getRoomCacheGeneration("gen-room", "key")).toBe(0);
    await cacheRoomScene("gen-room", "key", {
      etag: '"one"',
      elements: scene(),
    });
    const afterScene = getRoomCacheGeneration("gen-room", "key");
    expect(afterScene).toBeGreaterThan(0);
    await saveRoomDraft("gen-room", "key", scene(2));
    const afterDraft = getRoomCacheGeneration("gen-room", "key");
    expect(afterDraft).not.toBe(afterScene);
    await cacheRoomFiles("gen-room", "key", [fileData()]);
    expect(getRoomCacheGeneration("gen-room", "key")).toBe(afterDraft);
    await deleteRoomDraft("gen-room", "key");
    const afterDelete = getRoomCacheGeneration("gen-room", "key");
    expect(afterDelete).not.toBe(afterDraft);
    await invalidateCachedRoomScene("gen-room", "key");
    const afterInvalidate = getRoomCacheGeneration("gen-room", "key");
    expect(afterInvalidate).not.toBe(afterDelete);
    await forgetCachedRoom("gen-room", "key");
    expect(getRoomCacheGeneration("gen-room", "key")).not.toBe(afterInvalidate);
  });

  it("never reuses an earlier generation across eviction or repeated clears", async () => {
    await cacheRoomScene("mono-room", "key", {
      etag: '"one"',
      elements: scene(),
    });
    const original = getRoomCacheGeneration("mono-room", "key");
    expect(original).toBeGreaterThan(0);
    for (let index = 0; index < 9; index++) {
      await cacheRoomScene(`mono-room-${index}`, "key", {
        etag: '"x"',
        elements: scene(),
      });
    }
    expect(getRoomCacheGeneration("mono-room", "key")).toBe(original);
    clearRoomMemoryCache();
    const cleared = getRoomCacheGeneration("mono-room", "key");
    expect(cleared).not.toBe(original);
    expect(cleared).toBeGreaterThan(0);
    clearRoomMemoryCache();
    const clearedTwice = getRoomCacheGeneration("mono-room", "key");
    expect(clearedTwice).not.toBe(cleared);
    expect(clearedTwice).toBeGreaterThan(0);
    expect([original, cleared]).not.toContain(clearedTwice);
  });
});
