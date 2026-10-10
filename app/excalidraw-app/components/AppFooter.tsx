import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { usersIcon } from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import { useAtomValue } from "../app-jotai";
import {
  isOfflineAtom,
  offlineRoomPendingAtom,
  roomValidationPendingAtom,
} from "../collab/Collab";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";
import { EncryptedIcon } from "./EncryptedIcon";

export const AppFooter = React.memo(
  ({
    onChange,
    onRoomsOpen,
  }: {
    onChange: () => void;
    onRoomsOpen?: () => void;
  }) => {
    const { t } = useI18n();
    const isOffline = useAtomValue(isOfflineAtom);
    const pendingRoom = useAtomValue(offlineRoomPendingAtom);
    const validatingRoom = useAtomValue(roomValidationPendingAtom);
    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}
          {(isOffline || pendingRoom || validatingRoom) && (
            <span className="room-connection-status" role="status">
              {t(
                isOffline || pendingRoom
                  ? "myRooms.offline"
                  : "myRooms.checking",
              )}
            </span>
          )}
          {onRoomsOpen && (
            <FilledButton
              variant="outlined"
              label={t("myRooms.title")}
              icon={usersIcon}
              onClick={onRoomsOpen}
            />
          )}
          <EncryptedIcon />
        </div>
      </Footer>
    );
  },
);
