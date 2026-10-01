import type { RoomFolder } from "../data/rooms";

export const getFolderDescendantIds = (
  folders: readonly RoomFolder[],
  folderId: string,
): Set<string> => {
  const descendants = new Set([folderId]);
  for (const ancestorId of descendants) {
    for (const folder of folders) {
      if (folder.parentId === ancestorId) {
        descendants.add(folder.id);
      }
    }
  }
  return descendants;
};

export const getFolderTree = (folders: readonly RoomFolder[]) => {
  const sorted = [...folders].sort((first, second) =>
    first.name.localeCompare(second.name),
  );
  const folderIds = new Set(folders.map((folder) => folder.id));
  const children = new Map<string | null, RoomFolder[]>();
  for (const folder of sorted) {
    const parentId =
      folder.parentId && folderIds.has(folder.parentId)
        ? folder.parentId
        : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(folder);
    children.set(parentId, siblings);
  }
  const entries: { folder: RoomFolder; depth: number; path: string }[] = [];
  const visited = new Set<string>();
  const visit = (folder: RoomFolder, depth: number, parents: string[]) => {
    if (visited.has(folder.id)) {
      return;
    }
    visited.add(folder.id);
    const names = [...parents, folder.name];
    entries.push({ folder, depth, path: names.join(" / ") });
    for (const child of children.get(folder.id) ?? []) {
      visit(child, depth + 1, names);
    }
  };
  for (const folder of children.get(null) ?? []) {
    visit(folder, 0, []);
  }
  for (const folder of sorted) {
    if (!visited.has(folder.id)) {
      visit(folder, 0, []);
    }
  }
  return entries;
};
