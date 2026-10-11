import { createStore, get, set } from "idb-keyval";

import { STORAGE_KEYS } from "../app_constants";

import type { SyncableExcalidrawElement } from "./index";

const sceneStore = createStore("excalidraw-scenes-db", "scenes");
const CANVAS_KEY = "canvas";
const ROOM_BACKUP_KEY = "excalidraw-room-backup";
let canvasUsesIndexedDB = false;

type LocalScene = {
  elements: string | null;
  appState: string | null;
};

type StoredScene = LocalScene & { updatedAt: number };

type RoomBackup = {
  roomId: string;
  elements: readonly SyncableExcalidrawElement[];
  updatedAt: number;
};

export const isStorageQuotaError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "QuotaExceededError";

export const loadLocalScene = async (storage: Storage): Promise<LocalScene> => {
  let stored: StoredScene | undefined;
  try {
    stored = await get<StoredScene>(CANVAS_KEY, sceneStore);
    canvasUsesIndexedDB = !!stored;
  } catch (error) {
    console.warn("IndexedDB scene load failed", error);
  }
  try {
    const elements = storage.getItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
    const appState = storage.getItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);
    const legacyVersion = Number(
      storage.getItem(STORAGE_KEYS.VERSION_DATA_STATE),
    );
    if (stored && (!elements || legacyVersion <= stored.updatedAt)) {
      return stored;
    }
    return { elements, appState };
  } catch (error) {
    if (stored) {
      return stored;
    }
    throw error;
  }
};

export const saveLocalScene = async (storage: Storage, scene: LocalScene) => {
  if (!canvasUsesIndexedDB) {
    try {
      storage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
        scene.elements ?? "[]",
      );
      storage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
        scene.appState ?? "{}",
      );
      return;
    } catch (error) {
      if (!isStorageQuotaError(error)) {
        throw error;
      }
    }
  }
  const record: StoredScene = { ...scene, updatedAt: Date.now() };
  await set(CANVAS_KEY, record, sceneStore);
  canvasUsesIndexedDB = true;
  storage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);
  storage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);
};

// Legacy single-slot backup of the last-edited room, superseded by per-room
// drafts (roomCache). Still read so a room last edited before drafts existed
// keeps its unsynced work; nothing writes it any more.
export const readRoomBackup = async (
  storage: Storage,
  roomId: string,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  let stored: RoomBackup | undefined;
  try {
    stored = await get<RoomBackup>(ROOM_BACKUP_KEY, sceneStore);
  } catch (error) {
    console.warn("IndexedDB room backup load failed", error);
  }
  try {
    const raw = storage.getItem(ROOM_BACKUP_KEY);
    const legacy = raw ? (JSON.parse(raw) as RoomBackup) : null;
    if (
      legacy &&
      typeof legacy.roomId === "string" &&
      Array.isArray(legacy.elements) &&
      (!stored || legacy.updatedAt > stored.updatedAt)
    ) {
      stored = legacy;
      try {
        await set(ROOM_BACKUP_KEY, legacy, sceneStore);
        if (storage.getItem(ROOM_BACKUP_KEY) === raw) {
          storage.removeItem(ROOM_BACKUP_KEY);
        }
      } catch (error) {
        console.warn(
          "Room backup migration failed; keeping the original",
          error,
        );
      }
    }
  } catch (error) {
    console.warn("Legacy room backup load failed", error);
  }
  return stored?.roomId === roomId && Array.isArray(stored.elements)
    ? stored.elements
    : null;
};
