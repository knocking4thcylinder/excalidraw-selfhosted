import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { t } from "@excalidraw/excalidraw/i18n";
import { getSceneVersion } from "@excalidraw/element";
import { cloneJSON } from "@excalidraw/common";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  cacheFolders,
  cacheRooms,
  cacheRoomScene,
  clearRoomMemoryCache,
  forgetCachedRoom,
  invalidateCachedRoomScene,
  readCachedRoomScene,
} from "./roomCache";

import { applyScenePatch, createScenePatch } from "./scenePatch";

import { getSyncableElements } from ".";

import type { Socket } from "socket.io-client";

import type { SyncableExcalidrawElement } from ".";
import type { CachedRoomScene } from "./roomCache";

const roomCacheGenerations = new Map<string, number>();
const pendingSceneSaves = new WeakMap<Socket, Promise<void>>();
const sceneSaveEpochs = new WeakMap<Socket, number>();
const socketSceneBaselines = new WeakMap<
  Socket,
  { cacheKey: string; scene: CachedRoomScene | null }
>();
const roomSyncCapabilities = new Set<string>();

const syncMetadata = (response: Response) =>
  response.headers.get("x-scene-sync") === "1"
    ? {
        syncVersion: 1 as const,
        patchCount: Number(response.headers.get("x-scene-patches") || 0),
      }
    : {};

const decodeScenePayload = async (
  data: { iv: string; ciphertext: string },
  roomKey: string,
): Promise<unknown> => {
  if (typeof data?.iv !== "string" || typeof data?.ciphertext !== "string") {
    throw new Error("Invalid room snapshot");
  }
  const decrypted = await decryptData(
    fromBase64(data.iv) as Uint8Array<ArrayBuffer>,
    fromBase64(data.ciphertext).buffer as ArrayBuffer,
    roomKey,
  );
  return JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted)));
};

export const clearRoomSceneCache = () => {
  roomSyncCapabilities.clear();
  clearRoomMemoryCache();
};

// "My Rooms" registry + encrypted scene snapshots on the self-hosted shortcode
// service (see /api/rooms endpoints). Server never sees plaintext: the room
// key travels only as request body/query param, same trust model as
// /api/resolve which stores full URLs incl. keys.
//
// Error policy: register/save failures are console-only and must never block
// collab; load returns null on any failure so the caller falls back to live
// socket sync.

export type ServerRoomEntry = {
  roomId: string;
  key: string;
  createdAt: number;
  lastActiveAt: number;
  hasScene: boolean;
  // optional display label (rename feature v2); roomId/key stay stable
  name?: string;
  folderId?: string;
};

export type RoomFolder = {
  id: string;
  name: string;
  parentId?: string | null;
};

export const fetchRoomFolders = async (
  signal?: AbortSignal,
): Promise<RoomFolder[] | null> => {
  try {
    const response = await fetch("/api/rooms/folders", {
      cache: "no-store",
      signal,
    });
    const data = response.ok ? await response.json() : null;
    if (Array.isArray(data?.folders)) {
      void cacheFolders(data.folders);
      return data.folders;
    }
    return null;
  } catch {
    return null;
  }
};

export const saveRoomFolder = async (
  name: string,
  id?: string,
  parentId?: string | null,
): Promise<RoomFolder | null> => {
  try {
    const response = await fetch(
      `/api/rooms/folders${id ? `/${encodeURIComponent(id)}` : ""}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parentId }),
      },
    );
    return response.ok ? (await response.json()).folder : null;
  } catch {
    return null;
  }
};

export const deleteRoomFolder = async (id: string): Promise<boolean> => {
  try {
    return (
      await fetch(`/api/rooms/folders/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
    ).ok;
  } catch {
    return false;
  }
};

export const moveRoomToFolder = async (
  room: ServerRoomEntry,
  folderId: string | null,
): Promise<boolean> => {
  try {
    return (
      await fetch(`/api/rooms/${encodeURIComponent(room.roomId)}/folder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: room.key, folderId }),
      })
    ).ok;
  } catch {
    return false;
  }
};

// private
// -----------------------------------------------------------------------------

const toBase64 = (buffer: ArrayBuffer | Uint8Array): string => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return window.btoa(binary);
};

const fromBase64 = (base64: string): Uint8Array =>
  Uint8Array.from(window.atob(base64), (c) => c.charCodeAt(0));

// mirror of FirebaseSceneVersionCache in ./firebase.ts, so we don't re-save
// unchanged scenes (and don't count them as unsaved in beforeUnload)
class ServerSceneVersionCache {
  private static cache = new WeakMap<
    Socket,
    { version: number; fingerprint: string }
  >();
  static fingerprint = (elements: readonly ExcalidrawElement[]) =>
    JSON.stringify(
      elements.map((element) => [
        element.id,
        element.version,
        element.versionNonce,
        element.isDeleted,
        element.index,
      ]),
    );
  static get = (socket: Socket) => {
    return ServerSceneVersionCache.cache.get(socket);
  };
  static invalidate = (socket: Socket) =>
    ServerSceneVersionCache.cache.delete(socket);
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    ServerSceneVersionCache.cache.set(socket, {
      version: getSceneVersion(elements),
      fingerprint: ServerSceneVersionCache.fingerprint(elements),
    });
  };
}

// -----------------------------------------------------------------------------

export const registerRoom = async (
  roomId: string,
  roomKey: string,
): Promise<void> => {
  try {
    const resp = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ roomId, roomKey }),
    });
    if (!resp.ok) {
      console.error(t("myRooms.registerError"), resp.status);
    }
  } catch (error: any) {
    console.error(t("myRooms.registerError"), error);
  }
};

export const fetchRooms = async (
  signal?: AbortSignal,
): Promise<ServerRoomEntry[] | null> => {
  try {
    const resp = await fetch("/api/rooms", { cache: "no-store", signal });
    if (!resp.ok) {
      return null;
    }
    const data = await resp.json();
    if (Array.isArray(data?.rooms)) {
      void cacheRooms(data.rooms);
      return data.rooms;
    }
    return null;
  } catch {
    return null;
  }
};

// rename sets a display label only; empty name clears it (server trims).
// Never throws — the caller refreshes the list / logs on false.
export const renameRoom = async (
  roomId: string,
  roomKey: string,
  name: string,
): Promise<boolean> => {
  try {
    const resp = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ key: roomKey, name }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
};

// removes the registry entry AND the stored scene. Never throws.
export const deleteRoom = async (
  roomId: string,
  roomKey: string,
): Promise<boolean> => {
  try {
    const resp = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ key: roomKey }),
    });
    if (resp.ok) {
      const cacheKey = JSON.stringify([roomId, roomKey]);
      roomCacheGenerations.set(
        cacheKey,
        (roomCacheGenerations.get(cacheKey) ?? 0) + 1,
      );
      await forgetCachedRoom(roomId, roomKey);
    }
    return resp.ok;
  } catch {
    return false;
  }
};

export const isSavedToServer = (
  portal: {
    roomId: string | null;
    roomKey: string | null;
    socket: Socket | null;
  },
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    const saved = ServerSceneVersionCache.get(portal.socket);
    return (
      saved?.version === sceneVersion &&
      saved.fingerprint === ServerSceneVersionCache.fingerprint(elements)
    );
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

type RoomPortal = {
  roomId: string | null;
  roomKey: string | null;
  socket: Socket | null;
};

type SaveRoomOptions = {
  onConflict?: (
    elements: readonly SyncableExcalidrawElement[],
    baseline: readonly SyncableExcalidrawElement[],
  ) => void;
};

export const saveRoomToServer = (
  portal: RoomPortal,
  elements: readonly SyncableExcalidrawElement[],
  options?: SaveRoomOptions,
): Promise<void> => {
  const capturedPortal = { ...portal };
  const socket = capturedPortal.socket;
  if (!socket) {
    return Promise.resolve();
  }
  const snapshot = cloneJSON(elements);
  const cacheKey = JSON.stringify([
    capturedPortal.roomId,
    capturedPortal.roomKey,
  ]);
  const generation = roomCacheGenerations.get(cacheKey) ?? 0;
  const epoch = sceneSaveEpochs.get(socket) ?? 0;
  const previous = pendingSceneSaves.get(socket) ?? Promise.resolve();
  const saving = previous.then(() =>
    saveRoomSnapshot(capturedPortal, snapshot, generation, epoch, options),
  );
  pendingSceneSaves.set(socket, saving);
  return saving;
};

const saveRoomSnapshot = async (
  portal: {
    roomId: string | null;
    roomKey: string | null;
    socket: Socket | null;
  },
  elements: readonly SyncableExcalidrawElement[],
  generation: number,
  epoch: number,
  options?: SaveRoomOptions,
): Promise<void> => {
  try {
    const { roomId, roomKey, socket } = portal;
    if (
      // bail if no room exists as there's nothing we can do at this point
      !roomId ||
      !roomKey ||
      !socket ||
      epoch !== (sceneSaveEpochs.get(socket) ?? 0) ||
      isSavedToServer(portal, elements)
    ) {
      return;
    }
    const cacheKey = JSON.stringify([roomId, roomKey]);
    if (generation !== (roomCacheGenerations.get(cacheKey) ?? 0)) {
      return;
    }
    const sessionBaseline = socketSceneBaselines.get(socket);
    const baseline =
      sessionBaseline?.cacheKey === cacheKey
        ? sessionBaseline.scene
        : await readCachedRoomScene(roomId, roomKey);
    socketSceneBaselines.set(socket, { cacheKey, scene: baseline });
    const isCurrentRoom = () =>
      generation === (roomCacheGenerations.get(cacheKey) ?? 0);

    // Anti-clobber guard (incident 2026-09-11): after a server restart or
    // service churn, fresh joins initialize an empty scene and the regular
    // autosave would permanently overwrite the good snapshot with it.
    // Never overwrite a stored snapshot with an empty scene — a room is
    // cleared for real via delete, not by saving blank. The GET only happens
    // on the rare empty-save path, so it costs nothing in normal operation.
    if (elements.length === 0) {
      try {
        const probe = await fetch(
          `/api/rooms/${encodeURIComponent(
            roomId,
          )}/scene?key=${encodeURIComponent(roomKey)}`,
          { method: "HEAD", cache: "no-store" },
        );
        if (probe.ok) {
          console.warn(
            "rooms: refusing to overwrite stored snapshot with empty scene",
          );
          return;
        }
      } catch {
        // probe failed — fall through and let the save attempt report itself
      }
    }

    const fullJSON = JSON.stringify(elements);
    const fullEncoded = new TextEncoder().encode(fullJSON);
    if (
      4 * Math.ceil((fullEncoded.byteLength + 16) / 3) + 512 + roomKey.length >
      5 * 1024 * 1024
    ) {
      throw new Error("Room checkpoint exceeds the 5 MiB request limit");
    }
    const patch =
      baseline?.syncVersion === 1
        ? createScenePatch(baseline.elements, elements)
        : null;
    const patchJSON = patch ? JSON.stringify(patch) : null;
    if (
      patch &&
      !patch.upserts.length &&
      !patch.removedIds.length &&
      !patch.order
    ) {
      ServerSceneVersionCache.set(socket, elements);
      return;
    }
    let usePatch =
      !!patchJSON &&
      (baseline?.patchCount ?? 0) < 32 &&
      patchJSON.length < fullJSON.length * 0.6;
    const send = async () => {
      const { encryptedBuffer, iv } = await encryptData(
        roomKey,
        usePatch ? new TextEncoder().encode(patchJSON!) : fullEncoded,
      );
      if (!isCurrentRoom()) {
        return null;
      }
      const body = JSON.stringify({
        key: roomKey,
        iv: toBase64(iv),
        ciphertext: toBase64(encryptedBuffer),
        sceneVersion: getSceneVersion(elements),
        // lets the server enforce its no-empty-overwrite invariant
        isEmpty: elements.length === 0,
        ...(baseline?.syncVersion === 1 || roomSyncCapabilities.has(cacheKey)
          ? { syncVersion: 1, baseEtag: baseline?.etag ?? null }
          : {}),
      });
      return fetch(`/api/rooms/${encodeURIComponent(roomId)}/scene`, {
        method: usePatch ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        keepalive: body.length <= 60 * 1024,
        body,
      });
    };
    let resp = await send();
    if (resp?.status === 413 && usePatch) {
      usePatch = false;
      resp = await send();
    }
    if (!resp || !isCurrentRoom()) {
      return;
    }

    if (resp.ok) {
      ServerSceneVersionCache.set(socket, elements);
      const etag = resp.headers.get("etag");
      if (etag) {
        const confirmed: CachedRoomScene = {
          etag,
          elements,
          ...syncMetadata(resp),
        };
        socketSceneBaselines.set(socket, { cacheKey, scene: confirmed });
        await cacheRoomScene(roomId, roomKey, confirmed);
      }
    } else if (resp.status === 412) {
      try {
        if (options?.onConflict) {
          const latest = await loadRoomFromServer(roomId, roomKey, socket, {
            throwOnError: true,
          });
          ServerSceneVersionCache.invalidate(socket);
          sceneSaveEpochs.set(socket, (sceneSaveEpochs.get(socket) ?? 0) + 1);
          if (latest && isCurrentRoom()) {
            options.onConflict(latest, baseline?.elements ?? []);
          }
        } else {
          sceneSaveEpochs.set(socket, (sceneSaveEpochs.get(socket) ?? 0) + 1);
          console.warn("rooms: scene changed before save");
        }
      } catch (error) {
        sceneSaveEpochs.set(socket, (sceneSaveEpochs.get(socket) ?? 0) + 1);
        throw error;
      }
    } else {
      console.error("rooms: scene save failed", resp.status);
    }
  } catch (error: any) {
    console.error("rooms: scene save failed", error);
  }
};

export const loadRoomFromServer = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
  options?: {
    signal?: AbortSignal;
    throwOnError?: boolean;
    onProgress?: () => void;
  },
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const cacheKey = JSON.stringify([roomId, roomKey]);
  const generation = roomCacheGenerations.get(cacheKey) ?? 0;
  const cached = await readCachedRoomScene(roomId, roomKey);
  try {
    const resp = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/scene?key=${encodeURIComponent(
        roomKey,
      )}&sync=1${
        cached?.syncVersion === 1
          ? `&since=${encodeURIComponent(cached.etag)}`
          : ""
      }`,
      {
        cache: "no-store",
        signal: options?.signal,
        headers: cached ? { "If-None-Match": cached.etag } : undefined,
      },
    );
    if (resp.headers.get("x-scene-sync") === "1") {
      roomSyncCapabilities.add(cacheKey);
    } else {
      roomSyncCapabilities.delete(cacheKey);
    }
    if (
      options?.signal?.aborted ||
      generation !== (roomCacheGenerations.get(cacheKey) ?? 0)
    ) {
      return null;
    }
    if (resp.status === 304 && cached) {
      const confirmed: CachedRoomScene = {
        etag: cached.etag,
        elements: cached.elements,
        ...syncMetadata(resp),
      };
      await cacheRoomScene(roomId, roomKey, confirmed);
      const elements = cloneJSON(cached.elements);
      if (socket) {
        ServerSceneVersionCache.set(socket, elements);
        socketSceneBaselines.set(socket, { cacheKey, scene: confirmed });
      }
      return elements;
    }
    if (!resp.ok) {
      if (resp.status === 404 && socket) {
        socketSceneBaselines.set(socket, { cacheKey, scene: null });
      }
      if (resp.status === 404 || resp.status === 403) {
        await invalidateCachedRoomScene(roomId, roomKey);
      }
      if (options?.throwOnError && resp.status !== 404) {
        throw new Error(`Room snapshot request failed (${resp.status})`);
      }
      // 404 (no scene) and any other status are "no scene" — the caller falls
      // through to live socket sync
      return null;
    }
    let data;
    if (options?.onProgress && resp.body) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunks.push(decoder.decode(value, { stream: true }));
          if (value.byteLength) {
            options.onProgress();
          }
        }
        chunks.push(decoder.decode());
        data = JSON.parse(chunks.join(""));
      } finally {
        reader.releaseLock();
      }
    } else {
      data = await resp.json();
    }
    let decodedData: unknown;
    let previousEtag: string | undefined;
    if (data.syncVersion === 1 && !data.iv) {
      if (
        !cached ||
        data.baseEtag !== cached.etag ||
        !Array.isArray(data.patches) ||
        !data.patches.length
      ) {
        throw new Error("Invalid room patch baseline");
      }
      decodedData = cloneJSON(cached.elements);
      previousEtag = cached.etag;
    } else {
      decodedData = await decodeScenePayload(data, roomKey);
      previousEtag = data.checkpointEtag;
    }
    if (!Array.isArray(decodedData)) {
      throw new Error("Invalid room snapshot");
    }
    if (data.syncVersion === 1) {
      if (!Array.isArray(data.patches) || data.patches.length > 32) {
        throw new Error("Invalid room patch chain");
      }
      for (const patch of data.patches) {
        if (patch.baseEtag !== previousEtag || typeof patch.etag !== "string") {
          throw new Error("Invalid room patch chain");
        }
        decodedData = applyScenePatch(
          decodedData as readonly SyncableExcalidrawElement[],
          await decodeScenePayload(patch, roomKey),
        );
        previousEtag = patch.etag;
      }
      if (previousEtag !== resp.headers.get("etag")) {
        throw new Error("Invalid room patch validator");
      }
    }
    const elements = getSyncableElements(
      restoreElements(decodedData as readonly ExcalidrawElement[], null, {
        deleteInvisibleElements: true,
      }),
    );

    if (
      options?.signal?.aborted ||
      generation !== (roomCacheGenerations.get(cacheKey) ?? 0)
    ) {
      return null;
    }
    if (socket) {
      ServerSceneVersionCache.set(socket, elements);
    }

    const etag = resp.headers.get("etag");
    if (
      etag &&
      !options?.signal?.aborted &&
      generation === (roomCacheGenerations.get(cacheKey) ?? 0)
    ) {
      const confirmed: CachedRoomScene = {
        etag,
        elements,
        ...syncMetadata(resp),
      };
      if (socket) {
        socketSceneBaselines.set(socket, { cacheKey, scene: confirmed });
      }
      await cacheRoomScene(roomId, roomKey, confirmed);
    }

    return elements;
  } catch (error) {
    if (options?.throwOnError) {
      throw error;
    }
    return null;
  }
};
