import { useCallback, useEffect, useState } from "react";

import { appJotaiStore, useAtom } from "../app-jotai";
import { fetchRoomFolders, fetchRooms } from "../data/rooms";
import {
  cacheFolders,
  cacheRooms,
  readCachedFolders,
  readCachedRooms,
} from "../data/roomCache";

import { roomFoldersAtom, roomsRegistryAtom } from "./explorerState";

import type { PrimitiveAtom } from "../app-jotai";

type OwnerWindow = NonNullable<Document["defaultView"]>;

const requestCollection = <Value>(
  ownerWindow: OwnerWindow,
  fetchCollection: (signal: AbortSignal) => Promise<Value | null>,
) => {
  const controller = new ownerWindow.AbortController();
  const timeout = ownerWindow.setTimeout(() => controller.abort(), 10_000);
  const result = fetchCollection(controller.signal).finally(() =>
    ownerWindow.clearTimeout(timeout),
  );
  return {
    result,
    cancel: () => {
      controller.abort();
      ownerWindow.clearTimeout(timeout);
    },
  };
};

const useRegistryCollection = <Value>(
  registryAtom: PrimitiveAtom<Value | null>,
  readCache: () => Promise<Value | null>,
  fetchCollection: (signal?: AbortSignal) => Promise<Value | null>,
  persist: (value: Value) => Promise<void>,
  ownerWindow: OwnerWindow | null | undefined,
  preload: boolean,
) => {
  const [value, setValue] = useAtom(registryAtom, { store: appJotaiStore });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!preload && value) {
      void persist(value);
    }
  }, [value, persist, preload]);

  useEffect(() => {
    if (!ownerWindow) {
      return;
    }
    let alive = true;
    let hydrated: Value | null = null;
    const needsRequest = !preload || appJotaiStore.get(registryAtom) === null;
    void readCache().then((cached) => {
      if (alive && cached && appJotaiStore.get(registryAtom) === null) {
        hydrated = cached;
        setValue(cached);
      }
    });
    const request = needsRequest
      ? requestCollection(ownerWindow, fetchCollection)
      : null;
    if (request) {
      void request.result.then((result) => {
        if (alive) {
          setValue((current) =>
            !preload || current === null || current === hydrated
              ? result ?? current
              : current,
          );
          setLoading(false);
        }
      });
    } else {
      setLoading(false);
    }
    return () => {
      alive = false;
      request?.cancel();
    };
  }, [
    ownerWindow,
    registryAtom,
    readCache,
    fetchCollection,
    preload,
    setValue,
  ]);

  const refresh = useCallback(async () => {
    if (!ownerWindow) {
      return null;
    }
    setLoading(true);
    try {
      const result = await requestCollection(ownerWindow, fetchCollection)
        .result;
      setValue((current) => result ?? current);
      return result;
    } finally {
      setLoading(false);
    }
  }, [ownerWindow, fetchCollection, setValue]);

  return { value, setValue, loading, refresh };
};

export const useRoomRegistry = (
  ownerWindow: OwnerWindow | null | undefined,
  preload = false,
) => ({
  rooms: useRegistryCollection(
    roomsRegistryAtom,
    readCachedRooms,
    fetchRooms,
    cacheRooms,
    ownerWindow,
    preload,
  ),
  folders: useRegistryCollection(
    roomFoldersAtom,
    readCachedFolders,
    fetchRoomFolders,
    cacheFolders,
    ownerWindow,
    preload,
  ),
});
