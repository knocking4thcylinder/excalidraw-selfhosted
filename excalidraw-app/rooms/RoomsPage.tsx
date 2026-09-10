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
import { useExcalidrawContainer } from "@excalidraw/excalidraw/components/App";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { APP_NAME, KEYS } from "@excalidraw/common";
import { useEffect, useRef, useState } from "react";

import { getCollaborationLink, getCollaborationLinkData } from "../data";
import {
  deleteRoom,
  fetchRooms,
  renameRoom,
  type ServerRoomEntry,
} from "../data/rooms";

import { JoinRoom } from "../share/JoinRoom";

import { closeRoomsPage, getRoomPageLink } from "./roomsRoute";
import "./RoomsPage.scss";

import type { CollabAPI } from "../collab/Collab";

// Standalone rooms manager: switch/create/join/rename/delete/share rooms.
// Rendered as a full-screen overlay above the canvas (the canvas, Collab
// socket and scene stay mounted and alive underneath); visibility is driven
// by the #rooms hash route, so the page is bookmarkable and works in the APK
// WebView.
export const RoomsPage = ({
  collabAPI,
  onClose,
}: {
  collabAPI: CollabAPI | null;
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

  useEffect(() => {
    let alive = true;
    fetchRooms().then((result) => {
      if (!alive) {
        return;
      }
      setRooms(result);
      setLoading(false);
    });
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
    setRooms(await fetchRooms());
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

  const openRoom = async (room: { roomId: string; roomKey: string }) => {
    if (!collabAPI) {
      return;
    }
    // Hash navigation alone can't switch: startCollaboration() early-returns
    // while the old socket exists, so tear it down first (no confirm).
    stopSilently();
    ownerWindow.history.pushState(
      {},
      APP_NAME,
      getCollaborationLink({ roomId: room.roomId, roomKey: room.roomKey }),
    );
    await collabAPI.startCollaboration({
      roomId: room.roomId,
      roomKey: room.roomKey,
    });
    // pushState doesn't fire hashchange, so hide the page explicitly.
    onClose();
  };

  const createRoom = async () => {
    if (!collabAPI) {
      return;
    }
    setActionError(null);
    stopSilently();
    const scene = await collabAPI.startCollaboration(null);
    // startCollaboration pushStates the new #room= link itself (no hashchange
    // event), so hide the page explicitly. A null return means the socket
    // still exists and nothing was created.
    if (scene !== null) {
      onClose();
    } else {
      setActionError(t("myRooms.createError"));
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
      if (resp.ok) {
        const data = await resp.json();
        setShareCode(typeof data?.code === "string" ? data.code : null);
      } else {
        setShareCode(null);
      }
    } catch {
      setShareCode(null);
    } finally {
      setShareCodeLoading(false);
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

  const currentRoom = getCollaborationLinkData(ownerWindow.location.href);
  const collaborating = !!collabAPI?.isCollaborating();

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
    <div className="RoomsPage" role="dialog" aria-label={t("myRooms.title")}>
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

        {actionError && <div className="RoomsPage__error">{actionError}</div>}

        <div className="RoomsPage__actions">
          <FilledButton
            size="large"
            label={t("myRooms.newRoom")}
            icon={PlusIcon}
            onClick={createRoom}
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
          <JoinRoom onJoin={(linkData) => openRoom(linkData)} />
        </div>

        <div className="RoomsPage__section">
          <h3 className="RoomsPage__sectionTitle">{t("myRooms.listTitle")}</h3>
          {loading && <div className="RoomsPage__empty">…</div>}
          {!loading && rooms === null && (
            <div className="RoomsPage__error">{t("myRooms.loadingError")}</div>
          )}
          {!loading && rooms !== null && rooms.length === 0 && (
            <div className="RoomsPage__empty">{t("myRooms.empty")}</div>
          )}
          {!loading && rooms !== null && rooms.length > 0 && (
            <div className="RoomsPage__list">
              {rooms.map((room) => {
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
                    }`}
                  >
                    <div className="RoomsPage__rowMain">
                      {isEditing ? (
                        <input
                          className="RoomsPage__editInput"
                          defaultValue={room.name ?? ""}
                          placeholder={t("myRooms.renamePlaceholder")}
                          autoFocus
                          onKeyDown={(event) => {
                            if (event.key === KEYS.ENTER) {
                              submitRename(room, event.currentTarget.value);
                            } else if (event.key === KEYS.ESCAPE) {
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
                          title={room.roomId}
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
                    <div className="RoomsPage__rowActions">
                      {!isEditing && (
                        <button
                          type="button"
                          className="RoomsPage__actionButton"
                          title={t("myRooms.rename")}
                          aria-label={t("myRooms.rename")}
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
