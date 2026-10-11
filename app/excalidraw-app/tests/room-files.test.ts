import { clear, createStore } from "idb-keyval";
import { resolvablePromise } from "@excalidraw/common";
import { vi } from "vitest";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import { generateEncryptionKey } from "@excalidraw/excalidraw/data/encryption";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";

import { encodeFilesForUpload, FileManager } from "../data/FileManager";
import {
  cacheRoomFiles,
  cacheRoomScene,
  clearRoomMemoryCache,
  flushRoomCache,
  forgetCachedRoom,
  readCachedRoomFiles,
} from "../data/roomCache";
import {
  downloadRoomFiles,
  loadRoomFiles,
  uploadRoomFiles,
} from "../data/roomFiles";

const file = (id = "image"): BinaryFileData => ({
  id: id as FileId,
  dataURL: "data:image/png;base64,test" as DataURL,
  mimeType: "image/png",
  created: 1,
});

beforeEach(async () => {
  await flushRoomCache();
  clearRoomMemoryCache();
  await clear(createStore("excalidraw-rooms-db", "cache"));
  await cacheRoomScene("room", "key", { etag: '"one"', elements: [] });
});

afterEach(() => vi.restoreAllMocks());

describe("room attachment cache", () => {
  it("avoids rewriting unchanged image objects on every draft backup, but persists mutations", async () => {
    const image = file();
    await cacheRoomFiles("room", "key", [image]);
    const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
    await cacheRoomFiles("room", "key", [image]);
    expect(transaction).not.toHaveBeenCalled();
    image.dataURL = "data:image/png;base64,updated" as DataURL;
    await cacheRoomFiles("room", "key", [image]);
    expect(transaction).toHaveBeenCalled();
    expect(await readCachedRoomFiles("room", "key", [image.id])).toEqual([
      image,
    ]);
    await forgetCachedRoom("room", "key");
    await cacheRoomScene("room", "key", { etag: '"new"', elements: [] });
    await cacheRoomFiles("room", "key", [image]);
    expect(await readCachedRoomFiles("room", "key", [image.id])).toEqual([
      image,
    ]);
  });
  it("does not use a pending local image as proof of a remote upload", async () => {
    await cacheRoomFiles("room", "key", [file()]);
    const download = vi.fn().mockResolvedValue({
      loadedFiles: [],
      erroredFiles: new Map([[file().id, true]]),
    });
    const result = await loadRoomFiles({
      roomId: "room",
      roomKey: "key",
      fileIds: [file().id],
      skipCache: [file().id],
      download,
    });
    expect(download).toHaveBeenCalledWith([file().id]);
    expect(result.loadedFiles).toEqual([]);
    expect(await readCachedRoomFiles("room", "key", [file().id])).toEqual([
      file(),
    ]);
  });
  it("reuses persisted files without a network request in a fresh loader", async () => {
    const download = vi.fn().mockResolvedValue({
      loadedFiles: [file()],
      erroredFiles: new Map(),
    });
    const options = {
      roomId: "room",
      roomKey: "key",
      fileIds: [file().id],
      download,
    };
    await loadRoomFiles(options);
    await flushRoomCache();
    download.mockClear();
    expect((await loadRoomFiles({ ...options })).loadedFiles).toEqual([file()]);
    expect(download).not.toHaveBeenCalled();
  });

  it("isolates images by room and encryption key, and snapshots writes", async () => {
    const original = file();
    const writing = cacheRoomFiles("room", "key", [original]);
    original.dataURL = "changed" as DataURL;
    await writing;
    expect(await readCachedRoomFiles("room", "key", [original.id])).toEqual([
      file(),
    ]);
    expect(
      await readCachedRoomFiles("room", "other-key", [original.id]),
    ).toEqual([]);
    expect(
      await readCachedRoomFiles("other-room", "key", [original.id]),
    ).toEqual([]);
  });

  it("paints cached images before slow downloads and requests only unique missing IDs", async () => {
    await cacheRoomFiles("room", "key", [file()]);
    const response = resolvablePromise<{
      loadedFiles: BinaryFileData[];
      erroredFiles: Map<FileId, true>;
    }>();
    const download = vi.fn(() => response);
    const onCachedFiles = vi.fn();
    const loading = loadRoomFiles({
      roomId: "room",
      roomKey: "key",
      fileIds: [file().id, file("missing").id, file("missing").id],
      download,
      onCachedFiles,
    });
    await vi.waitFor(() =>
      expect(download).toHaveBeenCalledWith([file("missing").id]),
    );
    expect(onCachedFiles).toHaveBeenCalledWith([file()]);
    response.resolve({
      loadedFiles: [file("missing")],
      erroredFiles: new Map(),
    });
    expect((await loading).loadedFiles).toEqual([file(), file("missing")]);
  });

  it("keeps cached successes when the missing-file download fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await cacheRoomFiles("room", "key", [file()]);
    const result = await loadRoomFiles({
      roomId: "room",
      roomKey: "key",
      fileIds: [file().id, file("missing").id],
      download: async () => {
        throw new Error("offline");
      },
    });
    expect(result.loadedFiles).toEqual([file()]);
    expect(result.erroredFiles).toEqual(new Map([[file("missing").id, true]]));
  });

  it("deletes only the selected room's images and rejects late writes", async () => {
    await cacheRoomFiles("room", "key", [file()]);
    await cacheRoomFiles("room", "other-key", [file()]);
    const deleting = forgetCachedRoom("room", "key");
    await cacheRoomFiles("room", "key", [file("late")]);
    await deleting;
    expect(
      await readCachedRoomFiles("room", "key", [file().id, file("late").id]),
    ).toEqual([]);
    expect(await readCachedRoomFiles("room", "other-key", [file().id])).toEqual(
      [file()],
    );
    await cacheRoomScene("room", "key", { etag: '"new"', elements: [] });
    await cacheRoomFiles("room", "key", [file()]);
    expect(await readCachedRoomFiles("room", "key", [file().id])).toEqual([
      file(),
    ]);
  });

  it("falls back to downloads if IndexedDB fails without failing the load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    });
    const download = vi
      .fn()
      .mockResolvedValue({ loadedFiles: [file()], erroredFiles: new Map() });
    const result = await loadRoomFiles({
      roomId: "room",
      roomKey: "key",
      fileIds: [file().id],
      download,
    });
    await flushRoomCache();
    expect(result.loadedFiles).toEqual([file()]);
    expect(download).toHaveBeenCalledWith([file().id]);
  });

  it("retains locally cached images after an unsuccessful upload without marking them remotely saved", async () => {
    const manager = new FileManager({
      getFiles: vi.fn(),
      saveFiles: async ({ addedFiles }) => {
        await cacheRoomFiles("room", "key", [...addedFiles.values()]);
        throw new Error("offline");
      },
    });
    await expect(
      manager.saveFiles({
        elements: [API.createElement({ type: "image", fileId: file().id })],
        files: { [file().id]: file() },
      }),
    ).rejects.toThrow("offline");
    expect(await readCachedRoomFiles("room", "key", [file().id])).toEqual([
      file(),
    ]);
    expect(manager.isFileSavedOrBeingSaved(file())).toBe(false);
  });
});

describe("room-switch attachment races", () => {
  it("ignores a stale download after reset without clearing the new room's in-flight request", async () => {
    const oldResponse = resolvablePromise<{
      loadedFiles: BinaryFileData[];
      erroredFiles: Map<FileId, true>;
    }>();
    const newResponse = resolvablePromise<{
      loadedFiles: BinaryFileData[];
      erroredFiles: Map<FileId, true>;
    }>();
    const statuses = vi.fn();
    const manager = new FileManager({
      getFiles: vi
        .fn()
        .mockReturnValueOnce(oldResponse)
        .mockReturnValueOnce(newResponse),
      saveFiles: vi.fn(),
      onFileStatusChange: statuses,
    });
    const oldLoading = manager.getFiles([file().id]);
    manager.reset();
    const newLoading = manager.getFiles([file().id]);
    statuses.mockClear();
    oldResponse.resolve({ loadedFiles: [file()], erroredFiles: new Map() });
    expect((await oldLoading).loadedFiles).toEqual([]);
    expect(statuses).not.toHaveBeenCalled();
    expect(manager.isFileTracked(file().id)).toBe(true);
    newResponse.resolve({ loadedFiles: [file()], erroredFiles: new Map() });
    expect((await newLoading).loadedFiles).toEqual([file()]);
    expect(statuses).toHaveBeenCalledWith([[file().id, "loaded"]]);
  });

  it("ignores an upload completed after switching rooms", async () => {
    const response = resolvablePromise<{
      savedFiles: Map<FileId, BinaryFileData>;
      erroredFiles: Map<FileId, BinaryFileData>;
    }>();
    const manager = new FileManager({
      getFiles: vi.fn(),
      saveFiles: () => response,
    });
    const saving = manager.saveFiles({
      elements: [API.createElement({ type: "image", fileId: file().id })],
      files: { [file().id]: file() },
    });
    manager.reset();
    response.resolve({
      savedFiles: new Map([[file().id, file()]]),
      erroredFiles: new Map(),
    });
    expect((await saving).savedFiles.size).toBe(0);
    expect(manager.isFileSavedOrBeingSaved(file())).toBe(false);
  });
});

describe("room file transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uploads encrypted blobs to the room API and decodes them on download", async () => {
    const roomKey = await generateEncryptionKey();
    const image = file("image-a");
    const stored = new Map<string, ArrayBuffer>();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        stored.set(url, await new Response(init.body).arrayBuffer());
        return new Response(JSON.stringify({ ok: true }));
      }
      const body = stored.get(url);
      return body ? new Response(body) : new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const uploaded = await uploadRoomFiles({
      roomId: "room/a",
      roomKey,
      files: await encodeFilesForUpload({
        files: new Map([[image.id, image]]),
        encryptionKey: roomKey,
        maxBytes: 1024 * 1024,
      }),
    });
    expect(uploaded).toEqual({ savedFiles: [image.id], erroredFiles: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `/api/rooms/room%2Fa/files/image-a?key=${encodeURIComponent(roomKey)}`,
    );
    expect(new TextDecoder().decode(stored.get(url))).not.toContain(
      image.dataURL,
    );
    expect(init?.headers).toEqual({
      "content-type": "application/octet-stream",
    });

    const downloaded = await downloadRoomFiles("room/a", roomKey, [
      image.id,
      "missing" as FileId,
    ]);
    expect(downloaded.loadedFiles).toEqual([
      expect.objectContaining({
        id: image.id,
        dataURL: image.dataURL,
        mimeType: image.mimeType,
      }),
    ]);
    expect([...downloaded.erroredFiles.keys()]).toEqual(["missing"]);
  });

  it("reports rejected and failed uploads as errored", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockRejectedValueOnce(new TypeError("offline")),
    );
    const buffer = new Uint8Array([1]);
    const result = await uploadRoomFiles({
      roomId: "room",
      roomKey: "key",
      files: [
        { id: "a" as FileId, buffer },
        { id: "b" as FileId, buffer },
      ],
    });
    expect(result.savedFiles).toEqual([]);
    expect(result.erroredFiles.sort()).toEqual(["a", "b"]);
  });
});
