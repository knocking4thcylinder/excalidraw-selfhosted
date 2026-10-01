import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  CloseIcon,
  LinkIcon,
  PlusIcon,
  TrashIcon,
  copyIcon,
  pencilIcon,
  playerStopFilledIcon,
  share,
} from "@excalidraw/excalidraw/components/icons";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { useExcalidrawContainer } from "@excalidraw/excalidraw/components/App";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { APP_NAME, KEYS, queryFocusableElements } from "@excalidraw/common";
import { useEffect, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getCollaborationLink, getCollaborationLinkData } from "../data";
import {
  deleteRoom,
  deleteRoomFolder,
  fetchRoomFolders,
  fetchRooms,
  moveRoomToFolder,
  renameRoom,
  saveRoomFolder,
  type RoomFolder,
  type ServerRoomEntry,
} from "../data/rooms";

import { JoinRoom } from "../share/JoinRoom";
import { useAtomValue } from "../app-jotai";
import { activeRoomLinkAtom } from "../collab/Collab";

import { closeRoomsPage, getRoomPageLink } from "./roomsRoute";
import { FolderMenu } from "./FolderMenu";
import "./RoomsPage.scss";

import type { CollabAPI } from "../collab/Collab";

// Standalone rooms manager: switch/create/join/rename/delete/share rooms.
// Rendered as a full-screen overlay above the canvas (the canvas, Collab
// socket and scene stay mounted and alive underneath); visibility is driven
// by the #rooms hash route, so the page is bookmarkable and works in the APK
// WebView.
export const RoomsPage = ({
  collabAPI,
  excalidrawAPI,
  onClose,
}: {
  collabAPI: CollabAPI | null;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onClose: () => void;
}) => {
  const { t } = useI18n();
  const { container } = useExcalidrawContainer();
  const ownerWindow = container?.ownerDocument.defaultView ?? window;

  const [rooms, setRooms] = useState<ServerRoomEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [confirmingDeleteRoomId, setConfirmingDeleteRoomId] = useState<
    string | null
  >(null);
  const [sharingRoomId, setSharingRoomId] = useState<string | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [shareCodeLoading, setShareCodeLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const copiedTimer = useRef<number>(0);
  const shareRequest = useRef(0);
  const pageRef = useRef<HTMLDivElement>(null);
  const transitionRef = useRef(false);
  const [transitioning, setTransitioning] = useState(false);
  const [search, setSearch] = useState("");
  const [folders, setFolders] = useState<RoomFolder[] | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState("all");
  const [folderEditor, setFolderEditor] = useState<"create" | "rename" | null>(
    null,
  );
  const [folderName, setFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [confirmingDeleteFolder, setConfirmingDeleteFolder] = useState(false);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) {
      return;
    }
    const previousFocus = page.ownerDocument
      .activeElement as HTMLElement | null;
    const requests = shareRequest;
    queryFocusableElements(page)[0]?.focus();
    return () => {
      requests.current++;
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchRooms(), fetchRoomFolders()]).then(
      ([result, folderResult]) => {
        if (!alive) {
          return;
        }
        setRooms(result);
        setFolders(folderResult);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (copiedTimer.current) {
        ownerWindow.clearTimeout(copiedTimer.current);
      }
    },
    [ownerWindow],
  );

  const refreshRooms = async () => {
    setLoading(true);
    const [result, folderResult] = await Promise.all([
      fetchRooms(),
      fetchRoomFolders(),
    ]);
    setRooms(result);
    setFolders(folderResult);
    if (folderResult) {
      setSelectedFolderId((current) =>
        current === "all" ||
        current === "unfiled" ||
        folderResult.some((folder) => folder.id === current)
          ? current
          : "all",
      );
    }
    setLoading(false);
  };

  const submitFolder = async () => {
    setFolderBusy(true);
    setActionError(null);
    const folder = await saveRoomFolder(
      folderName.trim(),
      folderEditor === "rename" ? selectedFolderId : undefined,
    );
    if (folder) {
      setFolders((current) => [
        ...(current ?? []).filter((entry) => entry.id !== folder.id),
        folder,
      ]);
      setSelectedFolderId(folder.id);
      setFolderEditor(null);
      setFolderName("");
    } else {
      setActionError(t("myRooms.folderSaveError"));
    }
    setFolderBusy(false);
  };

  const removeFolder = async () => {
    setFolderBusy(true);
    setActionError(null);
    if (await deleteRoomFolder(selectedFolderId)) {
      setFolders(
        (current) =>
          current?.filter((folder) => folder.id !== selectedFolderId) ?? null,
      );
      setRooms(
        (current) =>
          current?.map((room) =>
            room.folderId === selectedFolderId
              ? { ...room, folderId: undefined }
              : room,
          ) ?? null,
      );
      setSelectedFolderId("unfiled");
      setConfirmingDeleteFolder(false);
      setFolderEditor(null);
    } else {
      setActionError(t("myRooms.folderDeleteError"));
    }
    setFolderBusy(false);
  };

  const moveRoom = async (room: ServerRoomEntry, folderId: string) => {
    setFolderBusy(true);
    setActionError(null);
    if (await moveRoomToFolder(room, folderId || null)) {
      setRooms(
        (current) =>
          current?.map((entry) =>
            entry.roomId === room.roomId
              ? { ...entry, folderId: folderId || undefined }
              : entry,
          ) ?? null,
      );
    } else {
      setActionError(t("myRooms.moveError"));
    }
    setFolderBusy(false);
  };

  const flashCopied = (key: string) => {
    setCopied(key);
    if (copiedTimer.current) {
      ownerWindow.clearTimeout(copiedTimer.current);
    }
    copiedTimer.current = ownerWindow.setTimeout(() => setCopied(null), 1500);
  };

  const close = () => {
    closeRoomsPage(ownerWindow);
    onClose();
  };

  const stopSilently = () => {
    if (collabAPI?.isCollaborating()) {
      collabAPI.stopCollaboration(false);
    }
  };

  // Paint a freshly joined room. startCollaboration() only resolves the
  // scene — unlike the initial boot path, nothing applies it to the canvas
  // for us (pushState doesn't fire hashchange, so App's handler never runs).
  const paintScene = (
    api: ExcalidrawImperativeAPI,
    scene: Awaited<ReturnType<NonNullable<CollabAPI>["startCollaboration"]>>,
  ) => {
    if (scene) {
      api.updateScene({
        elements: restoreElements(scene.elements, null, {
          repairBindings: true,
        }),
        appState: restoreAppState(scene.appState, api.getAppState()),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    }
  };

  const openRoom = async (room: { roomId: string; roomKey: string }) => {
    if (!collabAPI || !excalidrawAPI || transitionRef.current) {
      return;
    }
    transitionRef.current = true;
    setTransitioning(true);
    setActionError(null);
    const previousElements = excalidrawAPI.getSceneElementsIncludingDeleted();
    const previousState = excalidrawAPI.getAppState();
    const previousFiles = excalidrawAPI.getFiles();
    const previousURL = ownerWindow.location.href;
    try {
      // Hash navigation alone can't switch: startCollaboration() early-returns
      // while the old socket exists, so tear it down first (no confirm).
      stopSilently();
      // Clear the old room's canvas up front: the join below preserves
      // unsynced canvas content for offline recovery, which must never leak
      // across rooms.
      excalidrawAPI.updateScene({ elements: [] });
      ownerWindow.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId: room.roomId, roomKey: room.roomKey }),
      );
      const scene = await collabAPI.startCollaboration({
        roomId: room.roomId,
        roomKey: room.roomKey,
      });
      paintScene(excalidrawAPI, scene);
      if (!collabAPI.isCollaborating()) {
        throw new Error(t("roomDialog.error_network"));
      }
      // pushState doesn't fire hashchange, so hide the page explicitly.
      onClose();
    } catch {
      stopSilently();
      ownerWindow.history.replaceState({}, APP_NAME, previousURL);
      excalidrawAPI.addFiles(Object.values(previousFiles));
      excalidrawAPI.updateScene({
        elements: previousElements,
        appState: previousState,
      });
      setActionError(t("roomDialog.error_network"));
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  };

  const createRoom = async () => {
    if (!collabAPI || !excalidrawAPI || transitionRef.current) {
      return;
    }
    if (
      excalidrawAPI.getSceneElements().length > 0 &&
      !ownerWindow.confirm(t("myRooms.confirmEmptyRoom"))
    ) {
      return;
    }
    transitionRef.current = true;
    setTransitioning(true);
    const previousElements = excalidrawAPI.getSceneElementsIncludingDeleted();
    const previousState = excalidrawAPI.getAppState();
    const previousFiles = excalidrawAPI.getFiles();
    const previousURL = ownerWindow.location.href;
    try {
      setActionError(null);
      stopSilently();
      // A new room starts empty, never as a copy of the current canvas:
      // startCollaboration(null) would otherwise seed the room from whatever
      // is on screen. Same wipe-before-switch as openRoom above (a previous
      // room's content survives on the server snapshot, solo work stays in
      // local browser storage).
      excalidrawAPI.updateScene({ elements: [] });
      await collabAPI.startCollaboration(null);
      // startCollaboration pushStates the new #room= link itself (no hashchange
      // event), so hide the page explicitly. A brand-new room resolves null
      // (nothing to load) — the live session is what matters, so check that
      // instead of the scene.
      if (collabAPI.isCollaborating()) {
        onClose();
      } else {
        throw new Error(t("myRooms.createError"));
      }
    } catch {
      stopSilently();
      ownerWindow.history.replaceState({}, APP_NAME, previousURL);
      excalidrawAPI.addFiles(Object.values(previousFiles));
      excalidrawAPI.updateScene({
        elements: previousElements,
        appState: previousState,
      });
      setActionError(t("myRooms.createError"));
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  };

  const leaveSession = () => {
    stopSilently();
  };

  const submitRename = async (room: ServerRoomEntry, value: string) => {
    setEditingRoomId(null);
    if (await renameRoom(room.roomId, room.key, value.trim())) {
      refreshRooms();
    } else {
      setActionError(t("myRooms.renameError"));
    }
  };

  const confirmDelete = async (room: ServerRoomEntry) => {
    setConfirmingDeleteRoomId(null);
    if (await deleteRoom(room.roomId, room.key)) {
      if (sharingRoomId === room.roomId) {
        setSharingRoomId(null);
        setShareCode(null);
      }
      refreshRooms();
    } else {
      setActionError(t("myRooms.deleteError"));
    }
  };

  const toggleShare = async (room: ServerRoomEntry) => {
    const request = ++shareRequest.current;
    if (sharingRoomId === room.roomId) {
      setSharingRoomId(null);
      setShareCode(null);
      return;
    }
    setSharingRoomId(room.roomId);
    setShareCode(null);
    setShareCodeLoading(true);
    try {
      const resp = await fetch("/api/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: getRoomPageLink(ownerWindow, room) }),
      });
      const data = resp.ok ? await resp.json() : null;
      if (request !== shareRequest.current) {
        return;
      }
      if (resp.ok) {
        setShareCode(typeof data?.code === "string" ? data.code : null);
      } else {
        setShareCode(null);
      }
    } catch {
      if (request === shareRequest.current) {
        setShareCode(null);
      }
    } finally {
      if (request === shareRequest.current) {
        setShareCodeLoading(false);
      }
    }
  };

  const copyLink = async (room: ServerRoomEntry) => {
    try {
      await copyTextToSystemClipboard(getRoomPageLink(ownerWindow, room));
      flashCopied(`link:${room.roomId}`);
    } catch {
      setActionError(t("myRooms.copyError"));
    }
  };

  const copyCode = async (room: ServerRoomEntry) => {
    if (!shareCode) {
      return;
    }
    try {
      await copyTextToSystemClipboard(shareCode);
      flashCopied(`code:${room.roomId}`);
    } catch {
      setActionError(t("myRooms.copyError"));
    }
  };

  const currentRoom = activeRoomLink
    ? getCollaborationLinkData(activeRoomLink)
    : null;
  const collaborating = !!collabAPI?.isCollaborating();
  const selectedFolder = folders?.find(
    (folder) => folder.id === selectedFolderId,
  );
  const sortedFolders = [...(folders ?? [])].sort((first, second) =>
    first.name.localeCompare(second.name),
  );
  const visibleRooms = rooms?.filter(
    (room) =>
      (selectedFolderId === "all" ||
        (selectedFolderId === "unfiled"
          ? !room.folderId
          : room.folderId === selectedFolderId)) &&
      `${room.name ?? ""} ${room.roomId}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );

  const formatLastActive = (timestamp: number) => {
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    if (minutes < 1) {
      return t("myRooms.timeAgo.justNow");
    }
    if (minutes < 60) {
      return t("myRooms.timeAgo.minutes", { count: minutes });
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48) {
      return t("myRooms.timeAgo.hours", { count: hours });
    }
    return t("myRooms.timeAgo.days", { count: Math.floor(hours / 24) });
  };

  return (
    <div
      ref={pageRef}
      className="RoomsPage"
      role="dialog"
      aria-modal="true"
      aria-label={t("myRooms.title")}
      aria-busy={transitioning || folderBusy}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === KEYS.ESCAPE) {
          close();
        } else if (event.key === KEYS.TAB && pageRef.current) {
          const focusable = queryFocusableElements(pageRef.current);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const active = pageRef.current.ownerDocument.activeElement;
          if (event.shiftKey && active === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="RoomsPage__inner">
        <div className="RoomsPage__header">
          <h2 className="RoomsPage__title">{t("myRooms.title")}</h2>
          <button
            type="button"
            className="RoomsPage__close"
            aria-label={t("myRooms.close")}
            title={t("myRooms.close")}
            onClick={close}
          >
            {CloseIcon}
          </button>
        </div>

        {actionError && (
          <div className="RoomsPage__error" role="alert">
            {actionError}
          </div>
        )}

        <div className="RoomsPage__actions">
          <FilledButton
            size="large"
            label={t("myRooms.newEmptyRoom")}
            icon={PlusIcon}
            onClick={createRoom}
            disabled={transitioning || !collabAPI || !excalidrawAPI}
            status={transitioning ? "loading" : null}
          />
          {collaborating && (
            <FilledButton
              size="large"
              variant="outlined"
              color="danger"
              label={t("myRooms.leaveSession")}
              icon={playerStopFilledIcon}
              onClick={leaveSession}
            />
          )}
        </div>

        <div className="RoomsPage__section">
          <h3 className="RoomsPage__sectionTitle">{t("myRooms.joinTitle")}</h3>
          <JoinRoom onJoin={openRoom} disabled={transitioning} />
        </div>

        <div className="RoomsPage__section">
          <h3 className="RoomsPage__sectionTitle">{t("myRooms.listTitle")}</h3>
          {!loading && folders === null && (
            <div className="RoomsPage__error" role="alert">
              {t("myRooms.foldersLoadingError")}
              <FilledButton label={t("myRooms.retry")} onClick={refreshRooms} />
            </div>
          )}
          {folders !== null && (
            <>
              <div className="RoomsPage__folderToolbar">
                <div className="RoomsPage__folderField">
                  <span>{t("myRooms.folders")}</span>
                  <FolderMenu
                    label={t("myRooms.folders")}
                    value={selectedFolderId}
                    disabled={folderBusy || transitioning || loading}
                    onChange={(value) => {
                      setSelectedFolderId(value);
                      setFolderEditor(null);
                      setConfirmingDeleteFolder(false);
                    }}
                    options={[
                      {
                        value: "all",
                        label: `${t("myRooms.allRooms")} (${
                          rooms?.length ?? 0
                        })`,
                      },
                      {
                        value: "unfiled",
                        label: `${t("myRooms.unfiled")} (${
                          rooms?.filter((room) => !room.folderId).length ?? 0
                        })`,
                      },
                      ...sortedFolders.map((folder) => ({
                        value: folder.id,
                        label: `${folder.name} (${
                          rooms?.filter((room) => room.folderId === folder.id)
                            .length ?? 0
                        })`,
                      })),
                    ]}
                  />
                </div>
                <FilledButton
                  label={t("myRooms.newFolder")}
                  icon={PlusIcon}
                  disabled={folderBusy || transitioning || loading}
                  onClick={() => {
                    setFolderEditor("create");
                    setFolderName("");
                    setConfirmingDeleteFolder(false);
                  }}
                />
                {selectedFolder && (
                  <>
                    <button
                      type="button"
                      className="RoomsPage__actionButton"
                      aria-label={t("myRooms.renameFolder")}
                      title={t("myRooms.renameFolder")}
                      disabled={folderBusy || transitioning || loading}
                      onClick={() => {
                        setFolderEditor("rename");
                        setFolderName(selectedFolder.name);
                        setConfirmingDeleteFolder(false);
                      }}
                    >
                      {pencilIcon}
                    </button>
                    <button
                      type="button"
                      className="RoomsPage__actionButton RoomsPage__actionButton--delete"
                      aria-label={t("myRooms.deleteFolder")}
                      title={t("myRooms.deleteFolder")}
                      disabled={folderBusy || transitioning || loading}
                      onClick={() => {
                        setConfirmingDeleteFolder(true);
                        setFolderEditor(null);
                      }}
                    >
                      {TrashIcon}
                    </button>
                  </>
                )}
              </div>
              {folderEditor && (
                <form
                  className="RoomsPage__folderToolbar"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (folderName.trim() && !folderBusy) {
                      submitFolder();
                    }
                  }}
                >
                  <label className="RoomsPage__folderField">
                    {t("myRooms.folderName")}
                    <input
                      className="RoomsPage__editInput"
                      value={folderName}
                      maxLength={64}
                      autoFocus
                      disabled={folderBusy}
                      onChange={(event) => setFolderName(event.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    className="RoomsPage__actionButton"
                    disabled={!folderName.trim() || folderBusy}
                  >
                    {t("myRooms.saveFolder")}
                  </button>
                  <button
                    type="button"
                    className="RoomsPage__actionButton"
                    disabled={folderBusy}
                    onClick={() => setFolderEditor(null)}
                  >
                    {t("myRooms.cancelFolder")}
                  </button>
                </form>
              )}
              {confirmingDeleteFolder && (
                <div className="RoomsPage__folderToolbar">
                  <span>{t("myRooms.confirmDeleteFolder")}</span>
                  <FilledButton
                    label={t("myRooms.deleteFolder")}
                    color="danger"
                    disabled={folderBusy}
                    onClick={removeFolder}
                  />
                  <FilledButton
                    label={t("myRooms.cancelFolder")}
                    variant="outlined"
                    disabled={folderBusy}
                    onClick={() => setConfirmingDeleteFolder(false)}
                  />
                </div>
              )}
            </>
          )}
          <TextField
            label={t("myRooms.search")}
            type="search"
            fullWidth
            value={search}
            onChange={setSearch}
          />
          {loading && (
            <div className="RoomsPage__empty" role="status">
              {t("myRooms.loading")}
            </div>
          )}
          {!loading && rooms === null && (
            <div className="RoomsPage__error" role="alert">
              {t("myRooms.loadingError")}
              <FilledButton label={t("myRooms.retry")} onClick={refreshRooms} />
            </div>
          )}
          {!loading &&
            rooms !== null &&
            rooms.length === 0 &&
            selectedFolderId === "all" && (
              <div className="RoomsPage__empty">{t("myRooms.empty")}</div>
            )}
          {!loading &&
            rooms !== null &&
            (rooms.length > 0 || selectedFolderId !== "all") && (
              <div className="RoomsPage__list">
                {visibleRooms?.length === 0 && (
                  <div role="status">
                    {t(
                      search.trim()
                        ? "myRooms.noMatches"
                        : "myRooms.emptyFolder",
                    )}
                  </div>
                )}
                {visibleRooms?.map((room) => {
                  const isActive = currentRoom?.roomId === room.roomId;
                  const isEditing = editingRoomId === room.roomId;
                  const isConfirmingDelete =
                    confirmingDeleteRoomId === room.roomId;
                  const isSharing = sharingRoomId === room.roomId;
                  return (
                    <div
                      key={room.roomId}
                      className={`RoomsPage__row${
                        isActive ? " RoomsPage__row--active" : ""
                      }${
                        isEditing || isConfirmingDelete || isSharing
                          ? " RoomsPage__row--busy"
                          : ""
                      }`}
                    >
                      <div className="RoomsPage__rowMain">
                        {isEditing ? (
                          <input
                            className="RoomsPage__editInput"
                            defaultValue={room.name ?? ""}
                            placeholder={t("myRooms.renamePlaceholder")}
                            aria-label={t("myRooms.renamePlaceholder")}
                            autoFocus
                            onKeyDown={(event) => {
                              if (event.key === KEYS.ENTER) {
                                submitRename(room, event.currentTarget.value);
                              } else if (event.key === KEYS.ESCAPE) {
                                event.stopPropagation();
                                setEditingRoomId(null);
                              }
                            }}
                            onBlur={(event) =>
                              submitRename(room, event.target.value)
                            }
                          />
                        ) : (
                          <button
                            type="button"
                            className="RoomsPage__rowLabel"
                            title={room.name || room.roomId}
                            disabled={transitioning}
                            onClick={() => {
                              if (!isActive) {
                                openRoom({
                                  roomId: room.roomId,
                                  roomKey: room.key,
                                });
                              }
                            }}
                          >
                            <span className="RoomsPage__rowId">
                              {room.name || room.roomId}
                            </span>
                          </button>
                        )}
                        <span className="RoomsPage__rowMeta">
                          {room.name && (
                            <span className="RoomsPage__rowSubId">
                              {room.roomId} ·{" "}
                            </span>
                          )}
                          {t("myRooms.lastActive")}{" "}
                          {formatLastActive(room.lastActiveAt)}
                          {room.hasScene && (
                            <span className="RoomsPage__badge">
                              {t("myRooms.hasScene")}
                            </span>
                          )}
                          {isActive && (
                            <span className="RoomsPage__badge RoomsPage__badge--active">
                              {t("myRooms.active")}
                            </span>
                          )}
                        </span>
                      </div>
                      {folders !== null && folders.length > 0 && (
                        <FolderMenu
                          compact
                          label={t("myRooms.moveToFolder", {
                            name: room.name || room.roomId,
                          })}
                          value={room.folderId ?? ""}
                          disabled={folderBusy || transitioning || loading}
                          onChange={(value) => moveRoom(room, value)}
                          options={[
                            { value: "", label: t("myRooms.unfiled") },
                            ...sortedFolders.map((folder) => ({
                              value: folder.id,
                              label: folder.name,
                            })),
                          ]}
                        />
                      )}
                      <div className="RoomsPage__rowActions">
                        {!isEditing && (
                          <button
                            type="button"
                            className="RoomsPage__actionButton"
                            title={t("myRooms.rename")}
                            aria-label={t("myRooms.rename")}
                            disabled={transitioning || folderBusy}
                            onClick={() => {
                              setConfirmingDeleteRoomId(null);
                              setEditingRoomId(room.roomId);
                            }}
                          >
                            {pencilIcon}
                          </button>
                        )}
                        <button
                          type="button"
                          className="RoomsPage__actionButton"
                          title={t("myRooms.share")}
                          aria-label={t("myRooms.share")}
                          disabled={transitioning || folderBusy}
                          onClick={() => toggleShare(room)}
                        >
                          {share}
                        </button>
                        <button
                          type="button"
                          className={`RoomsPage__actionButton RoomsPage__actionButton--delete${
                            isConfirmingDelete
                              ? " RoomsPage__actionButton--confirm"
                              : ""
                          }`}
                          title={t("myRooms.delete")}
                          aria-label={t("myRooms.delete")}
                          disabled={transitioning || folderBusy}
                          onClick={() => {
                            if (isConfirmingDelete) {
                              confirmDelete(room);
                            } else {
                              setEditingRoomId(null);
                              setConfirmingDeleteRoomId(room.roomId);
                            }
                          }}
                        >
                          {isConfirmingDelete
                            ? t("myRooms.confirmDelete")
                            : TrashIcon}
                        </button>
                      </div>
                      {isSharing && (
                        <div className="RoomsPage__sharePanel">
                          <div className="RoomsPage__shareRow">
                            <TextField
                              label={t("myRooms.linkLabel")}
                              readonly
                              fullWidth
                              value={getRoomPageLink(ownerWindow, room)}
                            />
                            <FilledButton
                              size="large"
                              variant="icon"
                              label={
                                copied === `link:${room.roomId}`
                                  ? t("myRooms.copied")
                                  : t("myRooms.copyLink")
                              }
                              icon={copyIcon}
                              onClick={() => copyLink(room)}
                            />
                          </div>
                          <div className="RoomsPage__shareRow">
                            <TextField
                              label={t("myRooms.codeLabel")}
                              readonly
                              fullWidth
                              value={
                                shareCodeLoading
                                  ? "…"
                                  : shareCode ?? t("myRooms.shareError")
                              }
                            />
                            <FilledButton
                              size="large"
                              variant="icon"
                              label={
                                copied === `code:${room.roomId}`
                                  ? t("myRooms.copied")
                                  : t("myRooms.copyCode")
                              }
                              icon={LinkIcon}
                              onClick={() => copyCode(room)}
                              disabled={shareCodeLoading || !shareCode}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      </div>
    </div>
  );
};
