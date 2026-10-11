import { vi } from "vitest";
import { clear, createStore } from "idb-keyval";

import {
  CaptureUpdateAction,
  newElementWith,
  restoreElements,
} from "@excalidraw/excalidraw";
import { syncInvalidIndices } from "@excalidraw/element";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  act,
  cleanup,
  render,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";

import type {
  AppState,
  BinaryFileData,
  DataURL,
} from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import {
  cacheRoomScene,
  cacheRoomFiles,
  flushRoomCache,
  getRoomCacheGeneration,
  saveRoomDraft,
} from "../data/roomCache";
import ExcalidrawApp from "../App";
import { clearRoomSceneCache, deleteRoom } from "../data/rooms";
import { getSyncableElements } from "../data";
import { LocalData } from "../data/LocalData";
import { appJotaiStore } from "../app-jotai";
import {
  activeRoomLinkAtom,
  isCollaboratingAtom,
  offlineRoomPendingAtom,
} from "../collab/Collab";

import type { SyncableExcalidrawElement } from "../data";

Object.defineProperty(window, "crypto", {
  value: {
    getRandomValues: (bytes: Uint8Array) => bytes.fill(1),
    subtle: {
      importKey: async () => ({}),
      encrypt: async () => new ArrayBuffer(0),
    },
  },
});

vi.mock("../app_constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app_constants")>()),
  INITIAL_SCENE_UPDATE_TIMEOUT: 60_000,
}));

vi.mock("../data/sceneStorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/sceneStorage")>()),
  readRoomBackup: async () => null,
}));

vi.mock("../data/roomFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/roomFiles")>()),
  downloadRoomFiles: async () => ({
    loadedFiles: [],
    erroredFiles: new Map(),
  }),
  uploadRoomFiles: async () => ({ savedFiles: [], erroredFiles: [] }),
}));

vi.mock("../data/rooms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/rooms")>()),
  fetchRooms: async () => [],
  fetchRoomFolders: async () => [],
  registerRoom: async () => {},
  saveRoomToServer: vi.fn(),
  loadRoomFromServer: vi.fn(),
}));

vi.mock("socket.io-client", () => ({
  default: () => ({
    connected: true,
    close: () => {},
    on: () => {},
    once: () => {},
    off: () => {},
    emit: () => {},
  }),
}));

type Room = { roomId: string; roomKey: string };

type PreparedRoomScene = {
  elements: readonly unknown[];
  viewport: { scrollX: number; scrollY: number; zoom: { value: number } };
  baseline: readonly SyncableExcalidrawElement[] | null | undefined;
};

type CollabTestApi = {
  startCollaboration: (room: Room | null) => Promise<unknown>;
  stopCollaboration: (keepRemoteState?: boolean) => void;
  startRoomConnection: (options: unknown) => Promise<unknown>;
  preparedRoomScenes?: Map<string, PreparedRoomScene>;
};

const ROOM_A: Room = { roomId: "room-a", roomKey: "AaBbCcDdEeFfGgHhIiJjKk" };
const ROOM_B: Room = { roomId: "room-b", roomKey: "LlMmNnOoPpQqRrSsTtUuVv" };

const preparedScenes = (collab: CollabTestApi) => {
  if (!collab.preparedRoomScenes) {
    throw new Error(
      "Collab.preparedRoomScenes is missing — prepared room caching is not implemented",
    );
  }
  return collab.preparedRoomScenes;
};

const preparedKey = (room: Room) => JSON.stringify([room.roomId, room.roomKey]);

const sceneOf = (id: string, x: number) =>
  getSyncableElements(
    restoreElements(
      [
        API.createElement({
          type: "rectangle",
          id,
          x,
          y: 0,
          width: 100,
          height: 100,
        }),
      ],
      null,
    ),
  );

const seedRoom = (room: Room, elements: readonly SyncableExcalidrawElement[]) =>
  cacheRoomScene(room.roomId, room.roomKey, { etag: '"base"', elements });

const mountCollab = async () => {
  await render(<ExcalidrawApp />);
  const collab = window.collab as unknown as CollabTestApi;
  vi.spyOn(collab, "startRoomConnection").mockImplementation(
    () => new Promise(() => {}),
  );
  return collab;
};

const startRoom = async (collab: CollabTestApi, room: Room) => {
  await act(async () => {
    await collab.startCollaboration(room);
  });
};

const stopRoom = async (collab: CollabTestApi) => {
  await act(async () => {
    collab.stopCollaboration(false);
  });
  await flushRoomCache();
};

const settlePreparedBaseline = async (collab: CollabTestApi, room: Room) => {
  await vi.waitFor(
    () => {
      const entry = preparedScenes(collab).get(preparedKey(room));
      if (!entry) {
        throw new Error("prepared snapshot missing");
      }
      expect(entry.baseline).not.toBe(undefined);
    },
    { timeout: 10_000 },
  );
};

beforeEach(async () => {
  await flushRoomCache();
  await clear(createStore("excalidraw-rooms-db", "cache"));
  await clear(createStore("excalidraw-scenes-db", "scenes"));
  clearRoomSceneCache();
  LocalData.pauseSave("collaboration");
  LocalData.resumeSave("collaboration");
  appJotaiStore.set(activeRoomLinkAtom, null);
  appJotaiStore.set(isCollaboratingAtom, false);
  appJotaiStore.set(offlineRoomPendingAtom, null);
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

afterEach(async () => {
  cleanup();
  await flushRoomCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("prepared room scenes", () => {
  it("keeps prepared elements but rereads files cached after capture", async () => {
    const image: BinaryFileData = {
      id: "prepared-image" as FileId,
      dataURL: "data:image/png;base64,test" as DataURL,
      mimeType: "image/png",
      created: 1,
    };
    await seedRoom(
      ROOM_A,
      getSyncableElements(
        restoreElements(
          [
            API.createElement({
              type: "image",
              fileId: image.id,
              status: "saved",
            }),
          ],
          null,
        ),
      ),
    );
    const collab = await mountCollab();
    await startRoom(collab, ROOM_A);
    const api = window.collab.props.excalidrawAPI;
    expect(api.getFiles()[image.id]).toBeUndefined();
    const captured = window.h.elements[0];
    await stopRoom(collab);
    await settlePreparedBaseline(collab, ROOM_A);
    const generation = getRoomCacheGeneration(ROOM_A.roomId, ROOM_A.roomKey);
    await cacheRoomFiles(ROOM_A.roomId, ROOM_A.roomKey, [image]);
    expect(getRoomCacheGeneration(ROOM_A.roomId, ROOM_A.roomKey)).toBe(
      generation,
    );
    await startRoom(collab, ROOM_A);
    expect(window.h.elements[0]).toBe(captured);
    await waitFor(() => expect(api.getFiles()[image.id]).toEqual(image));
  });

  it("reinstalls the prepared element objects and viewport on revisit while resetting selection and history", async () => {
    await seedRoom(ROOM_A, sceneOf("shape-0", 10));
    const collab = await mountCollab();

    await startRoom(collab, ROOM_A);
    expect(window.h.elements.map((element) => element.id)).toEqual(["shape-0"]);
    expect(window.h.elements[0].x).toBe(10);

    await act(async () => {
      API.updateScene({
        elements: syncInvalidIndices([
          newElementWith(window.h.elements[0], { x: 40 }),
        ]),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });
    expect(window.h.elements[0].x).toBe(40);
    await waitFor(() => expect(API.getUndoStack().length).toBeGreaterThan(0));

    API.setAppState({
      scrollX: 321,
      scrollY: -64,
      zoom: { value: 1.5 } as AppState["zoom"],
      selectedElementIds: { [window.h.elements[0].id]: true },
    });
    expect(window.h.state.selectedElementIds).toEqual({
      [window.h.elements[0].id]: true,
    });
    expect(window.h.state.scrollX).toBe(321);

    await stopRoom(collab);
    const captured = [...window.h.elements];
    expect(captured).toHaveLength(1);
    expect(preparedScenes(collab).has(preparedKey(ROOM_A))).toBe(true);
    await settlePreparedBaseline(collab, ROOM_A);

    await startRoom(collab, ROOM_A);

    expect(window.h.elements).toHaveLength(1);
    expect(window.h.elements[0]).toBe(captured[0]);
    expect(window.h.elements[0].x).toBe(40);
    expect(window.h.state.scrollX).toBe(321);
    expect(window.h.state.scrollY).toBe(-64);
    expect(window.h.state.zoom.value).toBeCloseTo(1.5);
    expect(window.h.state.selectedElementIds).toEqual({});
    expect(API.getUndoStack().length).toBe(0);
  }, 30_000);

  it("lets a later draft write supersede the prepared snapshot", async () => {
    await seedRoom(ROOM_A, sceneOf("shape-0", 10));
    const collab = await mountCollab();

    await startRoom(collab, ROOM_A);
    await stopRoom(collab);
    const captured = [...window.h.elements];
    await settlePreparedBaseline(collab, ROOM_A);
    expect(preparedScenes(collab).has(preparedKey(ROOM_A))).toBe(true);

    const newer = sceneOf("shape-0", 999).map((element) => ({
      ...element,
      version: 9,
      versionNonce: 9,
    }));
    await saveRoomDraft(ROOM_A.roomId, ROOM_A.roomKey, newer);
    await flushRoomCache();

    await startRoom(collab, ROOM_A);

    expect(window.h.elements).toHaveLength(1);
    expect(window.h.elements[0].x).toBe(999);
    expect(window.h.elements[0]).not.toBe(captured[0]);
  }, 30_000);

  it("keeps prepared scenes isolated by room id and key even when shape ids collide", async () => {
    const ROOM_SAME_ID_OTHER_KEY: Room = {
      roomId: ROOM_A.roomId,
      roomKey: "GgHhIiJjKkLlMmNnOoPpQq",
    };
    await seedRoom(ROOM_A, sceneOf("shape-0", 10));
    await seedRoom(ROOM_B, sceneOf("shape-0", 20));
    await seedRoom(ROOM_SAME_ID_OTHER_KEY, sceneOf("shape-0", 30));
    const collab = await mountCollab();

    await startRoom(collab, ROOM_A);
    expect(window.h.elements[0].x).toBe(10);
    const fromRoomA = [...window.h.elements];
    await stopRoom(collab);
    await settlePreparedBaseline(collab, ROOM_A);

    await startRoom(collab, ROOM_B);
    expect(window.h.elements[0].x).toBe(20);
    expect(window.h.elements[0]).not.toBe(fromRoomA[0]);
    await act(async () => {
      API.updateScene({
        elements: getSyncableElements(
          restoreElements(
            [
              {
                ...window.h.elements[0],
                x: 777,
                version: 3,
                versionNonce: 3,
              },
            ],
            null,
          ),
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    });
    expect(window.h.elements[0].x).toBe(777);
    await stopRoom(collab);
    await settlePreparedBaseline(collab, ROOM_B);

    await startRoom(collab, ROOM_SAME_ID_OTHER_KEY);
    expect(window.h.elements[0].x).toBe(30);
    await stopRoom(collab);

    await startRoom(collab, ROOM_A);
    expect(window.h.elements).toHaveLength(1);
    expect(window.h.elements[0]).toBe(fromRoomA[0]);
    expect(window.h.elements[0].x).toBe(10);
  }, 40_000);

  it("bounds the prepared cache to eight rooms and evicts the oldest entry", async () => {
    const rooms: Room[] = Array.from({ length: 9 }, (_, index) => ({
      roomId: `room-${index}`,
      roomKey: `key-${index}`,
    }));
    for (const [index, room] of rooms.entries()) {
      await seedRoom(room, sceneOf(`shape-${index}`, 100 + index));
    }
    const collab = await mountCollab();

    const captured: typeof window.h.elements[] = [];
    for (const [index, room] of rooms.entries()) {
      await startRoom(collab, room);
      expect(window.h.elements.map((element) => element.id)).toEqual([
        `shape-${index}`,
      ]);
      expect(window.h.elements[0].x).toBe(100 + index);
      captured.push([...window.h.elements]);
      await stopRoom(collab);
    }

    const map = preparedScenes(collab);
    expect(map.size).toBe(8);
    expect(map.has(preparedKey(rooms[0]))).toBe(false);
    expect(map.has(preparedKey(rooms[8]))).toBe(true);

    await settlePreparedBaseline(collab, rooms[8]);
    await startRoom(collab, rooms[0]);
    expect(window.h.elements[0].x).toBe(100);
    expect(window.h.elements[0]).not.toBe(captured[0][0]);
    await stopRoom(collab);

    await settlePreparedBaseline(collab, rooms[8]);
    await startRoom(collab, rooms[8]);
    expect(window.h.elements[0].x).toBe(108);
    expect(window.h.elements[0]).toBe(captured[8][0]);
  }, 60_000);

  it("drops the prepared snapshot when the room is deleted after stopping", async () => {
    await seedRoom(ROOM_A, sceneOf("shape-0", 10));
    const collab = await mountCollab();

    await startRoom(collab, ROOM_A);
    expect(window.h.elements[0].x).toBe(10);
    const captured = [...window.h.elements];
    await stopRoom(collab);
    await settlePreparedBaseline(collab, ROOM_A);
    expect(preparedScenes(collab).has(preparedKey(ROOM_A))).toBe(true);

    const generation = getRoomCacheGeneration(ROOM_A.roomId, ROOM_A.roomKey);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
    expect(await deleteRoom(ROOM_A.roomId, ROOM_A.roomKey)).toBe(true);
    vi.unstubAllGlobals();
    expect(
      getRoomCacheGeneration(ROOM_A.roomId, ROOM_A.roomKey),
    ).toBeGreaterThan(generation);

    await seedRoom(ROOM_A, sceneOf("shape-0", 555));
    await flushRoomCache();

    await startRoom(collab, ROOM_A);
    expect(window.h.elements).toHaveLength(1);
    expect(window.h.elements[0].x).toBe(555);
    expect(window.h.elements[0]).not.toBe(captured[0]);
    expect(preparedScenes(collab).has(preparedKey(ROOM_A))).toBe(false);
  }, 30_000);
});
