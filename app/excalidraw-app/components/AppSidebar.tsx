import { DefaultSidebar, Sidebar, THEME } from "@excalidraw/excalidraw";
import {
  messageCircleIcon,
  presentationIcon,
  LoadIcon,
} from "@excalidraw/excalidraw/components/icons";
import { LinkButton } from "@excalidraw/excalidraw/components/LinkButton";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
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

type SidebarPromoCopyProps = {
  text: string;
};

const SidebarPromoCopy = (props: SidebarPromoCopyProps) => {
  return (
    <div className="app-sidebar-promo-copy">
      <div className="app-sidebar-promo-illustration" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 300 250"
          className="app-sidebar-promo-heart"
        >
          <path
            d="M 145 75
           C 110 35, 60 55, 65 120
           C 70 180, 140 190, 215 200
           C 225 180, 260 110, 235 55
           C 210 -5, 140 20, 160 105"
            fill="none"
            stroke="#D06B64"
            strokeWidth="16"
            strokeLinecap="round"
          />
        </svg>

        <div className="app-sidebar-promo-trial-note excalifont">
          14 days of
          <br />
          free trial
        </div>
        <svg
          className="app-sidebar-promo-trial-arrow"
          viewBox="0 0 72 48"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M5 6C23 1 50 8 48 32"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M42 26L48 32L54 26"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="app-sidebar-promo-text">{props.text}</div>
    </div>
  );
};

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
  const { theme, openSidebar } = useUIAppState();
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
          <Sidebar.TabTrigger
            tab="comments"
            className={
              openSidebar?.tab === "comments"
                ? SIDEBAR_TAB_TRIGGER_CLASS
                : `${SIDEBAR_TAB_TRIGGER_CLASS} sidebar-tab-trigger--idle`
            }
            aria-label="Comments"
            title="Comments"
          >
            {messageCircleIcon}
          </Sidebar.TabTrigger>
          <Sidebar.TabTrigger
            tab="presentation"
            className={
              openSidebar?.tab === "presentation"
                ? SIDEBAR_TAB_TRIGGER_CLASS
                : `${SIDEBAR_TAB_TRIGGER_CLASS} sidebar-tab-trigger--idle`
            }
            aria-label="Presentations"
            title="Presentations"
          >
            {presentationIcon}
          </Sidebar.TabTrigger>
        </DefaultSidebar.TabTriggers>
        <Sidebar.Tab tab="rooms" className="rooms-explorer-tab">
          <RoomsPage
            collabAPI={collabAPI}
            excalidrawAPI={excalidrawAPI}
            onClose={onClose}
          />
        </Sidebar.Tab>
        <Sidebar.Tab tab="comments">
          <div className="app-sidebar-promo-container">
            <div
              className="app-sidebar-promo-image"
              style={{
                ["--image-source" as any]: `url(/sidebar-comments-promo-${
                  theme === THEME.DARK ? "dark" : "light"
                }.jpg)`,
                opacity: 0.9,
              }}
            />
            <SidebarPromoCopy text="Make comments with Excalidraw+" />
            <LinkButton
              href={`${
                import.meta.env.VITE_APP_PLUS_LP
              }/plus?utm_source=excalidraw&utm_medium=app&utm_content=comments_promo#excalidraw-redirect`}
            >
              Sign up now
            </LinkButton>
          </div>
        </Sidebar.Tab>
        <Sidebar.Tab tab="presentation" className="px-3">
          <div className="app-sidebar-promo-container">
            <div
              className="app-sidebar-promo-image"
              style={{
                ["--image-source" as any]: `url(/sidebar-presentation-promo-${
                  theme === THEME.DARK ? "dark" : "light"
                }.jpg)`,
                opacity: 0.7,
              }}
            />
            <SidebarPromoCopy text="Create presentation with Excalidraw+" />
            <LinkButton
              href={`${
                import.meta.env.VITE_APP_PLUS_LP
              }/plus?utm_source=excalidraw&utm_medium=app&utm_content=presentations_promo#excalidraw-redirect`}
            >
              Sign up now
            </LinkButton>
          </div>
        </Sidebar.Tab>
      </DefaultSidebar>
    </>
  );
};
