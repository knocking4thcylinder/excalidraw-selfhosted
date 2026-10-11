import {
  createStore,
  del,
  delMany,
  get,
  getMany,
  keys,
  set,
  setMany,
} from "idb-keyval";
import { cloneJSON } from "@excalidraw/common";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import type { SyncableExcalidrawElement } from ".";

import type { RoomFolder, ServerRoomEntry } from "./rooms";

const cacheStore = createStore("excalidraw-rooms-db", "cache");
const MAX_CACHED_SCENES = 32;
const MAX_MEMORY_ROOMS = 8;
const MAX_MEMORY_FILE_BYTES = 16 * 1024 * 1024;

let pendingWrites = Promise.resolve();
const retiredDrafts = new Set<string>();
let persistedFiles = new WeakMap<
  BinaryFileData,
  { scope: string; snapshot: BinaryFileData }
>();

export type CachedRoomScene = {
  etag: string;
  elements: readonly SyncableExcalidrawElement[];
  syncVersion?: 1;
  patchCount?: number;
};

type RoomMemory = {
  scene?: CachedRoomScene;
  draft?: readonly SyncableExcalidrawElement[];
  files: Map<FileId, BinaryFileData>;
  fileBytes: number;
};

type RoomMeta = {
  generation: number;
  scene: number;
  draft: number;
  file: number;
};

const roomCacheKey = (kind: string, roomId: string, roomKey: string) =>
  JSON.stringify([kind, roomId, roomKey]);

const roomScopeKey = (roomId: string, roomKey: string) =>
  JSON.stringify([roomId, roomKey]);

const roomMemory = new Map<string, RoomMemory>();
const roomMeta = new Map<string, RoomMeta>();
let metaSequence = 0;
let memoryFileBytes = 0;

const getRoomMeta = (roomId: string, roomKey: string) => {
  const scope = roomScopeKey(roomId, roomKey);
  let meta = roomMeta.get(scope);
  if (!meta) {
    meta = { generation: 0, scene: 0, draft: 0, file: 0 };
    roomMeta.set(scope, meta);
  }
  return meta;
};

const bumpRoomMeta = (meta: RoomMeta, ...fields: (keyof RoomMeta)[]) => {
  const next = ++metaSequence;
  for (const field of fields) {
    meta[field] = next;
  }
};

const releaseRoomMemory = (scope: string) => {
  const memory = roomMemory.get(scope);
  if (!memory) {
    return;
  }
  memoryFileBytes -= memory.fileBytes;
  roomMemory.delete(scope);
};

const touchRoomMemory = (roomId: string, roomKey: string) => {
  const scope = roomScopeKey(roomId, roomKey);
  const resident = roomMemory.get(scope);
  if (resident) {
    roomMemory.delete(scope);
    roomMemory.set(scope, resident);
    return resident;
  }
  const memory: RoomMemory = { files: new Map(), fileBytes: 0 };
  roomMemory.set(scope, memory);
  while (roomMemory.size > MAX_MEMORY_ROOMS) {
    const oldest = roomMemory.keys().next().value;
    if (oldest === undefined || oldest === scope) {
      break;
    }
    releaseRoomMemory(oldest);
  }
  return memory;
};

const fileMemorySize = (file: BinaryFileData) =>
  (file.dataURL?.length ?? 0) * 2 + 512;

const trimFileMemory = () => {
  if (memoryFileBytes <= MAX_MEMORY_FILE_BYTES) {
    return;
  }
  for (const memory of roomMemory.values()) {
    if (!memory.fileBytes) {
      continue;
    }
    memoryFileBytes -= memory.fileBytes;
    memory.fileBytes = 0;
    memory.files.clear();
    if (memoryFileBytes <= MAX_MEMORY_FILE_BYTES) {
      return;
    }
  }
};

const storeFileMemory = (
  roomId: string,
  roomKey: string,
  file: BinaryFileData,
) => {
  const size = fileMemorySize(file);
  if (size > MAX_MEMORY_FILE_BYTES) {
    return;
  }
  const memory = touchRoomMemory(roomId, roomKey);
  const stored = memory.files.get(file.id);
  if (stored) {
    const previousSize = fileMemorySize(stored);
    memory.fileBytes -= previousSize;
    memoryFileBytes -= previousSize;
  }
  memory.files.set(file.id, file);
  memory.fileBytes += size;
  memoryFileBytes += size;
  trimFileMemory();
};

const readCache = async <Value>(key: string): Promise<Value | null> => {
  try {
    return (await get<Value>(key, cacheStore)) ?? null;
  } catch (error) {
    console.warn("Room cache unavailable", error);
    return null;
  }
};

const writeCache = (write: () => Promise<void>) => {
  pendingWrites = pendingWrites.then(write).catch((error) => {
    console.warn("Room cache write failed", error);
  });
  return pendingWrites;
};

const readCachedRoomField = async <Field extends "scene" | "draft">(
  kind: Field,
  roomId: string,
  roomKey: string,
): Promise<NonNullable<RoomMemory[Field]> | null> => {
  const meta = getRoomMeta(roomId, roomKey);
  const scope = roomScopeKey(roomId, roomKey);
  const resident = roomMemory.get(scope);
  const cached = resident?.[kind];
  if (cached) {
    touchRoomMemory(roomId, roomKey);
    return cloneJSON(cached);
  }
  const stamp = meta[kind];
  await pendingWrites;
  const persisted = await readCache<NonNullable<RoomMemory[Field]>>(
    roomCacheKey(kind, roomId, roomKey),
  );
  if (meta[kind] !== stamp) {
    const live = roomMemory.get(scope)?.[kind];
    return live ? cloneJSON(live) : null;
  }
  if (!persisted) {
    return null;
  }
  touchRoomMemory(roomId, roomKey)[kind] = persisted;
  return cloneJSON(persisted);
};

export const readCachedRoomScene = (
  roomId: string,
  roomKey: string,
): Promise<CachedRoomScene | null> =>
  readCachedRoomField("scene", roomId, roomKey);

export const cacheRoomScene = (
  roomId: string,
  roomKey: string,
  scene: CachedRoomScene,
) => {
  const key = roomCacheKey("scene", roomId, roomKey);
  retiredDrafts.delete(roomCacheKey("draft", roomId, roomKey));
  const record = cloneJSON(scene);
  const meta = getRoomMeta(roomId, roomKey);
  bumpRoomMeta(meta, "generation", "scene");
  touchRoomMemory(roomId, roomKey).scene = record;
  return writeCache(async () => {
    await set(key, record, cacheStore);
    const previous = (await get<string[]>("scene-index", cacheStore)) ?? [];
    const index = [key, ...previous.filter((entry) => entry !== key)];
    await set("scene-index", index.slice(0, MAX_CACHED_SCENES), cacheStore);
    for (const expired of index.slice(MAX_CACHED_SCENES)) {
      const [, expiredRoomId, expiredRoomKey] = JSON.parse(expired) as string[];
      const expiredMeta = getRoomMeta(expiredRoomId, expiredRoomKey);
      const resident = roomMemory.get(
        roomScopeKey(expiredRoomId, expiredRoomKey),
      );
      // A draft without its baseline would be merged as a plain union and
      // resurrect shapes removed elsewhere, so it leaves with the scene
      // unless it still holds unsynced changes.
      const draftKey = roomCacheKey("draft", expiredRoomId, expiredRoomKey);
      const expiredScene =
        resident?.scene ?? (await get<CachedRoomScene>(expired, cacheStore));
      const draft =
        resident?.draft ??
        (await get<readonly SyncableExcalidrawElement[]>(draftKey, cacheStore));
      const draftSynced =
        !!draft &&
        !!expiredScene &&
        getRoomChanges(expiredScene.elements, draft).length === 0;
      bumpRoomMeta(
        expiredMeta,
        "generation",
        "scene",
        ...(draftSynced ? (["draft"] as const) : []),
      );
      if (resident) {
        delete resident.scene;
        if (draftSynced) {
          delete resident.draft;
        }
      }
      await del(expired, cacheStore);
      if (draftSynced) {
        await del(draftKey, cacheStore);
      }
    }
  });
};

const purgeSceneRecord = (roomId: string, roomKey: string) =>
  writeCache(async () => {
    const key = roomCacheKey("scene", roomId, roomKey);
    await del(key, cacheStore);
    const index = (await get<string[]>("scene-index", cacheStore)) ?? [];
    await set(
      "scene-index",
      index.filter((entry) => entry !== key),
      cacheStore,
    );
  });

export const invalidateCachedRoomScene = (roomId: string, roomKey: string) => {
  const meta = getRoomMeta(roomId, roomKey);
  bumpRoomMeta(meta, "generation", "scene");
  const resident = roomMemory.get(roomScopeKey(roomId, roomKey));
  if (resident) {
    delete resident.scene;
  }
  return purgeSceneRecord(roomId, roomKey);
};

export const readRoomDraft = (
  roomId: string,
  roomKey: string,
): Promise<readonly SyncableExcalidrawElement[] | null> =>
  readCachedRoomField("draft", roomId, roomKey);

export const saveRoomDraft = (
  roomId: string,
  roomKey: string,
  elements: readonly SyncableExcalidrawElement[],
) => {
  const key = roomCacheKey("draft", roomId, roomKey);
  const record = cloneJSON(elements);
  if (!retiredDrafts.has(key)) {
    const meta = getRoomMeta(roomId, roomKey);
    bumpRoomMeta(meta, "generation", "draft");
    touchRoomMemory(roomId, roomKey).draft = record;
  }
  return writeCache(async () => {
    if (!retiredDrafts.has(key)) {
      await set(key, record, cacheStore);
    }
  });
};

export const deleteRoomDraft = (roomId: string, roomKey: string) => {
  const meta = getRoomMeta(roomId, roomKey);
  bumpRoomMeta(meta, "generation", "draft");
  const resident = roomMemory.get(roomScopeKey(roomId, roomKey));
  if (resident) {
    delete resident.draft;
  }
  return writeCache(() =>
    del(roomCacheKey("draft", roomId, roomKey), cacheStore),
  );
};

const roomFileKey = (roomId: string, roomKey: string, fileId: FileId) =>
  JSON.stringify(["file", roomId, roomKey, fileId]);

export const readCachedRoomFiles = async (
  roomId: string,
  roomKey: string,
  fileIds: readonly FileId[],
): Promise<BinaryFileData[]> => {
  const meta = getRoomMeta(roomId, roomKey);
  const scope = roomScopeKey(roomId, roomKey);
  const unique = [...new Set(fileIds)];
  const resident = roomMemory.get(scope);
  const hits: BinaryFileData[] = [];
  const missing: FileId[] = [];
  if (resident) {
    touchRoomMemory(roomId, roomKey);
    for (const fileId of unique) {
      const file = resident.files.get(fileId);
      if (file) {
        hits.push(cloneJSON(file));
      } else {
        missing.push(fileId);
      }
    }
  } else {
    missing.push(...unique);
  }
  if (!missing.length) {
    return hits;
  }
  const stamp = meta.file;
  await pendingWrites;
  let persisted: BinaryFileData[] = [];
  try {
    const files = await getMany<BinaryFileData>(
      missing.map((fileId) => roomFileKey(roomId, roomKey, fileId)),
      cacheStore,
    );
    persisted = files.filter((file): file is BinaryFileData => !!file);
  } catch (error) {
    console.warn("Room file cache unavailable", error);
    return hits;
  }
  if (meta.file !== stamp) {
    const live = roomMemory.get(scope);
    return unique.flatMap((fileId) => {
      const file = live?.files.get(fileId);
      return file ? [cloneJSON(file)] : [];
    });
  }
  for (const file of persisted) {
    storeFileMemory(roomId, roomKey, file);
  }
  return [...hits, ...persisted.map((file) => cloneJSON(file))];
};

export const cacheRoomFiles = (
  roomId: string,
  roomKey: string,
  files: readonly BinaryFileData[],
) => {
  const scope = roomCacheKey("file", roomId, roomKey);
  const draftKey = roomCacheKey("draft", roomId, roomKey);
  const changed = files.filter((file) => {
    const previous = persistedFiles.get(file);
    return (
      previous?.scope !== scope ||
      Object.keys(file).some(
        (key) =>
          file[key as keyof BinaryFileData] !==
          previous.snapshot[key as keyof BinaryFileData],
      ) ||
      Object.keys(previous.snapshot).length !== Object.keys(file).length
    );
  });
  const records = changed.length ? cloneJSON(changed) : [];
  const recordById = new Map(records.map((file) => [file.id, file]));
  if (!retiredDrafts.has(draftKey)) {
    let stored = false;
    for (const file of files) {
      const record = recordById.get(file.id);
      if (record) {
        storeFileMemory(roomId, roomKey, record);
        stored = true;
      } else if (
        !roomMemory.get(roomScopeKey(roomId, roomKey))?.files.has(file.id)
      ) {
        storeFileMemory(roomId, roomKey, cloneJSON(file));
        stored = true;
      }
    }
    if (stored) {
      bumpRoomMeta(getRoomMeta(roomId, roomKey), "file");
    }
  }
  if (!changed.length) {
    return pendingWrites;
  }
  return writeCache(async () => {
    if (!records.length || retiredDrafts.has(draftKey)) {
      return;
    }
    await setMany(
      records.map((file) => [roomFileKey(roomId, roomKey, file.id), file]),
      cacheStore,
    );
    changed.forEach((file, index) => {
      persistedFiles.set(file, { scope, snapshot: records[index] });
    });
  });
};

export const forgetCachedRoom = async (roomId: string, roomKey: string) => {
  const draftKey = roomCacheKey("draft", roomId, roomKey);
  retiredDrafts.add(draftKey);
  const meta = getRoomMeta(roomId, roomKey);
  bumpRoomMeta(meta, "generation", "scene", "draft", "file");
  releaseRoomMemory(roomScopeKey(roomId, roomKey));
  const clearing = writeCache(async () => {
    const prefix = `${JSON.stringify(["file", roomId, roomKey]).slice(0, -1)},`;
    const fileKeys = (await keys(cacheStore)).filter(
      (key) => typeof key === "string" && key.startsWith(prefix),
    );
    await delMany(fileKeys, cacheStore);
    persistedFiles = new WeakMap();
  });
  const scene = purgeSceneRecord(roomId, roomKey);
  const draft = writeCache(() => del(draftKey, cacheStore));
  await Promise.all([clearing, scene, draft]);
};

export const readCachedRooms = () => readCache<ServerRoomEntry[]>("rooms");
export const readCachedFolders = () => readCache<RoomFolder[]>("folders");

export const cacheRooms = (rooms: ServerRoomEntry[]) => {
  const record = cloneJSON(rooms);
  return writeCache(() => set("rooms", record, cacheStore));
};

export const cacheFolders = (folders: RoomFolder[]) => {
  const record = cloneJSON(folders);
  return writeCache(() => set("folders", record, cacheStore));
};

export const flushRoomCache = () => pendingWrites;

export const getRoomCacheGeneration = (roomId: string, roomKey: string) =>
  roomMeta.get(roomScopeKey(roomId, roomKey))?.generation ?? 0;

export const getRoomFileCacheGeneration = (roomId: string, roomKey: string) =>
  roomMeta.get(roomScopeKey(roomId, roomKey))?.file ?? 0;

export const clearRoomMemoryCache = () => {
  roomMemory.clear();
  memoryFileBytes = 0;
  const next = ++metaSequence;
  for (const meta of roomMeta.values()) {
    meta.generation = next;
    meta.scene = next;
    meta.draft = next;
    meta.file = next;
  }
};

export const getRoomChanges = (
  baseline: readonly SyncableExcalidrawElement[],
  current: readonly SyncableExcalidrawElement[],
) => {
  const previous = new Map(baseline.map((element) => [element.id, element]));
  return current.filter((element) => {
    const original = previous.get(element.id);
    return (
      !original ||
      original.version !== element.version ||
      original.versionNonce !== element.versionNonce ||
      original.isDeleted !== element.isDeleted
    );
  });
};
