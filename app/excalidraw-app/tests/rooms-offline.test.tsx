import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { act, render, waitFor } from "@excalidraw/excalidraw/tests/test-utils";
import { vi } from "vitest";

import ExcalidrawApp from "../App";
import { appJotaiStore } from "../app-jotai";
import { offlineRoomPendingAtom } from "../collab/Collab";

const { h } = window;

Object.defineProperty(window, "crypto", {
  value: {
    getRandomValues: (arr: number[]) =>
      arr.forEach((v, i) => (arr[i] = Math.floor(Math.random() * 256))),
    subtle: {
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

vi.mock("../../excalidraw-app/data/firebase.ts", () => {
  const loadFromFirebase = async () => null;
  const saveToFirebase = () => {};
  const isSavedToFirebase = () => true;
  const loadFilesFromFirebase = async () => ({
    loadedFiles: [],
    erroredFiles: [] as never[],
  });
  const saveFilesToFirebase = async () => ({
    savedFiles: [],
    erroredFiles: new Map(),
  });

  return {
    loadFromFirebase,
    saveToFirebase,
    isSavedToFirebase,
    loadFilesFromFirebase,
    saveFilesToFirebase,
  };
});

// loadRoomFromServer delegates to a swappable impl: fail-closed for the
// offline leg (same as a rejected fetch), canned snapshot for reconnect.
const loadHolder: { impl: (...args: any[]) => Promise<any> } = {
  impl: async () => null,
};
vi.mock("../data/rooms", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    loadRoomFromServer: (...args: any[]) => loadHolder.impl(...args),
  };
});

const ROOM_ID = "offlinetestroom01";
const ROOM_KEY = "AaBbCcDdEeFfGgHhIiJjKk";

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
  it("offline boot preserves canvas, flags pending, merges on reconnect", async () => {
    window.location.hash = `#room=${ROOM_ID},${ROOM_KEY}`;

    await render(<ExcalidrawApp />);

    // fallback timer is short under tests: offline entry flags pending and
    // shows the pending banner.
    await waitFor(
      () => {
        expect(appJotaiStore.get(offlineRoomPendingAtom)).toEqual({
          roomId: ROOM_ID,
          roomKey: ROOM_KEY,
        });
      },
      { timeout: 25000 },
    );

    expect(document.body.innerHTML).toMatch(/sync when|синхронизируются/);

    // Draw offline: direct scene update (as the canvas would from strokes),
    // then confirm it reached local persistence.
    const { CaptureUpdateAction: CUA } = await import("@excalidraw/excalidraw");
    await act(async () => {
      API.updateScene({
        elements: [seedRect as any],
        captureUpdate: CUA.NEVER,
      } as any);
    });
    await waitFor(() => {
      expect(localStorage.getItem("excalidraw") || "").toContain(
        "offline-seed-rect",
      );
    });

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

    localStorage.clear();
  }, 120000);

  it("failed load while offline never wipes the canvas", async () => {
    // server unreachable again for this leg (previous test left a canned
    // snapshot behind in the shared holder).
    loadHolder.impl = async () => null;

    await render(<ExcalidrawApp />);

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
    // offline work reaches local persistence
    await waitFor(() => {
      expect(localStorage.getItem("excalidraw") || "").toContain(
        "offline-seed-rect",
      );
    });

    localStorage.clear();
  }, 120000);
});
