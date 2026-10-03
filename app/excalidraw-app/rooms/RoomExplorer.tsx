import { useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "radix-ui";
import {
  LoadIcon,
  chevronDownIcon,
  chevronRight,
  file,
  DuplicateIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { getFolderDescendantIds, getFolderTree } from "./folderTree";

import type { ReactNode } from "react";
import type { RoomFolder, ServerRoomEntry } from "../data/rooms";

export const RoomExplorer = ({
  folders,
  rooms,
  search,
  selectedFolderId,
  disabled,
  onSelectFolder,
  onMoveRoom,
  onMoveFolder,
  onRenameFolder,
  onRenameRoom,
  renderRoom,
  toolbar,
  activeRoomId,
  renderContextMenu,
  folderDraft,
  editingFolderId,
  renderFolderEditor,
  onOpenRoom,
}: {
  folders: RoomFolder[];
  rooms: ServerRoomEntry[];
  search: string;
  selectedFolderId: string;
  disabled: boolean;
  onSelectFolder: (id: string) => void;
  onMoveRoom: (room: ServerRoomEntry, folderId: string) => Promise<void>;
  onMoveFolder: (folder: RoomFolder, parentId: string) => Promise<void>;
  onRenameFolder: (folder: RoomFolder) => void;
  onRenameRoom: (room: ServerRoomEntry) => void;
  renderRoom: (room: ServerRoomEntry) => ReactNode;
  toolbar?: ReactNode;
  activeRoomId?: string;
  folderDraft?: { parentId?: string };
  editingFolderId?: string;
  renderFolderEditor?: () => ReactNode;
  onOpenRoom?: (room: ServerRoomEntry) => void;
  renderContextMenu?: (entry: {
    folder?: RoomFolder;
    room?: ServerRoomEntry;
  }) => ReactNode;
}) => {
  const { t } = useI18n();
  const treeRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const folderTree = useMemo(() => getFolderTree(folders), [folders]);
  const foldersById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const query = search.trim().toLocaleLowerCase();
  const matchingRooms = rooms.filter((room) =>
    `${room.name ?? ""} ${room.roomId}`.toLocaleLowerCase().includes(query),
  );
  const matchingFolderIds = new Set<string>();
  if (query) {
    for (const entry of folderTree) {
      if (
        entry.path.toLocaleLowerCase().includes(query) ||
        matchingRooms.some((room) => room.folderId === entry.folder.id)
      ) {
        let ancestor: RoomFolder | undefined = entry.folder;
        while (ancestor && !matchingFolderIds.has(ancestor.id)) {
          matchingFolderIds.add(ancestor.id);
          ancestor = foldersById.get(ancestor.parentId ?? "");
        }
      }
    }
  }

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      const selected = foldersById.get(selectedFolderId);
      let ancestor = foldersById.get(selected?.parentId ?? "");
      const visited = new Set<string>();
      while (ancestor && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        next.add(ancestor.id);
        ancestor = foldersById.get(ancestor.parentId ?? "");
      }
      return next;
    });
  }, [foldersById, selectedFolderId]);

  const entries: {
    id: string;
    depth: number;
    parentId?: string;
    folder?: RoomFolder;
    room?: ServerRoomEntry;
    path?: string;
    draft?: boolean;
  }[] = [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  const sortedRooms = [...rooms].sort((first, second) =>
    (first.name || first.roomId).localeCompare(second.name || second.roomId),
  );
  const addRooms = (folderId: string | undefined, depth: number) => {
    const folderMatches = folderTree.some(
      (entry) =>
        entry.folder.id === folderId &&
        entry.path.toLocaleLowerCase().includes(query),
    );
    for (const room of sortedRooms) {
      const parentId =
        room.folderId && folderIds.has(room.folderId)
          ? room.folderId
          : undefined;
      if (
        parentId === folderId &&
        (!query || folderMatches || matchingRooms.includes(room))
      ) {
        entries.push({ id: `room:${room.roomId}`, room, depth, parentId });
      }
    }
  };
  const parents = new Map<string, string | undefined>();
  const ancestors: string[] = [];
  for (const entry of folderTree) {
    parents.set(
      entry.folder.id,
      entry.depth > 0 ? ancestors[entry.depth - 1] : undefined,
    );
    ancestors[entry.depth] = entry.folder.id;
  }
  const visit = (parentId: string | undefined, depth: number) => {
    if (folderDraft && folderDraft.parentId === parentId) {
      entries.push({ id: "draft-folder", depth, parentId, draft: true });
    }
    for (const entry of folderTree.filter(
      (item) => parents.get(item.folder.id) === parentId,
    )) {
      if (query && !matchingFolderIds.has(entry.folder.id)) {
        continue;
      }
      entries.push({
        id: entry.folder.id,
        folder: entry.folder,
        depth,
        parentId,
        path: entry.path,
      });
      if (
        query ||
        expanded.has(entry.folder.id) ||
        folderDraft?.parentId === entry.folder.id
      ) {
        visit(entry.folder.id, depth + 1);
      }
    }
    addRooms(parentId, depth);
  };
  visit(undefined, 0);
  const tabId = entries.some((entry) => entry.id === focusedId)
    ? focusedId
    : entries[0]?.id;
  const toggle = (id: string, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };
  const canDrop = (parentId: string) => {
    if (!dragId || disabled) {
      return false;
    }
    const draggedFolder = folders.find((folder) => folder.id === dragId);
    if (draggedFolder) {
      return (
        (draggedFolder.parentId ?? "") !== parentId &&
        !getFolderDescendantIds(folders, draggedFolder.id).has(parentId)
      );
    }
    const room = rooms.find((entry) => `room:${entry.roomId}` === dragId);
    return !!room && (room.folderId ?? "") !== parentId;
  };
  const drop = async (parentId: string) => {
    if (!canDrop(parentId)) {
      return;
    }
    const folder = folders.find((entry) => entry.id === dragId);
    const room = rooms.find((entry) => `room:${entry.roomId}` === dragId);
    setDragId(null);
    setDropId(null);
    if (folder) {
      await onMoveFolder(folder, parentId);
    } else if (room) {
      await onMoveRoom(room, parentId);
    }
    if (parentId) {
      toggle(parentId, true);
    }
  };

  return (
    <>
      <div className="RoomsPage__treeToolbar">
        {toolbar ?? <span>{t("myRooms.folders")}</span>}
        <button
          type="button"
          className="RoomsPage__treeControl"
          aria-label={t("myRooms.expandAll")}
          title={t("myRooms.expandAll")}
          disabled={disabled || !!query || folders.length === 0}
          onClick={() =>
            setExpanded(new Set(folders.map((folder) => folder.id)))
          }
        >
          {chevronDownIcon}
        </button>
        <button
          type="button"
          className="RoomsPage__treeControl"
          aria-label={t("myRooms.collapseAll")}
          title={t("myRooms.collapseAll")}
          disabled={disabled || !!query || folders.length === 0}
          onClick={() => setExpanded(new Set())}
        >
          {DuplicateIcon}
        </button>
      </div>
      <div
        ref={treeRef}
        className="RoomsPage__tree"
        role="tree"
        aria-label={t("myRooms.folders")}
      >
        {entries.length === 0 && (
          <div className="RoomsPage__empty" role="status">
            {t(query ? "myRooms.noMatches" : "myRooms.empty")}
          </div>
        )}
        {entries.map((entry, index) => {
          const open =
            !!query ||
            expanded.has(entry.id) ||
            folderDraft?.parentId === entry.id;
          if (entry.draft) {
            return (
              <div
                key={entry.id}
                role="treeitem"
                aria-label={t("myRooms.newFolder")}
                aria-level={entry.depth + 1}
                aria-selected="true"
                className="RoomsPage__treeItem RoomsPage__treeItem--editing"
                style={{
                  paddingInlineStart: `${
                    0.25 + Math.min(entry.depth, 8) * 0.75
                  }rem`,
                }}
              >
                <span className="RoomsPage__treeChevron" />
                <span className="RoomsPage__folderIcon">{LoadIcon}</span>
                {renderFolderEditor?.()}
              </div>
            );
          }
          return (
            <ContextMenu.Root key={entry.id} modal={false}>
              <ContextMenu.Trigger asChild>
                <div
                  role="treeitem"
                  onClick={(event) => {
                    if (
                      entry.room &&
                      !disabled &&
                      !(event.target as HTMLElement).closest(
                        "button, input, .RoomsPage__rowActions",
                      )
                    ) {
                      onOpenRoom?.(entry.room);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.currentTarget.focus();
                    if (entry.folder) {
                      onSelectFolder(entry.id);
                    }
                  }}
                  aria-label={
                    entry.folder?.name || entry.room?.name || entry.room?.roomId
                  }
                  aria-level={entry.depth + 1}
                  aria-expanded={entry.folder ? open : undefined}
                  aria-selected={
                    entry.folder
                      ? selectedFolderId === entry.id
                      : entry.room?.roomId === activeRoomId
                  }
                  draggable={!disabled && editingFolderId !== entry.id}
                  tabIndex={tabId === entry.id ? 0 : -1}
                  className={`RoomsPage__treeItem${
                    dropId === entry.id ? " RoomsPage__treeItem--drop" : ""
                  }${entry.folder ? " RoomsPage__treeItem--folder" : ""}`}
                  style={{
                    paddingInlineStart: `${
                      0.25 + Math.min(entry.depth, 8) * 0.75
                    }rem`,
                    backgroundImage: entry.depth
                      ? "repeating-linear-gradient(to right, var(--dialog-border-color) 0 1px, transparent 1px 0.75rem)"
                      : undefined,
                    backgroundSize: `${
                      Math.min(entry.depth, 8) * 0.75
                    }rem 100%`,
                    backgroundPosition: "0.75rem 0",
                    backgroundRepeat: "no-repeat",
                  }}
                  onFocus={() => setFocusedId(entry.id)}
                  onDragStart={(event) => {
                    if (
                      (event.target as HTMLElement).closest(
                        "input, .RoomsPage__rowActions, .RoomsPage__select",
                      )
                    ) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(
                      "application/x-excalidraw-room-tree",
                      entry.id,
                    );
                    setDragId(entry.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropId(null);
                  }}
                  onDragOver={(event) => {
                    const parentId = entry.folder
                      ? entry.id
                      : entry.parentId ?? "";
                    if (canDrop(parentId)) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropId(entry.id);
                    } else {
                      setDropId(null);
                    }
                  }}
                  onDragLeave={() => setDropId(null)}
                  onDrop={(event) => {
                    event.preventDefault();
                    drop(entry.folder ? entry.id : entry.parentId ?? "");
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) {
                      return;
                    }
                    const nodes =
                      treeRef.current?.querySelectorAll<HTMLElement>(
                        "[role=treeitem]",
                      );
                    let nextIndex: number | undefined;
                    switch (event.key) {
                      case "ArrowDown":
                        nextIndex = Math.min(index + 1, entries.length - 1);
                        break;
                      case "ArrowUp":
                        nextIndex = Math.max(index - 1, 0);
                        break;
                      case "Home":
                        nextIndex = 0;
                        break;
                      case "End":
                        nextIndex = entries.length - 1;
                        break;
                      case "ArrowRight":
                        if (entry.folder && !open) {
                          toggle(entry.id, true);
                        } else if (entries[index + 1]?.depth > entry.depth) {
                          nextIndex = index + 1;
                        }
                        break;
                      case "ArrowLeft":
                        if (entry.folder && open && !query) {
                          toggle(entry.id, false);
                        } else {
                          nextIndex = entries.findIndex(
                            (item) => item.id === entry.parentId,
                          );
                        }
                        break;
                      case "Enter":
                      case " ":
                        event.currentTarget
                          .querySelector<HTMLButtonElement>(
                            ".RoomsPage__folderLabel, .RoomsPage__rowLabel",
                          )
                          ?.click();
                        break;
                      case "F2":
                        if (!disabled && entry.folder) {
                          onRenameFolder(entry.folder);
                        } else if (!disabled && entry.room) {
                          onRenameRoom(entry.room);
                        }
                        break;
                      default:
                        return;
                    }
                    event.preventDefault();
                    if (nextIndex !== undefined && nextIndex >= 0) {
                      nodes?.[nextIndex]?.focus();
                    }
                  }}
                >
                  {entry.folder && editingFolderId === entry.id ? (
                    <>
                      <span className="RoomsPage__treeChevron">
                        {open ? chevronDownIcon : chevronRight}
                      </span>
                      <span className="RoomsPage__folderIcon">{LoadIcon}</span>
                      {renderFolderEditor?.()}
                    </>
                  ) : entry.folder ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="RoomsPage__folderLabel"
                      aria-label={t("myRooms.openFolder", {
                        name: entry.path!,
                      })}
                      disabled={disabled}
                      onClick={(event) => {
                        event.currentTarget.parentElement?.focus();
                        onSelectFolder(entry.id);
                        toggle(entry.id, !open);
                      }}
                    >
                      <span className="RoomsPage__treeChevron">
                        {open ? chevronDownIcon : chevronRight}
                      </span>
                      <span className="RoomsPage__folderIcon">{LoadIcon}</span>
                      <span className="RoomsPage__folderName">
                        {entry.folder.name}
                      </span>
                      <span className="RoomsPage__treeCount">
                        {
                          rooms.filter((room) => room.folderId === entry.id)
                            .length
                        }
                      </span>
                    </button>
                  ) : (
                    <>
                      <span className="RoomsPage__fileIcon" aria-hidden="true">
                        {file}
                      </span>
                      {renderRoom(entry.room!)}
                    </>
                  )}
                </div>
              </ContextMenu.Trigger>
              {renderContextMenu?.(entry)}
            </ContextMenu.Root>
          );
        })}
        {dragId && (
          <div
            className={`RoomsPage__rootDrop${
              dropId === "root" ? " RoomsPage__treeItem--drop" : ""
            }`}
            onDragOver={(event) => {
              if (canDrop("")) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropId("root");
              }
            }}
            onDragLeave={() => setDropId(null)}
            onDrop={(event) => {
              event.preventDefault();
              drop("");
            }}
          >
            {t("myRooms.topLevel")}
          </div>
        )}
      </div>
    </>
  );
};
