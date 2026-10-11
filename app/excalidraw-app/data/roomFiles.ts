import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";

import type { FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { cacheRoomFiles, readCachedRoomFiles } from "./roomCache";

// Image blobs live next to the room scene on the self-hosted API, compressed
// and encrypted with the room key (see encodeFilesForUpload).
const roomFileUrl = (roomId: string, roomKey: string, fileId: FileId) =>
  `/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(
    fileId,
  )}?key=${encodeURIComponent(roomKey)}`;

export const uploadRoomFiles = async ({
  roomId,
  roomKey,
  files,
}: {
  roomId: string;
  roomKey: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const savedFiles: FileId[] = [];
  const erroredFiles: FileId[] = [];
  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(roomFileUrl(roomId, roomKey, id), {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          cache: "no-store",
          body: buffer as Uint8Array<ArrayBuffer>,
        });
        (response.ok ? savedFiles : erroredFiles).push(id);
      } catch {
        erroredFiles.push(id);
      }
    }),
  );
  return { savedFiles, erroredFiles };
};

export const downloadRoomFiles = async (
  roomId: string,
  roomKey: string,
  fileIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();
  await Promise.all(
    [...new Set(fileIds)].map(async (id) => {
      try {
        const response = await fetch(roomFileUrl(roomId, roomKey, id), {
          cache: "no-store",
        });
        if (!response.ok) {
          erroredFiles.set(id, true);
          return;
        }
        const { data, metadata } = await decompressData<BinaryFileMetadata>(
          new Uint8Array(await response.arrayBuffer()),
          { decryptionKey: roomKey },
        );
        loadedFiles.push({
          mimeType: metadata.mimeType || MIME_TYPES.binary,
          id,
          dataURL: new TextDecoder().decode(data) as DataURL,
          created: metadata?.created || Date.now(),
          lastRetrieved: metadata?.created || Date.now(),
        });
      } catch (error) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );
  return { loadedFiles, erroredFiles };
};

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
