import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  act,
  render,
  screen,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";
import { vi } from "vitest";
import { clear, createStore } from "idb-keyval";

import ExcalidrawApp from "../App";
import { appJotaiStore } from "../app-jotai";
import { offlineRoomPendingAtom } from "../collab/Collab";
import {
  clearRoomMemoryCache,
  flushRoomCache,
  readRoomDraft,
} from "../data/roomCache";

const { h } = window;

Object.defineProperty(window, "crypto", {
  value: {
    getRandomValues: (arr: number[]) =>
      arr.forEach((v, i) => (arr[i] = Math.floor(Math.random() * 256))),
    subtle: {
      importKey: async () => ({}),
      encrypt: async () => new ArrayBuffer(0),
      generateKey: () => {},
      exportKey: () => ({ k: "sTdLvMC_M3V8_vGa3UVRDg" }),
    },
  },
});

// Controllable socket mock: starts disconnected (offline boot); the test
// flips `connected` to simulate the network coming back.
const socketHolder: { socket: any } = { socket: null };
vi.mock("socket.io-client", () => {
  return {
    default: () => {
      const socket = {
        connected: false,
        close: () => {},
        on: () => {},
        once: () => {},
        off: () => {},
        emit: () => {},
      };
      socketHolder.socket = socket;
      return socket;
    },
  };
});

vi.mock("../data/roomFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/roomFiles")>()),
  downloadRoomFiles: async () => ({
    loadedFiles: [],
    erroredFiles: new Map(),
  }),
  uploadRoomFiles: async () => ({ savedFiles: [], erroredFiles: [] }),
}));

// loadRoomFromServer delegates to a swappable impl: fail-closed for the
// offline leg (same as a rejected fetch), canned snapshot for reconnect.
const loadHolder: { impl: (...args: any[]) => Promise<any> } = {
  impl: async () => null,
};
vi.mock("../data/rooms", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    registerRoom: async () => {},
    saveRoomToServer: async () => {},
    loadRoomFromServer: (...args: any[]) => loadHolder.impl(...args),
  };
});

const ROOM_ID = "offlinetestroom01";
const ROOM_KEY = "AaBbCcDdEeFfGgHhIiJjKk";

// Offline work persists as the room's draft, never as the personal canvas.
const expectSeedInRoomDraft = () =>
  waitFor(
    async () => {
      const draft = await readRoomDraft(ROOM_ID, ROOM_KEY);
      expect(draft?.map((element) => element.id)).toContain(
        "offline-seed-rect",
      );
      expect(localStorage.getItem("excalidraw") || "").not.toContain(
        "offline-seed-rect",
      );
    },
    { timeout: 5000 },
  );

const seedRect = {
  id: "offline-seed-rect",
  type: "rectangle",
  x: 50,
  y: 60,
  width: 120,
  height: 80,
  angle: 0,
  strokeColor: "#e03131",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: "a1",
  roundness: { type: 3 },
  seed: 42,
  version: 1,
  versionNonce: 7,
  isDeleted: false,
  boundElements: null,
  link: null,
  locked: false,
};

describe("offline-first rooms", () => {
  beforeEach(async () => {
    await flushRoomCache();
    clearRoomMemoryCache();
    await clear(createStore("excalidraw-rooms-db", "cache"));
  });

  it("offline boot preserves canvas, flags pending, merges on reconnect", async () => {
    window.location.hash = `#room=${ROOM_ID},${ROOM_KEY}`;

    await render(<ExcalidrawApp />);

    // fallback timer is short under tests: offline entry flags pending.
    await waitFor(
      () => {
        expect(appJotaiStore.get(offlineRoomPendingAtom)).toEqual({
          roomId: ROOM_ID,
          roomKey: ROOM_KEY,
        });
      },
      { timeout: 25000 },
    );

    expect(document.body.innerHTML).not.toMatch(/sync when|синхронизируются/);
    expect(document.body.innerHTML).not.toMatch(/No internet connection/);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Offline — waiting to sync changes",
    );

    // Draw offline: direct scene update (as the canvas would from strokes),
    // then confirm it reached the room draft.
    const { CaptureUpdateAction: CUA } = await import("@excalidraw/excalidraw");
    await act(async () => {
      API.updateScene({
        elements: [seedRect as any],
        captureUpdate: CUA.NEVER,
      } as any);
    });
    await expectSeedInRoomDraft();

    // Reconnect: socket alive + server snapshot with one element appears.
    socketHolder.socket.connected = true;
    loadHolder.impl = async () => {
      const blue = API.createElement({
        type: "rectangle",
        id: "server-blue-rect",
        x: 400,
        y: 300,
        width: 60,
        height: 60,
      });
      return [blue];
    };

    await act(async () => {
      await (window.collab as any).initializeRoom({
        fetchScene: true,
        roomLinkData: { roomId: ROOM_ID, roomKey: ROOM_KEY },
      });
    });

    const ids = h.elements.map((e: any) => e.id);
    expect(ids).toContain("offline-seed-rect");
    expect(ids).toContain("server-blue-rect");
    expect(appJotaiStore.get(offlineRoomPendingAtom)).toBeNull();
    await waitFor(() =>
      expect(
        screen.queryByText("Offline — waiting to sync changes"),
      ).not.toBeInTheDocument(),
    );

    localStorage.clear();
  }, 120000);

  it("failed load while offline never wipes the canvas", async () => {
    // server unreachable again for this leg (previous test left a canned
    // snapshot behind in the shared holder).
    loadHolder.impl = async () => null;
    window.location.hash = `#room=${ROOM_ID},${ROOM_KEY}`;
    appJotaiStore.set(offlineRoomPendingAtom, null);

    await render(<ExcalidrawApp />);
    await waitFor(
      () => {
        expect(appJotaiStore.get(offlineRoomPendingAtom)).toEqual({
          roomId: ROOM_ID,
          roomKey: ROOM_KEY,
        });
      },
      { timeout: 25000 },
    );

    const { CaptureUpdateAction: CUA } = await import("@excalidraw/excalidraw");
    await act(async () => {
      API.updateScene({
        elements: [seedRect as any],
        captureUpdate: CUA.NEVER,
      } as any);
    });
    await waitFor(() => {
      expect(
        (h.elements.map((e: any) => e.id) as string[]).includes(
          "offline-seed-rect",
        ),
      ).toBe(true);
    });

    // second failing load (still offline, socket dead): canvas must survive
    await act(async () => {
      await (window.collab as any).initializeRoom({
        fetchScene: true,
        roomLinkData: { roomId: ROOM_ID, roomKey: ROOM_KEY },
      });
    });

    expect(h.elements.map((e: any) => e.id)).toContain("offline-seed-rect");
    expect(appJotaiStore.get(offlineRoomPendingAtom)).toEqual({
      roomId: ROOM_ID,
      roomKey: ROOM_KEY,
    });
    // offline work reaches the room draft
    await expectSeedInRoomDraft();

    localStorage.clear();
  }, 120000);
});
