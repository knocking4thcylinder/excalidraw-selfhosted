import { clear, createStore } from "idb-keyval";
import { vi } from "vitest";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import type { FractionalIndex } from "@excalidraw/element/types";

import { getSyncableElements } from "../data";
import {
  cacheRoomScene,
  clearRoomMemoryCache,
  flushRoomCache,
  readCachedRoomScene,
} from "../data/roomCache";
import {
  clearRoomSceneCache,
  deleteRoom,
  isSavedToServer,
  loadRoomFromServer,
  saveRoomToServer,
} from "../data/rooms";
import { applyScenePatch, createScenePatch } from "../data/scenePatch";

import type { SyncableExcalidrawElement } from "../data";

vi.mock("@excalidraw/excalidraw/data/encryption", () => ({
  encryptData: async (_key: string, bytes: Uint8Array) => ({
    encryptedBuffer: new Uint8Array(bytes).buffer,
    iv: new Uint8Array(12),
  }),
  decryptData: async (_iv: Uint8Array, bytes: ArrayBuffer) => bytes,
}));

const scene = () =>
  getSyncableElements(
    restoreElements(
      Array.from({ length: 40 }, (_, index) =>
        API.createElement({
          type: "rectangle",
          id: `shape-${index}`,
          index: `a0V${String(index).padStart(3, "0")}V` as FractionalIndex,
          x: index * 100,
        }),
      ),
      null,
    ),
  );
const changedScene = (
  elements: readonly SyncableExcalidrawElement[],
  version = 2,
) =>
  elements.map((element, index) =>
    index === 0
      ? { ...element, x: 500, version, versionNonce: version }
      : element,
  );
const encoded = (value: unknown) => ({
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: window.btoa(JSON.stringify(value)),
});
const response = (value: unknown, etag: string, patchCount = 0) =>
  new Response(JSON.stringify(value), {
    headers: {
      etag,
      "x-scene-sync": "1",
      "x-scene-patches": String(patchCount),
    },
  });
const portal = () => ({
  roomId: "room",
  roomKey: "key",
  socket: {} as NonNullable<Parameters<typeof saveRoomToServer>[0]["socket"]>,
});
const seed = async (elements = scene(), patchCount = 0) => {
  await cacheRoomScene("room", "key", {
    etag: '"base"',
    elements,
    syncVersion: 1,
    patchCount,
  });
  return elements;
};

beforeEach(async () => {
  await flushRoomCache();
  await clear(createStore("excalidraw-rooms-db", "cache"));
  clearRoomSceneCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("encrypted scene patches", () => {
  it("round-trips edits, additions, removals, tombstones, and ordering", () => {
    const initial = scene();
    const current = [
      { ...initial[2], isDeleted: true, version: 2 },
      { ...initial[0], x: 999, version: 2 },
      { ...initial[1], id: "added" },
    ];
    const patch = createScenePatch(initial, current);
    expect(applyScenePatch(initial, patch)).toEqual(current);
    expect(initial[0].x).toBe(0);
  });

  it("omits unchanged shapes and redundant ordering", () => {
    const initial = scene();
    const patch = createScenePatch(initial, changedScene(initial));
    expect(patch.upserts).toHaveLength(1);
    expect(patch.order).toBeUndefined();
    expect(patch.removedIds).toEqual([]);
    expect(JSON.stringify(patch).length).toBeLessThan(
      JSON.stringify(initial).length / 10,
    );
  });

  it("includes ordering for reorders, additions, and removals", () => {
    const initial = scene();
    for (const current of [
      [...initial].reverse(),
      [...initial, { ...initial[0], id: "added" }],
      initial.slice(1),
      [],
    ]) {
      const patch = createScenePatch(initial, current);
      expect(patch.order).toEqual(current.map((element) => element.id));
      expect(applyScenePatch(initial, patch)).toEqual(current);
    }
  });

  it("omits ordering for an unchanged empty scene", () => {
    expect(createScenePatch([], [])).toEqual({
      format: 1,
      upserts: [],
      removedIds: [],
    });
  });

  it("rejects malformed patches and inconsistent orders instead of dropping data", () => {
    const initial = scene();
    for (const invalid of [
      null,
      {},
      { format: 1, upserts: [null], removedIds: [] },
      { format: 1, upserts: [], removedIds: [123] },
      { format: 1, upserts: [initial[0], initial[0]], removedIds: [] },
      { format: 1, upserts: [], removedIds: [], order: ["missing"] },
      { format: 1, upserts: [initial[0]], removedIds: [initial[0].id] },
    ]) {
      expect(() => applyScenePatch(initial, invalid)).toThrow(
        "Invalid encrypted scene",
      );
    }
  });
});

describe("partial room synchronization", () => {
  it("does not confuse equal version sums with identical acknowledged scenes", async () => {
    const initial = await seed();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true }, '"first"', 1))
      .mockResolvedValueOnce(response({ ok: true }, '"second"', 2));
    vi.stubGlobal("fetch", fetchMock);
    const session = portal();
    const first = changedScene(initial, 2);
    await saveRoomToServer(session, first);
    const second = first.map((element, index) =>
      index === 0 ? { ...element, versionNonce: 99, x: 800 } : element,
    );
    expect(isSavedToServer(session, second)).toBe(false);
    await saveRoomToServer(session, second);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).baseEtag).toBe(
      '"first"',
    );
  });

  it("does not silently adopt another session's baseline before saving old local work", async () => {
    const initial = await seed();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true }, '"old-session"', 1))
      .mockResolvedValueOnce(
        response(
          {
            ...encoded(initial),
            checkpointEtag: '"other-session"',
            syncVersion: 1,
            patches: [],
          },
          '"other-session"',
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 412 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = portal();
    await saveRoomToServer(session, changedScene(initial, 2));
    await loadRoomFromServer("room", "key", null, { throwOnError: true });
    await saveRoomToServer(session, changedScene(initial, 3));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).baseEtag).toBe(
      '"old-session"',
    );
  });

  it("rejects an uncheckpointable scene before extending the patch chain", async () => {
    const initial = await seed();
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const large = initial.map((element, index) =>
      index === 0
        ? { ...element, version: 2, link: "a".repeat(4 * 1024 * 1024) }
        : element,
    );
    await saveRoomToServer(portal(), large);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    expect((await readCachedRoomScene("room", "key"))?.etag).toBe('"base"');
  });

  it("returns to legacy saves after a 304 stops advertising patch support", async () => {
    const initial = await seed();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { etag: '"base"' } }),
      )
      .mockResolvedValueOnce(
        new Response('{"ok":true}', { headers: { etag: '"full"' } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await loadRoomFromServer("room", "key", null);
    await saveRoomToServer(portal(), changedScene(initial));
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
    expect(
      JSON.parse(fetchMock.mock.calls[1][1].body).syncVersion,
    ).toBeUndefined();
  });

  it("uses a conditional initial checkpoint when an empty Elixir room advertises sync", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 404, headers: { "x-scene-sync": "1" } }),
      )
      .mockResolvedValueOnce(response({ ok: true }, '"created"'));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadRoomFromServer("room", "key", null)).toBeNull();
    await saveRoomToServer(portal(), scene());
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      syncVersion: 1,
      baseEtag: null,
    });
  });

  it("drops previously queued snapshots when a conflict requires a fresh merge", async () => {
    const initial = await seed();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 412 }))
      .mockResolvedValueOnce(
        response(
          {
            ...encoded(initial),
            checkpointEtag: '"remote"',
            syncVersion: 1,
            patches: [],
          },
          '"remote"',
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const session = portal();
    const onConflict = vi.fn();
    const first = saveRoomToServer(session, changedScene(initial, 2), {
      onConflict,
    });
    const queued = saveRoomToServer(session, changedScene(initial, 3), {
      onConflict,
    });
    await Promise.all([first, queued]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onConflict).toHaveBeenCalledTimes(1);
  });

  it("does not use keepalive for a checkpoint beyond the browser upload budget", async () => {
    const large = scene().map((element) => ({
      ...element,
      link: "a".repeat(2000),
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    await saveRoomToServer(portal(), large);
    expect(fetchMock.mock.calls[0][1].body.length).toBeGreaterThan(64 * 1024);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(false);
  });

  it("loads a checkpoint plus encrypted patches on a cold browser", async () => {
    const initial = scene();
    const current = changedScene(initial);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            ...encoded(initial),
            syncVersion: 1,
            checkpointEtag: '"base"',
            patches: [
              {
                ...encoded(createScenePatch(initial, current)),
                baseEtag: '"base"',
                etag: '"next"',
              },
            ],
          },
          '"next"',
          1,
        ),
      ),
    );
    const loaded = await loadRoomFromServer("room", "key", null, {
      throwOnError: true,
    });
    expect(loaded?.[0].x).toBe(500);
    expect(loaded).toHaveLength(initial.length);
    expect(await readCachedRoomScene("room", "key")).toMatchObject({
      etag: '"next"',
      syncVersion: 1,
      patchCount: 1,
    });
  });

  it("downloads only the patch tail against a persistent cache after restart", async () => {
    const initial = await seed();
    const current = changedScene(initial);
    const fetchMock = vi.fn().mockResolvedValue(
      response(
        {
          syncVersion: 1,
          baseEtag: '"base"',
          patches: [
            {
              ...encoded(createScenePatch(initial, current)),
              baseEtag: '"base"',
              etag: '"next"',
            },
          ],
        },
        '"next"',
        1,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const loaded = await loadRoomFromServer("room", "key", null, {
      throwOnError: true,
    });
    expect(fetchMock.mock.calls[0][0]).toContain("since=%22base%22");
    expect(loaded?.[0].x).toBe(500);
  });

  it("retains acknowledged scene validators after room memory eviction", async () => {
    const initial = await seed();
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 304,
          headers: { "x-scene-sync": "1", "x-scene-patches": "0" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadRoomFromServer("room", "key", null)).toEqual(initial);
    for (let index = 0; index < 9; index++) {
      await cacheRoomScene(`other-${index}`, "key", {
        etag: `"other-${index}"`,
        elements: [],
      });
    }
    expect(await loadRoomFromServer("room", "key", null)).toEqual(initial);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      "If-None-Match": '"base"',
    });
  });

  it("keeps the good cache if the patch chain is incomplete", async () => {
    await seed();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response(
            { syncVersion: 1, baseEtag: '"wrong"', patches: [] },
            '"next"',
          ),
        ),
    );
    await expect(
      loadRoomFromServer("room", "key", null, { throwOnError: true }),
    ).rejects.toThrow("baseline");
    expect((await readCachedRoomScene("room", "key"))?.etag).toBe('"base"');
  });

  it.each(["RAM", "IndexedDB"])(
    "uploads a small patch from %s and persists its acknowledged baseline",
    async (baselineStore) => {
      const initial = await seed();
      if (baselineStore === "IndexedDB") {
        clearRoomMemoryCache();
      }
      const current = changedScene(initial);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(response({ ok: true }, '"next"', 1));
      vi.stubGlobal("fetch", fetchMock);
      const session = portal();
      await saveRoomToServer(session, current);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(payload.baseEtag).toBe('"base"');
      expect(JSON.parse(window.atob(payload.ciphertext)).upserts).toHaveLength(
        1,
      );
      expect(isSavedToServer(session, current)).toBe(true);
      expect(await readCachedRoomScene("room", "key")).toMatchObject({
        etag: '"next"',
        elements: JSON.parse(JSON.stringify(current)),
      });
    },
  );

  it("falls back to full snapshots when the backend does not advertise sync", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    await saveRoomToServer(portal(), scene());
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(
      JSON.parse(fetchMock.mock.calls[0][1].body).syncVersion,
    ).toBeUndefined();
  });

  it("checkpoints when the chain limit is reached", async () => {
    const initial = await seed(scene(), 32);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ ok: true }, '"checkpoint"'));
    vi.stubGlobal("fetch", fetchMock);
    await saveRoomToServer(portal(), changedScene(initial));
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).baseEtag).toBe('"base"');
  });

  it("retries an oversized patch as a revision-checked checkpoint", async () => {
    const initial = await seed();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 413 }))
      .mockResolvedValueOnce(response({ ok: true }, '"checkpoint"'));
    vi.stubGlobal("fetch", fetchMock);
    await saveRoomToServer(portal(), changedScene(initial));
    expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual([
      "PATCH",
      "POST",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).baseEtag).toBe('"base"');
  });

  it("does not overwrite a concurrent save; fetches the latest scene for reconciliation", async () => {
    const initial = await seed();
    const remote = changedScene(initial, 5);
    const onConflict = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 412 }))
      .mockResolvedValueOnce(
        response(
          {
            ...encoded(remote),
            checkpointEtag: '"remote"',
            syncVersion: 1,
            patches: [],
          },
          '"remote"',
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const session = portal();
    await saveRoomToServer(session, changedScene(initial), { onConflict });
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict.mock.calls[0][0][0].version).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(isSavedToServer(session, changedScene(initial))).toBe(false);
  });

  it("serializes rapid saves so each patch references the acknowledged predecessor", async () => {
    const initial = await seed();
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(response({ ok: true }, '"third"', 2));
    vi.stubGlobal("fetch", fetchMock);
    const session = portal();
    const first = saveRoomToServer(session, changedScene(initial, 2));
    const second = saveRoomToServer(session, changedScene(initial, 3));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFirst(response({ ok: true }, '"second"', 1));
    await Promise.all([first, second]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).baseEtag).toBe(
      '"second"',
    );
  });

  it("does not let acknowledged or queued saves recreate a deleted cache", async () => {
    const initial = await seed();
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    const session = portal();
    const first = saveRoomToServer(session, changedScene(initial, 2));
    const second = saveRoomToServer(session, changedScene(initial, 3));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await deleteRoom("room", "key")).toBe(true);
    resolveFirst(response({ ok: true }, '"second"', 1));
    await Promise.all([first, second]);
    expect(await readCachedRoomScene("room", "key")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
