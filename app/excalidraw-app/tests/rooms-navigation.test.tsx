import { vi } from "vitest";
import { clear, createStore } from "idb-keyval";

import { CaptureUpdateAction, restoreElements } from "@excalidraw/excalidraw";

import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  DataURL,
  NormalizedZoomValue,
} from "@excalidraw/excalidraw/types";

import {
  cacheRoomFiles,
  cacheRoomScene,
  clearRoomMemoryCache,
  flushRoomCache,
  readRoomDraft,
  saveRoomDraft,
} from "../data/roomCache";
import { downloadRoomFiles } from "../data/roomFiles";

import ExcalidrawApp from "../App";
import {
  deleteRoom,
  loadRoomFromServer,
  saveRoomToServer,
} from "../data/rooms";
import { getSyncableElements } from "../data";
import { LocalData } from "../data/LocalData";
import { appJotaiStore } from "../app-jotai";
import { STORAGE_KEYS, WS_SUBTYPES } from "../app_constants";
import { loadLocalScene, readRoomBackup } from "../data/sceneStorage";
import { roomFoldersAtom, roomsRegistryAtom } from "../rooms/explorerState";
import {
  activeRoomLinkAtom,
  collabAPIAtom,
  isCollaboratingAtom,
  offlineRoomPendingAtom,
} from "../collab/Collab";

const socketState = vi.hoisted(() => ({
  announceFirstInRoom: true,
  listeners: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock("../app_constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app_constants")>()),
  INITIAL_SCENE_UPDATE_TIMEOUT: 60_000,
}));

vi.mock("../data/sceneStorage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/sceneStorage")>()),
  readRoomBackup: vi.fn(async () => null),
}));

Object.defineProperty(window, "crypto", {
  value: {
    getRandomValues: (bytes: Uint8Array) => bytes.fill(1),
    subtle: {
      importKey: async () => ({}),
      encrypt: async () => new ArrayBuffer(0),
    },
  },
});

vi.mock("../data/roomFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/roomFiles")>()),
  downloadRoomFiles: vi.fn(async () => ({
    loadedFiles: [],
    erroredFiles: new Map(),
  })),
  uploadRoomFiles: async () => ({ savedFiles: [], erroredFiles: [] }),
}));

vi.mock("../data/rooms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/rooms")>()),
  fetchRooms: async () => [
    {
      roomId: "room-a",
      key: "AaBbCcDdEeFfGgHhIiJjKk",
      name: "Algebra",
      createdAt: 1,
      lastActiveAt: 1,
      hasScene: true,
    },
    {
      roomId: "room-b",
      key: "LlMmNnOoPpQqRrSsTtUuVv",
      name: "Physics",
      createdAt: 1,
      lastActiveAt: 1,
      hasScene: true,
    },
  ],
  fetchRoomFolders: async () => [],
  registerRoom: async () => {},
  saveRoomToServer: vi.fn(),
  loadRoomFromServer: vi.fn(),
  deleteRoom: vi.fn(),
}));

vi.mock("socket.io-client", () => ({
  default: () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    socketState.listeners = listeners;
    return {
      connected: true,
      close: () => listeners.clear(),
      on: (name: string, callback: (...args: unknown[]) => void) => {
        listeners.set(name, callback);
        if (name === "first-in-room" && socketState.announceFirstInRoom) {
          queueMicrotask(() => listeners.get(name)?.());
        }
      },
      once: (name: string, callback: (...args: unknown[]) => void) =>
        listeners.set(name, callback),
      off: (name: string) => listeners.delete(name),
      emit: () => {},
    };
  },
}));

const syncableScene = (elements: readonly ExcalidrawElement[]) =>
  getSyncableElements(restoreElements(elements, null));

const openRoom = async (
  name: string,
  role: "button" | "treeitem" = "button",
) => {
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "My rooms" }))[0],
  );
  fireEvent.click(await screen.findByRole(role, { name }));
};

beforeEach(async () => {
  await flushRoomCache();
  clearRoomMemoryCache();
  await clear(createStore("excalidraw-rooms-db", "cache"));
  LocalData.pauseSave("collaboration");
  LocalData.resumeSave("collaboration");
  await clear(createStore("excalidraw-scenes-db", "scenes"));
  appJotaiStore.set(roomsRegistryAtom, null);
  appJotaiStore.set(roomFoldersAtom, null);
  socketState.announceFirstInRoom = true;
  vi.mocked(downloadRoomFiles).mockResolvedValue({
    loadedFiles: [],
    erroredFiles: new Map(),
  });
  vi.mocked(deleteRoom).mockResolvedValue(true);
  vi.mocked(readRoomBackup).mockResolvedValue(null);
  appJotaiStore.set(activeRoomLinkAtom, null);
  appJotaiStore.set(isCollaboratingAtom, false);
  appJotaiStore.set(offlineRoomPendingAtom, null);
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.mocked(loadRoomFromServer).mockImplementation(async (roomId) =>
    syncableScene([
      API.createElement({
        type: "rectangle",
        id: `${roomId}-drawing`,
        x: roomId === "room-a" ? 0 : 2000,
        y: 0,
        width: 100,
        height: 100,
      }),
    ]),
  );
});

afterEach(async () => {
  cleanup();
  await flushRoomCache();
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("Explorer room navigation", () => {
  it("opens cached drawings and images while connection setup is pending, then ignores a late old connection", async () => {
    const room = { roomId: "room-a", roomKey: "AaBbCcDdEeFfGgHhIiJjKk" };
    const imageFile: BinaryFileData = {
      id: "cached-image" as FileId,
      dataURL: "data:image/png;base64,test" as DataURL,
      mimeType: "image/png",
      created: 1,
    };
    const elements = syncableScene([
      API.createElement({
        type: "image",
        id: "cached-drawing",
        fileId: imageFile.id,
        status: "saved",
      }),
    ]);
    await cacheRoomScene(room.roomId, room.roomKey, {
      etag: '"cached"',
      elements,
    });
    await cacheRoomFiles(room.roomId, room.roomKey, [imageFile]);
    await render(<ExcalidrawApp />);
    const collab = window.collab as unknown as {
      startRoomConnection: (options: unknown) => Promise<unknown>;
    };
    const connect = collab.startRoomConnection;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setup = vi
      .spyOn(collab, "startRoomConnection")
      .mockImplementationOnce(async (options) => {
        await gate;
        return connect(options);
      });
    try {
      await openRoom("Algebra");
      await waitFor(() =>
        expect(window.h.elements[0]?.id).toBe("cached-drawing"),
      );
      await waitFor(() =>
        expect(
          window.collab.props.excalidrawAPI.getFiles()[imageFile.id],
        ).toEqual(imageFile),
      );
      expect(window.collab.portal.socket).toBeNull();
      expect(loadRoomFromServer).not.toHaveBeenCalled();
      expect(downloadRoomFiles).not.toHaveBeenCalled();
      await act(async () => {
        const repeated = await window.collab.startCollaboration(room);
        expect(repeated?.elements?.[0].id).toBe("cached-drawing");
        window.collab.props.excalidrawAPI.updateScene({
          elements: restoreElements(
            [{ ...elements[0], x: 555, version: 2, versionNonce: 2 }],
            null,
          ),
        });
      });
      expect(setup).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(window.h.elements[0]?.x).toBe(555));
      expect(saveRoomToServer).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Physics" }));
      await waitFor(() =>
        expect(window.h.elements[0]?.id).toBe("room-b-drawing"),
      );
      await act(async () => {
        release();
        await gate;
      });
      await waitFor(() => expect(window.collab.portal.roomId).toBe("room-b"));
      expect(window.h.elements[0]?.id).toBe("room-b-drawing");
      await waitFor(async () => {
        await flushRoomCache();
        expect((await readRoomDraft(room.roomId, room.roomKey))?.[0].x).toBe(
          555,
        );
      });
    } finally {
      release();
      setup.mockRestore();
    }
  });

  it("keeps the cached preview when background connection setup fails", async () => {
    await cacheRoomScene("room-a", "AaBbCcDdEeFfGgHhIiJjKk", {
      etag: '"cached"',
      elements: syncableScene([
        API.createElement({ type: "rectangle", id: "cached-drawing" }),
      ]),
    });
    await render(<ExcalidrawApp />);
    const collab = window.collab as unknown as {
      startRoomConnection: (options: unknown) => Promise<unknown>;
    };
    let reject!: (error: Error) => void;
    const gate = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const setup = vi
      .spyOn(collab, "startRoomConnection")
      .mockImplementationOnce(() => gate);
    try {
      await openRoom("Algebra");
      await waitFor(() =>
        expect(window.h.elements[0]?.id).toBe("cached-drawing"),
      );
      await act(async () => {
        reject(new Error("Socket client unavailable"));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(appJotaiStore.get(offlineRoomPendingAtom)?.roomId).toBe(
          "room-a",
        ),
      );
      expect(window.h.elements[0]?.id).toBe("cached-drawing");
      expect(saveRoomToServer).not.toHaveBeenCalled();
    } finally {
      setup.mockRestore();
    }
  });
  it("merges save conflicts without resurrecting unchanged server-removed shapes and ignores late conflicts after switching", async () => {
    const snapshot = syncableScene([
      API.createElement({
        type: "rectangle",
        id: "edited",
        width: 100,
        height: 100,
      }),
      API.createElement({
        type: "rectangle",
        id: "removed",
        x: 200,
        width: 100,
        height: 100,
      }),
    ]);
    vi.mocked(loadRoomFromServer).mockResolvedValueOnce(snapshot);
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "edited",
        "removed",
      ]),
    );
    const baseline = getSyncableElements(
      window.collab.props.excalidrawAPI.getSceneElementsIncludingDeleted(),
    );
    await act(async () => {
      API.updateScene({
        elements: restoreElements(
          [
            { ...baseline[0], x: 555, version: 20, versionNonce: 20 },
            baseline[1],
          ],
          null,
        ),
      });
      await window.collab.saveCollabRoom(
        getSyncableElements(
          window.collab.props.excalidrawAPI.getSceneElementsIncludingDeleted(),
        ),
      );
    });
    const options = vi.mocked(saveRoomToServer).mock.calls.at(-1)?.[2];
    expect(options?.onConflict).toBeDefined();
    const latest = syncableScene([
      baseline[0],
      API.createElement({
        type: "rectangle",
        id: "remote-added",
        x: 400,
        width: 100,
        height: 100,
      }),
    ]);
    await act(async () => {
      options!.onConflict!(latest, baseline);
    });
    expect(window.h.elements.map((element) => element.id)).toEqual([
      "edited",
      "remote-added",
    ]);
    expect(window.h.elements[0].x).toBe(555);
    fireEvent.click(await screen.findByRole("button", { name: "Physics" }));
    await waitFor(() =>
      expect(window.h.elements[0]?.id).toBe("room-b-drawing"),
    );
    await act(async () => {
      options!.onConflict!(latest, baseline);
    });
    expect(window.h.elements.map((element) => element.id)).toEqual([
      "room-b-drawing",
    ]);
  });

  it("restores an unsent draft image from IndexedDB while validation is pending", async () => {
    const imageFile: BinaryFileData = {
      id: "offline-image" as FileId,
      dataURL:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" as DataURL,
      mimeType: "image/png",
      created: 1,
    };
    const imageScene = syncableScene([
      API.createElement({
        type: "image",
        fileId: imageFile.id,
        status: "pending",
      }),
    ]);
    await cacheRoomScene("room-a", "AaBbCcDdEeFfGgHhIiJjKk", {
      etag: '"cached"',
      elements: [],
    });
    await saveRoomDraft("room-a", "AaBbCcDdEeFfGgHhIiJjKk", imageScene);
    await cacheRoomFiles("room-a", "AaBbCcDdEeFfGgHhIiJjKk", [imageFile]);
    let resolveSnapshot!: (
      elements: Awaited<ReturnType<typeof loadRoomFromServer>>,
    ) => void;
    vi.mocked(loadRoomFromServer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(
        window.collab.props.excalidrawAPI.getFiles()[imageFile.id]?.dataURL,
      ).toBe(imageFile.dataURL),
    );
    expect(window.h.elements[0]).toMatchObject({
      status: "pending",
      fileId: imageFile.id,
    });
    expect(window.collab.fileManager.isFileSavedOrBeingSaved(imageFile)).toBe(
      false,
    );
    expect(downloadRoomFiles).not.toHaveBeenCalled();
    await act(async () => {
      resolveSnapshot(imageScene);
    });
  });

  it("does not add a delayed attachment from the previous room", async () => {
    const imageFile: BinaryFileData = {
      id: "old-image" as FileId,
      dataURL: "data:image/png;base64,test" as DataURL,
      mimeType: "image/png",
      created: 1,
    };
    const imageScene = syncableScene([
      API.createElement({
        type: "image",
        fileId: imageFile.id,
        status: "saved",
      }),
    ]);
    vi.mocked(loadRoomFromServer).mockResolvedValueOnce(imageScene);
    let resolveDownload!: (
      result: Awaited<ReturnType<typeof downloadRoomFiles>>,
    ) => void;
    vi.mocked(downloadRoomFiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() => expect(downloadRoomFiles).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Physics" }));
    await waitFor(() =>
      expect(window.h.elements[0]?.id).toBe("room-b-drawing"),
    );
    const addFiles = vi.spyOn(window.collab.props.excalidrawAPI, "addFiles");
    await act(async () => {
      resolveDownload({ loadedFiles: [imageFile], erroredFiles: new Map() });
    });
    expect(
      addFiles.mock.calls
        .flatMap(([files]) => files)
        .some((file) => file.id === imageFile.id),
    ).toBe(false);
    expect(window.collab.fileManager.isFileTracked(imageFile.id)).toBe(false);
    addFiles.mockRestore();
  });

  it("shows a persisted drawing before validation, preserves edits, and removes unchanged stale shapes", async () => {
    const cached = syncableScene([
      API.createElement({
        type: "rectangle",
        id: "cached-drawing",
        width: 100,
        height: 100,
      }),
      API.createElement({
        type: "rectangle",
        id: "removed-on-server",
        width: 100,
        height: 100,
        x: 200,
      }),
    ]);
    await cacheRoomScene("room-a", "AaBbCcDdEeFfGgHhIiJjKk", {
      etag: '"cached"',
      elements: cached,
    });
    let resolveSnapshot!: (
      elements: Awaited<ReturnType<typeof loadRoomFromServer>>,
    ) => void;
    vi.mocked(loadRoomFromServer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "cached-drawing",
        "removed-on-server",
      ]),
    );
    expect(loadRoomFromServer).toHaveBeenCalledTimes(1);
    expect(saveRoomToServer).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking for updates",
    );
    await act(async () => {
      API.updateScene({
        elements: restoreElements(
          [
            { ...window.h.elements[0], x: 555, version: 10, versionNonce: 100 },
            window.h.elements[1],
            API.createElement({
              type: "rectangle",
              id: "local-stroke",
              width: 50,
              height: 50,
            }),
          ],
          null,
        ),
      });
    });
    expect(saveRoomToServer).not.toHaveBeenCalled();
    await act(async () => {
      resolveSnapshot(
        syncableScene([
          { ...cached[0], x: 30, version: 2, versionNonce: 2 },
          API.createElement({
            type: "rectangle",
            id: "server-stroke",
            width: 80,
            height: 80,
          }),
        ]),
      );
    });
    await waitFor(() => {
      const ids = window.h.elements.map((element) => element.id);
      expect(ids).toContain("local-stroke");
      expect(ids).toContain("server-stroke");
      expect(ids).not.toContain("removed-on-server");
      expect(
        window.h.elements.find((element) => element.id === "cached-drawing")?.x,
      ).toBe(555);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("ignores delayed validation after leaving a cached room", async () => {
    const cached = syncableScene([
      API.createElement({
        type: "rectangle",
        id: "cached-a",
        width: 100,
        height: 100,
      }),
    ]);
    await cacheRoomScene("room-a", "AaBbCcDdEeFfGgHhIiJjKk", {
      etag: '"cached"',
      elements: cached,
    });
    let resolveOld!: (
      elements: Awaited<ReturnType<typeof loadRoomFromServer>>,
    ) => void;
    vi.mocked(loadRoomFromServer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() => expect(window.h.elements[0]?.id).toBe("cached-a"));
    fireEvent.click(await screen.findByRole("button", { name: "Physics" }));
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-b-drawing",
      ]),
    );
    await act(async () => {
      resolveOld(cached);
    });
    expect(window.h.elements.map((element) => element.id)).toEqual([
      "room-b-drawing",
    ]);
    expect(appJotaiStore.get(offlineRoomPendingAtom)).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("retains a cached drawing when background validation fails without uploading it", async () => {
    const cached = syncableScene([
      API.createElement({
        type: "rectangle",
        id: "cached-drawing",
        width: 100,
        height: 100,
      }),
    ]);
    await cacheRoomScene("room-a", "AaBbCcDdEeFfGgHhIiJjKk", {
      etag: '"cached"',
      elements: cached,
    });
    let rejectSnapshot!: (error: Error) => void;
    vi.mocked(loadRoomFromServer).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSnapshot = reject;
        }),
    );
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.h.elements[0]?.id).toBe("cached-drawing"),
    );
    await act(async () => {
      rejectSnapshot(new Error("Connection failed"));
    });
    await waitFor(() =>
      expect(appJotaiStore.get(offlineRoomPendingAtom)?.roomId).toBe("room-a"),
    );
    expect(window.h.elements.map((element) => element.id)).toEqual([
      "cached-drawing",
    ]);
    expect(saveRoomToServer).not.toHaveBeenCalled();
  });

  it("restores room-scoped drafts on a fresh offline boot", async () => {
    const cached = syncableScene([
      API.createElement({
        type: "rectangle",
        id: "cached-drawing",
        width: 100,
        height: 100,
      }),
    ]);
    const draft = syncableScene([
      ...cached,
      API.createElement({
        type: "rectangle",
        id: "unsynced-stroke",
        width: 50,
        height: 50,
      }),
    ]);
    await cacheRoomScene("room-a", "AaBbCcDdEeFfGgHhIiJjKk", {
      etag: '"cached"',
      elements: cached,
    });
    await saveRoomDraft("room-a", "AaBbCcDdEeFfGgHhIiJjKk", draft);
    vi.mocked(loadRoomFromServer).mockRejectedValueOnce(new Error("Offline"));
    window.history.replaceState({}, "", "/#room=room-a,AaBbCcDdEeFfGgHhIiJjKk");
    await render(<ExcalidrawApp />);
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "cached-drawing",
        "unsynced-stroke",
      ]),
    );
    expect(saveRoomToServer).not.toHaveBeenCalled();
  });
  it("aborts a stalled download and keeps the previous drawing", async () => {
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-a-drawing",
      ]),
    );
    let signal!: AbortSignal;
    vi.mocked(loadRoomFromServer).mockImplementationOnce(
      (_roomId, _roomKey, _socket, options) => {
        signal = options!.signal!;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("Download stalled")),
            { once: true },
          );
        });
      },
    );
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Physics" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_001);
    });
    expect(signal.aborted).toBe(true);
    vi.useRealTimers();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't reach"),
    );
    expect(window.h.elements.map((element) => element.id)).toEqual([
      "room-a-drawing",
    ]);
  });

  it("lets a slow download complete as long as it keeps making progress", async () => {
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-a-drawing",
      ]),
    );
    let resolveSnapshot!: (
      scene: Awaited<ReturnType<typeof loadRoomFromServer>>,
    ) => void;
    let onProgress!: () => void;
    let signal!: AbortSignal;
    vi.mocked(loadRoomFromServer).mockImplementationOnce(
      (_roomId, _roomKey, _socket, options) => {
        onProgress = options!.onProgress!;
        signal = options!.signal!;
        return new Promise((resolve) => {
          resolveSnapshot = resolve;
        });
      },
    );
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Physics" }));
    });
    expect(typeof onProgress).toBe("function");
    const downloadSignal = signal;
    const reportProgress = onProgress;
    for (let index = 0; index < 3; index++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(downloadSignal.aborted).toBe(false);
        reportProgress();
      });
    }
    await act(async () => {
      resolveSnapshot(
        syncableScene([
          API.createElement({
            type: "rectangle",
            id: "slow-drawing",
            width: 100,
            height: 100,
          }),
        ]),
      );
    });
    vi.useRealTimers();
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "slow-drawing",
      ]),
    );
  });

  it("loads the saved drawing without waiting for the socket handshake", async () => {
    socketState.announceFirstInRoom = false;
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-a-drawing",
      ]),
    );
    expect(loadRoomFromServer).toHaveBeenCalledTimes(1);
    await act(async () => {
      socketState.listeners.get("first-in-room")?.();
      await Promise.resolve();
    });
    expect(loadRoomFromServer).toHaveBeenCalledTimes(1);
  });

  it("merges a partial live peer scene with the saved drawing", async () => {
    socketState.announceFirstInRoom = false;
    let resolveSnapshot!: (
      elements: Awaited<ReturnType<typeof loadRoomFromServer>>,
    ) => void;
    vi.mocked(loadRoomFromServer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() => expect(typeof resolveSnapshot).toBe("function"));
    const createDrawing = (id: string) =>
      syncableScene([
        API.createElement({
          type: "rectangle",
          id,
          width: 100,
          height: 100,
        }),
      ]);
    const decryptPayload = vi
      .spyOn(window.collab as any, "decryptPayload")
      .mockResolvedValue({
        type: WS_SUBTYPES.INIT,
        payload: { elements: createDrawing("live-drawing") },
      });
    try {
      await act(async () => {
        await socketState.listeners.get("client-broadcast")?.(
          new ArrayBuffer(0),
          new Uint8Array(0),
        );
      });
      await waitFor(() =>
        expect(window.h.elements.map((element) => element.id)).toEqual([
          "live-drawing",
        ]),
      );
      await act(async () => {
        await window.collab.saveCollabRoom(createDrawing("live-drawing"));
      });
      expect(saveRoomToServer).not.toHaveBeenCalled();
      await act(async () => {
        resolveSnapshot(createDrawing("stale-snapshot"));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(window.h.elements.map((element) => element.id).sort()).toEqual([
          "live-drawing",
          "stale-snapshot",
        ]),
      );
    } finally {
      decryptPayload.mockRestore();
    }
  });

  it("does not let an empty peer INIT bypass or duplicate the snapshot load", async () => {
    socketState.announceFirstInRoom = false;
    let resolveSnapshot!: (
      elements: Awaited<ReturnType<typeof loadRoomFromServer>>,
    ) => void;
    vi.mocked(loadRoomFromServer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() => expect(typeof resolveSnapshot).toBe("function"));
    const decryptPayload = vi
      .spyOn(window.collab as any, "decryptPayload")
      .mockResolvedValue({
        type: WS_SUBTYPES.INIT,
        payload: { elements: [] },
      });
    try {
      await act(async () => {
        await socketState.listeners.get("client-broadcast")?.(
          new ArrayBuffer(0),
          new Uint8Array(0),
        );
      });
      expect(loadRoomFromServer).toHaveBeenCalledTimes(1);
      expect(window.collab.portal.socketInitialized).toBe(false);
      await act(async () => {
        resolveSnapshot(
          syncableScene([
            API.createElement({
              type: "rectangle",
              id: "saved-drawing",
              width: 100,
              height: 100,
            }),
          ]),
        );
      });
      await waitFor(() =>
        expect(window.h.elements.map((element) => element.id)).toEqual([
          "saved-drawing",
        ]),
      );
    } finally {
      decryptPayload.mockRestore();
    }
  });

  it("reports a failed snapshot request and restores the previous drawing", async () => {
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-a-drawing",
      ]),
    );
    vi.mocked(loadRoomFromServer).mockRejectedValueOnce(
      new Error("Snapshot request failed"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Physics" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't reach"),
    );
    expect(window.h.elements.map((element) => element.id)).toEqual([
      "room-a-drawing",
    ]);
    expect(window.location.hash).toBe("#room=room-a,AaBbCcDdEeFfGgHhIiJjKk");
  });

  it("accepts a late live INIT when a room has no saved snapshot", async () => {
    vi.mocked(loadRoomFromServer).mockResolvedValueOnce(null);
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.collab.portal.socketInitialized).toBe(true),
    );
    const decryptPayload = vi
      .spyOn(window.collab as any, "decryptPayload")
      .mockResolvedValue({
        type: WS_SUBTYPES.INIT,
        payload: {
          elements: syncableScene([
            API.createElement({
              type: "rectangle",
              id: "late-live-drawing",
              width: 100,
              height: 100,
            }),
          ]),
        },
      });
    try {
      await act(async () => {
        await socketState.listeners.get("client-broadcast")?.(
          new ArrayBuffer(0),
          new Uint8Array(0),
        );
      });
      await waitFor(() =>
        expect(window.h.elements.map((element) => element.id)).toEqual([
          "late-live-drawing",
        ]),
      );
    } finally {
      decryptPayload.mockRestore();
    }
  });

  it("frames visible drawings without zooming out to distant deleted elements", async () => {
    vi.mocked(loadRoomFromServer).mockResolvedValueOnce(
      syncableScene([
        API.createElement({
          type: "rectangle",
          id: "visible-drawing",
          x: 2000,
          width: 100,
          height: 100,
        }),
        API.createElement({
          type: "rectangle",
          id: "deleted-drawing",
          x: 100_000_000,
          width: 100,
          height: 100,
          isDeleted: true,
        }),
      ]),
    );
    await render(<ExcalidrawApp />);
    await act(async () => {
      window.h.app.setState({ width: 1000, height: 800 });
    });
    await openRoom("Algebra");
    await waitFor(() =>
      expect(
        window.h.elements.some((element) => element.id === "visible-drawing"),
      ).toBe(true),
    );
    expect(window.h.state.zoom.value).toBeGreaterThan(0.1);
  });

  it("keeps unsynced edits to existing shapes from a legacy room backup", async () => {
    vi.mocked(readRoomBackup).mockImplementation(async (_storage, roomId) =>
      roomId === "room-a"
        ? syncableScene([
            {
              ...API.createElement({
                type: "rectangle",
                id: "room-a-drawing",
                x: 555,
                width: 100,
                height: 100,
              }),
              version: 9,
            },
          ])
        : null,
    );
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() => expect(loadRoomFromServer).toHaveBeenCalled());
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-a-drawing",
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument(),
    );
    expect(window.h.elements[0].x).toBe(555);
  });

  it("never writes room drawings over the personal local canvas", async () => {
    const personal = API.createElement({
      type: "rectangle",
      id: "personal-drawing",
      width: 40,
      height: 40,
    });
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([personal]),
    );
    await render(<ExcalidrawApp />);
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "personal-drawing",
      ]),
    );
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-a-drawing",
      ]),
    );
    await act(async () => {
      API.updateScene({
        elements: [
          ...window.h.elements,
          API.createElement({ type: "rectangle", id: "room-edit" }),
        ],
      });
    });
    await act(async () => {
      LocalData.flushSave();
    });
    const stored = JSON.parse(
      (await loadLocalScene(localStorage)).elements ?? "[]",
    );
    expect(stored.map((element: { id: string }) => element.id)).toEqual([
      "personal-drawing",
    ]);
  });

  it("deletes the current room, disconnects it, and keeps its drawing locally", async () => {
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-a-drawing",
      ]),
    );
    fireEvent.keyDown(
      await screen.findByRole("button", {
        name: "More actions for Algebra",
      }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "Delete" })).getByRole(
        "button",
        { name: "Delete" },
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("treeitem", { name: "Algebra" }),
      ).not.toBeInTheDocument(),
    );
    expect(deleteRoom).toHaveBeenCalledWith("room-a", "AaBbCcDdEeFfGgHhIiJjKk");
    expect(appJotaiStore.get(activeRoomLinkAtom)).toBeNull();
    expect(appJotaiStore.get(isCollaboratingAtom)).toBe(false);
    expect(window.location.hash).toBe("");
    expect(window.h.elements.map((element) => element.id)).toEqual([
      "room-a-drawing",
    ]);
  });

  it("loads the clicked room, keeps the Explorer open, and switches to a different drawing", async () => {
    await render(<ExcalidrawApp />);
    await openRoom("Algebra", "treeitem");
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-a-drawing",
      ]),
    );
    expect(window.location.hash).toBe("#room=room-a,AaBbCcDdEeFfGgHhIiJjKk");
    expect(loadRoomFromServer).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("treeitem", { name: "Algebra" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Physics" }));
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-b-drawing",
      ]),
    );
    expect(window.location.hash).toBe("#room=room-b,LlMmNnOoPpQqRrSsTtUuVv");
    expect(screen.getByRole("treeitem", { name: "Physics" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("treeitem", { name: "Algebra" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("ignores an old room's delayed load after switching rooms", async () => {
    await render(<ExcalidrawApp />);
    await openRoom("Algebra");
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-a-drawing",
      ]),
    );
    await act(() =>
      window.h.app.toggleSidebar({
        name: "default",
        tab: "rooms",
        force: true,
      }),
    );
    let resolveOld!: (
      elements: Awaited<ReturnType<typeof loadRoomFromServer>>,
    ) => void;
    vi.mocked(loadRoomFromServer).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    let oldLoad!: Promise<unknown>;
    act(() => {
      oldLoad = (window.collab as any).initializeRoom({
        fetchScene: true,
        roomLinkData: { roomId: "room-a", roomKey: "AaBbCcDdEeFfGgHhIiJjKk" },
      });
    });
    await waitFor(() => expect(typeof resolveOld).toBe("function"));
    fireEvent.click(await screen.findByRole("button", { name: "Physics" }));
    await waitFor(() =>
      expect(window.h.elements.map((element) => element.id)).toEqual([
        "room-b-drawing",
      ]),
    );
    await act(async () => {
      resolveOld(
        syncableScene([
          API.createElement({
            type: "rectangle",
            id: "late-room-a",
            width: 100,
            height: 100,
          }),
        ]),
      );
      await oldLoad;
    });
    expect(window.h.elements.map((element) => element.id)).toEqual([
      "room-b-drawing",
    ]);
  });

  it("does not reinstall elements the collab session already painted", async () => {
    const room = { roomId: "room-a", roomKey: "AaBbCcDdEeFfGgHhIiJjKk" };
    await cacheRoomScene(room.roomId, room.roomKey, {
      etag: '"cached"',
      elements: syncableScene([
        API.createElement({
          type: "rectangle",
          id: "cached-drawing",
          width: 100,
          height: 100,
        }),
      ]),
    });
    await render(<ExcalidrawApp />);
    const collab = window.collab as unknown as {
      startRoomConnection: (options: unknown) => Promise<unknown>;
    };
    const connect = collab.startRoomConnection;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setup = vi
      .spyOn(collab, "startRoomConnection")
      .mockImplementationOnce(async (options) => {
        await gate;
        return connect(options);
      });
    const { excalidrawAPI } = window.collab.props;
    const updateScene = excalidrawAPI.updateScene;
    const reinstall: unknown[] = [];
    const spy = vi
      .spyOn(excalidrawAPI, "updateScene")
      .mockImplementation((sceneData) => {
        const current = excalidrawAPI.getSceneElementsIncludingDeleted();
        const next = sceneData?.elements;
        if (
          next?.length &&
          current.length === next.length &&
          next.every((element, index) => element === current[index])
        ) {
          reinstall.push(next);
        }
        return updateScene(sceneData);
      });
    try {
      await openRoom("Algebra");
      await waitFor(() =>
        expect(window.h.elements.map((element) => element.id)).toEqual([
          "cached-drawing",
        ]),
      );
      expect(reinstall).toEqual([]);
    } finally {
      release();
      spy.mockRestore();
      setup.mockRestore();
    }
  });

  it("applies a cold scene and its supplied viewport in one scene update", async () => {
    await render(<ExcalidrawApp />);
    const collabAPI = appJotaiStore.get(collabAPIAtom);
    const { excalidrawAPI } = window.collab.props;
    const elements = syncableScene([
      API.createElement({
        type: "rectangle",
        id: "cold-drawing",
        width: 100,
        height: 100,
      }),
    ]);
    let collaborating = false;
    const isCollaborating = vi
      .spyOn(collabAPI!, "isCollaborating")
      .mockImplementation(() => collaborating);
    const startCollaboration = vi
      .spyOn(collabAPI!, "startCollaboration")
      .mockImplementationOnce(async () => {
        collaborating = true;
        return {
          elements,
          appState: {
            scrollX: 40,
            scrollY: 60,
            zoom: { value: 0.5 as NormalizedZoomValue },
          },
          scrollToContent: false,
        };
      });
    const updateScene = vi.spyOn(excalidrawAPI, "updateScene");
    try {
      await openRoom("Algebra");
      await waitFor(() =>
        expect(window.h.elements.map((element) => element.id)).toEqual([
          "cold-drawing",
        ]),
      );
      const painted = updateScene.mock.calls.filter(
        ([sceneData]) => sceneData?.appState,
      );
      expect(painted).toHaveLength(1);
      expect(painted[0][0].elements).toHaveLength(1);
      expect(window.h.state.scrollX).toBe(40);
      expect(window.h.state.scrollY).toBe(60);
      expect(window.h.state.zoom.value).toBe(0.5);
    } finally {
      updateScene.mockRestore();
      startCollaboration.mockRestore();
      isCollaborating.mockRestore();
    }
  });

  it("folds the fitted viewport into the cold scene install", async () => {
    await render(<ExcalidrawApp />);
    await act(async () => {
      window.h.app.setState({ width: 1000, height: 800 });
    });
    const collabAPI = appJotaiStore.get(collabAPIAtom);
    const { excalidrawAPI } = window.collab.props;
    const elements = syncableScene([
      API.createElement({
        type: "rectangle",
        id: "distant-drawing",
        x: 2000,
        y: 0,
        width: 100,
        height: 100,
      }),
    ]);
    let collaborating = false;
    const isCollaborating = vi
      .spyOn(collabAPI!, "isCollaborating")
      .mockImplementation(() => collaborating);
    const startCollaboration = vi
      .spyOn(collabAPI!, "startCollaboration")
      .mockImplementationOnce(async () => {
        collaborating = true;
        return { elements, scrollToContent: true };
      });
    const updateScene = vi.spyOn(excalidrawAPI, "updateScene");
    try {
      await openRoom("Algebra");
      await waitFor(() =>
        expect(window.h.elements.map((element) => element.id)).toEqual([
          "distant-drawing",
        ]),
      );
      const painted = updateScene.mock.calls.filter(
        ([sceneData]) => sceneData?.appState,
      );
      const fitted = painted[0][0].appState;
      expect(painted).toHaveLength(1);
      expect(painted[0][0].elements).toHaveLength(1);
      expect(window.h.state.zoom.value).toBeGreaterThan(1);
      expect(window.h.state.zoom.value).toBe(fitted?.zoom.value);
      expect(window.h.state.scrollX).toBe(fitted?.scrollX);
    } finally {
      updateScene.mockRestore();
      startCollaboration.mockRestore();
      isCollaborating.mockRestore();
    }
  });

  it("keeps a supplied viewport collab already applied without another scene update", async () => {
    await render(<ExcalidrawApp />);
    const collabAPI = appJotaiStore.get(collabAPIAtom);
    const { excalidrawAPI } = window.collab.props;
    const elements = syncableScene([
      API.createElement({
        type: "rectangle",
        id: "installed-drawing",
        width: 100,
        height: 100,
      }),
    ]);
    const viewport = {
      scrollX: 120,
      scrollY: 80,
      zoom: { value: 0.75 as NormalizedZoomValue },
    };
    let collaborating = false;
    const isCollaborating = vi
      .spyOn(collabAPI!, "isCollaborating")
      .mockImplementation(() => collaborating);
    const updateScene = vi.spyOn(excalidrawAPI, "updateScene");
    const startCollaboration = vi
      .spyOn(collabAPI!, "startCollaboration")
      .mockImplementationOnce(async () => {
        collaborating = true;
        excalidrawAPI.updateScene({
          elements,
          appState: viewport,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        updateScene.mockClear();
        return { elements, appState: viewport, scrollToContent: false };
      });
    try {
      await openRoom("Algebra");
      await waitFor(() =>
        expect(window.h.elements.map((element) => element.id)).toEqual([
          "installed-drawing",
        ]),
      );
      expect(
        updateScene.mock.calls.filter(([sceneData]) => sceneData?.appState),
      ).toEqual([]);
      expect(window.h.state.scrollX).toBe(120);
      expect(window.h.state.scrollY).toBe(80);
      expect(window.h.state.zoom.value).toBe(0.75);
    } finally {
      updateScene.mockRestore();
      startCollaboration.mockRestore();
      isCollaborating.mockRestore();
    }
  });
});
