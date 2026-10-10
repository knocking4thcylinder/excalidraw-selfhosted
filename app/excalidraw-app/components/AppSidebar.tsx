import { DefaultSidebar, Sidebar } from "@excalidraw/excalidraw";
import { LoadIcon } from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { useExcalidrawContainer } from "@excalidraw/excalidraw/components/App";

import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { RoomsPage } from "../rooms/RoomsPage";
import { useRoomRegistry } from "../rooms/useRoomRegistry";

import "./AppSidebar.scss";

import type { CollabAPI } from "../collab/Collab";

const SIDEBAR_TAB_TRIGGER_CLASS = "excalidraw-button sidebar-tab-trigger";

export const AppSidebar = ({
  collabAPI,
  excalidrawAPI,
  onClose,
  onStateChange,
}: {
  collabAPI: CollabAPI | null;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onClose: () => void;
  onStateChange: (state: AppState["openSidebar"]) => void;
}) => {
  const { t } = useI18n();
  const { container } = useExcalidrawContainer();
  const ownerWindow = container?.ownerDocument.defaultView;

  useRoomRegistry(ownerWindow, true);

  return (
    <>
      <DefaultSidebar.Trigger
        tab="rooms"
        title={t("myRooms.explorer")}
        icon={LoadIcon}
      />
      <DefaultSidebar onStateChange={onStateChange}>
        <DefaultSidebar.TabTriggers>
          <Sidebar.TabTrigger
            tab="rooms"
            className={`${SIDEBAR_TAB_TRIGGER_CLASS} sidebar-tab-trigger--rooms`}
            aria-label={t("myRooms.explorer")}
            title={t("myRooms.explorer")}
          >
            {LoadIcon}
          </Sidebar.TabTrigger>
        </DefaultSidebar.TabTriggers>
        <Sidebar.Tab tab="rooms" className="rooms-explorer-tab">
          <RoomsPage
            collabAPI={collabAPI}
            excalidrawAPI={excalidrawAPI}
            onClose={onClose}
          />
        </Sidebar.Tab>
      </DefaultSidebar>
    </>
  );
};
