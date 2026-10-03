import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { cacheRoomFiles, readCachedRoomFiles } from "./roomCache";

export const loadRoomFiles = async ({
  roomId,
  roomKey,
  fileIds,
  download,
  onCachedFiles,
  skipCache = [],
}: {
  roomId: string;
  roomKey: string;
  fileIds: readonly FileId[];
  download: (ids: FileId[]) => Promise<{
    loadedFiles: BinaryFileData[];
    erroredFiles: Map<FileId, true>;
  }>;
  onCachedFiles?: (files: BinaryFileData[]) => void;
  skipCache?: readonly FileId[];
}) => {
  const uniqueIds = [...new Set(fileIds)];
  const skipIds = new Set(skipCache);
  const cached = await readCachedRoomFiles(
    roomId,
    roomKey,
    uniqueIds.filter((id) => !skipIds.has(id)),
  );
  onCachedFiles?.(cached);
  const cachedIds = new Set(cached.map((file) => file.id));
  const missing = uniqueIds.filter((id) => !cachedIds.has(id));
  if (!missing.length) {
    return { loadedFiles: cached, erroredFiles: new Map<FileId, true>() };
  }
  try {
    const result = await download(missing);
    void cacheRoomFiles(roomId, roomKey, result.loadedFiles);
    return { ...result, loadedFiles: [...cached, ...result.loadedFiles] };
  } catch (error) {
    console.warn("Room file download failed", error);
    return {
      loadedFiles: cached,
      erroredFiles: new Map(missing.map((id) => [id, true as const])),
    };
  }
};
