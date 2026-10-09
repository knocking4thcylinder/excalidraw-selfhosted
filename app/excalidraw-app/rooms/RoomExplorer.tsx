import { useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "radix-ui";
import {
  LoadIcon,
  chevronDownIcon,
  chevronRight,
} from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { buildExplorerEntries } from "./explorerEntries";
import { getFolderDescendantIds } from "./folderTree";

import type { CSSProperties, ReactNode } from "react";
import type { RoomFolder, ServerRoomEntry } from "../data/rooms";

const INDENT_PX = 16;

// Indentation plus one hairline per ancestor level, centred under the
// ancestor's chevron.
const indentStyle = (depth: number): CSSProperties => {
  const level = Math.min(depth, 8);
  return {
    paddingInlineStart: `${8 + level * INDENT_PX}px`,
    backgroundImage: level
      ? `repeating-linear-gradient(to right, var(--rooms-guide) 0 1px, transparent 1px ${INDENT_PX}px)`
      : undefined,
    backgroundSize: `${level * INDENT_PX}px 100%`,
    backgroundPosition: `${INDENT_PX}px 0`,
    backgroundRepeat: "no-repeat",
  };
};

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
  renderFolderActions,
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
  renderFolderActions?: (folder: RoomFolder) => ReactNode;
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
  const foldersById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const query = search.trim().toLocaleLowerCase();

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

  const entries = useMemo(
    () =>
      buildExplorerEntries({ folders, rooms, search, expanded, folderDraft }),
    [folders, rooms, search, expanded, folderDraft],
  );
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
                className="RoomsPage__treeItem RoomsPage__treeItem--folder RoomsPage__treeItem--editing"
                style={indentStyle(entry.depth)}
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
                  }${entry.folder ? " RoomsPage__treeItem--folder" : ""}${
                    entry.room ? " RoomsPage__treeItem--room" : ""
                  }`}
                  style={indentStyle(entry.depth)}
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
                      {!!entry.count && (
                        <span className="RoomsPage__treeCount">
                          {entry.count}
                        </span>
                      )}
                    </button>
                  ) : null}
                  {entry.folder && editingFolderId !== entry.id && (
                    <div className="RoomsPage__rowActions">
                      {renderFolderActions?.(entry.folder)}
                    </div>
                  )}
                  {entry.room && renderRoom(entry.room)}
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
