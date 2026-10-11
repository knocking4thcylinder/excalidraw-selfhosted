import { clear, createStore, get, set } from "idb-keyval";
import { vi } from "vitest";

import { STORAGE_KEYS } from "../app_constants";
import {
  loadLocalScene,
  readRoomBackup,
  saveLocalScene,
} from "../data/sceneStorage";

import type { SyncableExcalidrawElement } from "../data";

const store = createStore("excalidraw-scenes-db", "scenes");
const originalSetItem = localStorage.setItem.bind(localStorage);
const scene = {
  elements: JSON.stringify([{ id: "unsynced-stroke", version: 2 }]),
  appState: JSON.stringify({ viewBackgroundColor: "#ffffff" }),
};

beforeEach(async () => {
  await clear(store);
  localStorage.clear();
  await loadLocalScene(localStorage);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const simulateLocalQuota = () => {
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key === STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS) {
      throw new DOMException("Full", "QuotaExceededError");
    }
    originalSetItem(key, value);
  });
};

describe("scene storage quota recovery", () => {
  it("writes ordinary scenes synchronously so unload saves still work", async () => {
    const saving = saveLocalScene(localStorage, scene);
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe(
      scene.elements,
    );
    await saving;
  });
  it("keeps legacy scenes readable without a migration", async () => {
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, scene.elements);
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE, scene.appState);
    expect(await loadLocalScene(localStorage)).toEqual(scene);
  });

  it("falls back to IndexedDB when localStorage is full", async () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      '[{"id":"previous"}]',
    );
    localStorage.setItem("unrelated-setting", "keep");
    simulateLocalQuota();
    await saveLocalScene(localStorage, scene);
    expect(await loadLocalScene(localStorage)).toMatchObject(scene);
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
    ).toBeNull();
    expect(localStorage.getItem("unrelated-setting")).toBe("keep");
  });

  it("continues saving newer edits in IndexedDB after quota recovery", async () => {
    simulateLocalQuota();
    await saveLocalScene(localStorage, scene);
    vi.restoreAllMocks();
    const newer = { ...scene, elements: '[{"id":"newer-stroke"}]' };
    await saveLocalScene(localStorage, newer);
    expect(await loadLocalScene(localStorage)).toMatchObject(newer);
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS),
    ).toBeNull();
  });

  it("reads newer legacy edits from another tab instead of an older fallback", async () => {
    await set("canvas", { ...scene, updatedAt: 1 }, store);
    const newer = '[{"id":"other-tab"}]';
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, newer);
    localStorage.setItem(STORAGE_KEYS.VERSION_DATA_STATE, "2");
    expect((await loadLocalScene(localStorage)).elements).toBe(newer);
  });

  it("does not delete the original when the durable write fails", async () => {
    const previous = '[{"id":"previous"}]';
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS, previous);
    simulateLocalQuota();
    const blockedStore = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(() => {
        throw new DOMException("Full", "QuotaExceededError");
      });
    await expect(saveLocalScene(localStorage, scene)).rejects.toThrow();
    expect(localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS)).toBe(
      previous,
    );
    blockedStore.mockRestore();
  });
});

describe("legacy room backup", () => {
  const elements = [
    { id: "offline-stroke", version: 3 },
  ] as unknown as readonly SyncableExcalidrawElement[];

  it("migrates a legacy backup only after writing a durable copy", async () => {
    const backup = { roomId: "room-a", elements, updatedAt: 1 };
    localStorage.setItem("excalidraw-room-backup", JSON.stringify(backup));
    expect(await readRoomBackup(localStorage, "room-a")).toEqual(elements);
    expect(await get("excalidraw-room-backup", store)).toEqual(backup);
    expect(localStorage.getItem("excalidraw-room-backup")).toBeNull();
    expect(await readRoomBackup(localStorage, "room-b")).toBeNull();
  });

  it("keeps the legacy backup when migration fails", async () => {
    const raw = JSON.stringify({ roomId: "room-a", elements, updatedAt: 1 });
    localStorage.setItem("excalidraw-room-backup", raw);
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    expect(await readRoomBackup(localStorage, "room-a")).toEqual(elements);
    expect(localStorage.getItem("excalidraw-room-backup")).toBe(raw);
  });
});
