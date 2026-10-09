import { vi } from "vitest";
import { clear, createStore } from "idb-keyval";

import { decryptData } from "@excalidraw/excalidraw/data/encryption";

import {
  flushRoomCache,
  readCachedRoomScene,
  readRoomDraft,
  saveRoomDraft,
} from "../data/roomCache";

import {
  fetchRoomFolders,
  fetchRooms,
  loadRoomFromServer,
  clearRoomSceneCache,
  saveRoomToServer,
  deleteRoom,
} from "../data/rooms";

vi.mock("@excalidraw/excalidraw/data/encryption", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@excalidraw/excalidraw/data/encryption")
  >()),
  decryptData: vi.fn(),
}));

beforeEach(async () => {
  await flushRoomCache();
  await clear(createStore("excalidraw-rooms-db", "cache"));
  clearRoomSceneCache();
  vi.clearAllMocks();
  vi.mocked(decryptData).mockResolvedValue(
    new TextEncoder().encode(
      JSON.stringify([
        {
          id: "saved-drawing",
          type: "rectangle",
          x: 10,
          y: 20,
          width: 100,
          height: 100,
          version: 1,
        },
      ]),
    ).buffer,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRoomSceneCache();
});

describe("room snapshot requests", () => {
  it("checks a stored drawing with HEAD rather than downloading it on an empty save", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", fetchMock);
    const socket = {} as NonNullable<
      Parameters<typeof saveRoomToServer>[0]["socket"]
    >;
    await saveRoomToServer({ roomId: "room-a", roomKey: "key-a", socket }, []);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("HEAD");
  });

  it("reports progress while reading each snapshot chunk", async () => {
    const onProgress = vi.fn();
    const body = JSON.stringify({
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==",
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body.slice(0, 20)));
        controller.enqueue(new TextEncoder().encode(body.slice(20)));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { headers: { etag: '"streamed"' } }),
        ),
    );
    const scene = await loadRoomFromServer("room-a", "key-a", null, {
      throwOnError: true,
      onProgress,
    });
    expect(scene?.[0].id).toBe("saved-drawing");
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  const snapshotResponse = (etag: string) =>
    new Response(
      JSON.stringify({
        iv: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==",
      }),
      { headers: { etag } },
    );

  it("validates cached drawings without downloading or decrypting unchanged snapshots again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(snapshotResponse('"original"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(snapshotResponse('"updated"'));
    vi.stubGlobal("fetch", fetchMock);
    const first = await loadRoomFromServer("room-a", "key-a", null, {
      throwOnError: true,
    });
    expect(first?.[0].x).toBe(10);
    if (first) {
      Object.assign(first[0], { x: 999 });
    }
    const second = await loadRoomFromServer("room-a", "key-a", null, {
      throwOnError: true,
    });
    expect(second?.[0].x).toBe(10);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      "If-None-Match": '"original"',
    });
    expect(decryptData).toHaveBeenCalledTimes(1);
    await loadRoomFromServer("room-a", "key-a", null, { throwOnError: true });
    expect(decryptData).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a drawing cached under a different room key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(snapshotResponse('"original"'))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await loadRoomFromServer("room-a", "key-a", null);
    await expect(
      loadRoomFromServer("room-a", "key-b", null, { throwOnError: true }),
    ).rejects.toThrow("403");
    expect(fetchMock.mock.calls[1][1].headers).toBeUndefined();
  });

  it("restores persisted validators after the memory cache is lost", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(snapshotResponse('"persisted"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);
    await loadRoomFromServer("room-a", "key-a", null);
    clearRoomSceneCache();
    const restored = await loadRoomFromServer("room-a", "key-a", null);
    expect(restored?.[0].id).toBe("saved-drawing");
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      "If-None-Match": '"persisted"',
    });
    expect(decryptData).toHaveBeenCalledTimes(1);
  });

  it("removes a persisted snapshot when the server denies its key", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(snapshotResponse('"persisted"'))
        .mockResolvedValueOnce(new Response(null, { status: 403 })),
    );
    await loadRoomFromServer("room-a", "key-a", null);
    await expect(
      loadRoomFromServer("room-a", "key-a", null, { throwOnError: true }),
    ).rejects.toThrow("403");
    expect(await readCachedRoomScene("room-a", "key-a")).toBeNull();
  });

  it("does not let an in-flight response recreate a deleted room cache", async () => {
    let resolveDownload!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(snapshotResponse('"original"'))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveDownload = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    const elements = await loadRoomFromServer("room-a", "key-a", null);
    await saveRoomDraft("room-a", "key-a", elements!);
    const downloading = loadRoomFromServer("room-a", "key-a", null);
    await vi.waitFor(() => expect(typeof resolveDownload).toBe("function"));
    expect(await deleteRoom("room-a", "key-a")).toBe(true);
    resolveDownload(snapshotResponse('"late"'));
    expect(await downloading).toBeNull();
    expect(await readCachedRoomScene("room-a", "key-a")).toBeNull();
    expect(await readRoomDraft("room-a", "key-a")).toBeNull();
  });

  it("treats a missing snapshot as an empty/new room", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    expect(
      await loadRoomFromServer("room-a", "key-a", null, { throwOnError: true }),
    ).toBeNull();
  });

  it("does not treat server failures as an empty room", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    await expect(
      loadRoomFromServer("room-a", "key-a", null, { throwOnError: true }),
    ).rejects.toThrow("503");
  });

  it("does not treat a malformed snapshot as an empty room", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await expect(
      loadRoomFromServer("room-a", "key-a", null, { throwOnError: true }),
    ).rejects.toThrow("Invalid room snapshot");
  });

  it("propagates interrupted downloads instead of reporting an empty room", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Download interrupted")),
    );
    await expect(
      loadRoomFromServer("room-a", "key-a", null, { throwOnError: true }),
    ).rejects.toThrow("Download interrupted");
  });

  it("supports aborting list, folder, and snapshot requests", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response('{"rooms":[],"folders":[]}'),
      );
    vi.stubGlobal("fetch", fetchMock);
    await fetchRooms(controller.signal);
    await fetchRoomFolders(controller.signal);
    await loadRoomFromServer("room-a", "key-a", null, {
      signal: controller.signal,
    });
    for (const [, options] of fetchMock.mock.calls) {
      expect(options.signal).toBe(controller.signal);
    }
  });
});
