import { getFolderTree } from "./folderTree";

import type { RoomFolder, ServerRoomEntry } from "../data/rooms";

export type ExplorerEntry = {
  id: string;
  depth: number;
  parentId?: string;
  folder?: RoomFolder;
  room?: ServerRoomEntry;
  path?: string;
  count?: number;
  draft?: boolean;
};

type ExplorerEntryArgs = {
  folders: readonly RoomFolder[];
  rooms: readonly ServerRoomEntry[];
  search: string;
  expanded: ReadonlySet<string>;
  folderDraft?: { parentId?: string };
};

type FolderNode = { folder: RoomFolder; depth: number; path: string };

export const buildExplorerEntries = ({
  folders,
  rooms,
  search,
  expanded,
  folderDraft,
}: ExplorerEntryArgs): ExplorerEntry[] => {
  const query = search.trim().toLocaleLowerCase();
  const folderIds = new Set(folders.map((folder) => folder.id));
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const tree = getFolderTree(folders);

  const children = new Map<string | undefined, FolderNode[]>();
  const lineage: string[] = [];
  for (const node of tree) {
    const parentId = node.depth > 0 ? lineage[node.depth - 1] : undefined;
    const siblings = children.get(parentId) ?? [];
    siblings.push(node);
    children.set(parentId, siblings);
    lineage[node.depth] = node.folder.id;
  }

  const visibleFolders = new Set<string>();
  const pathMatchedFolders = new Set<string>();
  const matchingRooms = new Set<ServerRoomEntry>();
  if (query) {
    const matchedFolders = new Set<string>();
    for (const node of tree) {
      if (node.path.toLocaleLowerCase().includes(query)) {
        matchedFolders.add(node.folder.id);
        pathMatchedFolders.add(node.folder.id);
      }
    }
    for (const room of rooms) {
      if (
        `${room.name ?? ""} ${room.roomId}`.toLocaleLowerCase().includes(query)
      ) {
        matchingRooms.add(room);
        if (room.folderId && folderIds.has(room.folderId)) {
          matchedFolders.add(room.folderId);
        }
      }
    }
    for (const id of matchedFolders) {
      let ancestor = foldersById.get(id);
      while (ancestor && !visibleFolders.has(ancestor.id)) {
        visibleFolders.add(ancestor.id);
        ancestor = foldersById.get(ancestor.parentId ?? "");
      }
    }
  }

  const roomCounts = new Map<string, number>();
  const roomsByFolder = new Map<string | undefined, ServerRoomEntry[]>();
  const sortedRooms = [...rooms].sort((first, second) =>
    (first.name || first.roomId).localeCompare(second.name || second.roomId),
  );
  for (const room of sortedRooms) {
    if (room.folderId) {
      roomCounts.set(room.folderId, (roomCounts.get(room.folderId) ?? 0) + 1);
    }
    const parentId =
      room.folderId && folderIds.has(room.folderId) ? room.folderId : undefined;
    const folderRooms = roomsByFolder.get(parentId) ?? [];
    folderRooms.push(room);
    roomsByFolder.set(parentId, folderRooms);
  }

  const entries: ExplorerEntry[] = [];
  const visit = (parentId: string | undefined, depth: number) => {
    if (folderDraft && folderDraft.parentId === parentId) {
      entries.push({ id: "draft-folder", depth, parentId, draft: true });
    }
    for (const node of children.get(parentId) ?? []) {
      if (query && !visibleFolders.has(node.folder.id)) {
        continue;
      }
      entries.push({
        id: node.folder.id,
        folder: node.folder,
        depth,
        parentId,
        path: node.path,
        count: roomCounts.get(node.folder.id) ?? 0,
      });
      if (
        query ||
        expanded.has(node.folder.id) ||
        folderDraft?.parentId === node.folder.id
      ) {
        visit(node.folder.id, depth + 1);
      }
    }
    for (const room of roomsByFolder.get(parentId) ?? []) {
      if (
        !query ||
        (parentId !== undefined && pathMatchedFolders.has(parentId)) ||
        matchingRooms.has(room)
      ) {
        entries.push({ id: `room:${room.roomId}`, room, depth, parentId });
      }
    }
  };
  visit(undefined, 0);
  return entries;
};
