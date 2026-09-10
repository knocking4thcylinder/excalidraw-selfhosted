import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { t } from "@excalidraw/excalidraw/i18n";
import { getSceneVersion } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { getSyncableElements } from ".";

import type { Socket } from "socket.io-client";

import type { SyncableExcalidrawElement } from ".";

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
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return ServerSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    ServerSceneVersionCache.cache.set(socket, getSceneVersion(elements));
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

export const fetchRooms = async (): Promise<ServerRoomEntry[] | null> => {
  try {
    const resp = await fetch("/api/rooms", { cache: "no-store" });
    if (!resp.ok) {
      return null;
    }
    const data = await resp.json();
    return Array.isArray(data?.rooms) ? data.rooms : null;
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

    return ServerSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveRoomToServer = async (
  portal: {
    roomId: string | null;
    roomKey: string | null;
    socket: Socket | null;
  },
  elements: readonly SyncableExcalidrawElement[],
): Promise<void> => {
  try {
    const { roomId, roomKey, socket } = portal;
    if (
      // bail if no room exists as there's nothing we can do at this point
      !roomId ||
      !roomKey ||
      !socket ||
      isSavedToServer(portal, elements)
    ) {
      return;
    }

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
          { cache: "no-store" },
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

    // encrypt exactly like firebase.ts encryptElements
    const json = JSON.stringify(elements);
    const encoded = new TextEncoder().encode(json);
    const { encryptedBuffer, iv } = await encryptData(roomKey, encoded);

    const resp = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/scene`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        key: roomKey,
        iv: toBase64(iv),
        ciphertext: toBase64(encryptedBuffer),
        sceneVersion: getSceneVersion(elements),
        // lets the server enforce its no-empty-overwrite invariant
        isEmpty: elements.length === 0,
      }),
    });

    if (resp.ok) {
      ServerSceneVersionCache.set(socket, elements);
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
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  try {
    const resp = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/scene?key=${encodeURIComponent(
        roomKey,
      )}`,
      { cache: "no-store" },
    );
    if (!resp.ok) {
      // 404 (no scene) and any other status are "no scene" — the caller falls
      // through to live socket sync
      return null;
    }
    const data = await resp.json();
    if (typeof data?.iv !== "string" || typeof data?.ciphertext !== "string") {
      return null;
    }

    const decrypted = await decryptData(
      fromBase64(data.iv) as Uint8Array<ArrayBuffer>,
      fromBase64(data.ciphertext).buffer as ArrayBuffer,
      roomKey,
    );
    const decodedData = new TextDecoder("utf-8").decode(
      new Uint8Array(decrypted),
    );
    const elements = getSyncableElements(
      restoreElements(JSON.parse(decodedData), null, {
        deleteInvisibleElements: true,
      }),
    );

    if (socket) {
      ServerSceneVersionCache.set(socket, elements);
    }

    return elements;
  } catch {
    return null;
  }
};
