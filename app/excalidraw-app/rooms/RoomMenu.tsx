import { ContextMenu, DropdownMenu } from "radix-ui";
import { useRef } from "react";
import {
  DotsHorizontalIcon,
  checkIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import type { RoomFolder, ServerRoomEntry } from "../data/rooms";

export type RoomMenuActions = {
  folderOptions: { value: string; label: string; depth?: number }[];
  busy: boolean;
  canOpen: boolean;
  onOpen: (room: ServerRoomEntry) => void;
  onRename: (room: ServerRoomEntry) => void;
  onShare: (room: ServerRoomEntry) => void;
  onMove: (room: ServerRoomEntry, folderId: string) => void;
  onDelete: (room: ServerRoomEntry) => void;
};

// ContextMenu and DropdownMenu expose the same item primitives, so one item
// list serves both the right-click menu and the row's "more" button.
type MenuPrimitives = typeof DropdownMenu;

const RoomMenuItems = ({
  Menu,
  room,
  context,
  actions,
  onFocusHandoff,
}: {
  Menu: MenuPrimitives;
  room: ServerRoomEntry;
  context: boolean;
  actions: RoomMenuActions;
  onFocusHandoff?: () => void;
}) => {
  const { t } = useI18n();
  const name = room.name || room.roomId;
  return (
    <>
      {context && (
        <Menu.Item
          className="RoomsPage__contextItem"
          disabled={actions.busy || !actions.canOpen}
          onSelect={() => actions.onOpen(room)}
        >
          {t("myRooms.open")}
        </Menu.Item>
      )}
      <Menu.Item
        className="RoomsPage__contextItem"
        disabled={actions.busy}
        onSelect={() => {
          onFocusHandoff?.();
          actions.onRename(room);
        }}
      >
        {t("myRooms.rename")}
      </Menu.Item>
      {context && (
        <Menu.Item
          className="RoomsPage__contextItem"
          disabled={actions.busy}
          onSelect={() => actions.onShare(room)}
        >
          {t("myRooms.share")}
        </Menu.Item>
      )}
      {actions.folderOptions.length > 1 && (
        <Menu.Sub>
          <Menu.SubTrigger
            className="RoomsPage__contextItem RoomsPage__contextItem--sub"
            disabled={actions.busy}
          >
            {t("myRooms.moveTo")}
          </Menu.SubTrigger>
          <Menu.SubContent
            className="RoomsPage__contextMenu"
            // Name the submenu after the room, not just its trigger text.
            aria-labelledby={undefined}
            aria-label={t("myRooms.moveToFolder", { name })}
            collisionPadding={8}
          >
            <Menu.RadioGroup
              value={room.folderId ?? ""}
              onValueChange={(value) => actions.onMove(room, value)}
            >
              {actions.folderOptions.map((option) => (
                <Menu.RadioItem
                  key={option.value}
                  value={option.value}
                  className="RoomsPage__folderOption"
                >
                  <span className="RoomsPage__folderCheck">
                    <Menu.ItemIndicator>{checkIcon}</Menu.ItemIndicator>
                  </span>
                  <span>{option.label}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.SubContent>
        </Menu.Sub>
      )}
      <Menu.Separator className="RoomsPage__menuSeparator" />
      <Menu.Item
        className="RoomsPage__contextItem RoomsPage__contextItem--danger"
        disabled={actions.busy}
        onSelect={() => {
          onFocusHandoff?.();
          actions.onDelete(room);
        }}
      >
        {t("myRooms.delete")}
      </Menu.Item>
    </>
  );
};

export const RoomContextMenu = ({
  room,
  actions,
}: {
  room: ServerRoomEntry;
  actions: RoomMenuActions;
}) => (
  <ContextMenu.Content
    className="RoomsPage__contextMenu"
    onKeyDown={(event) => event.stopPropagation()}
  >
    <RoomMenuItems
      Menu={ContextMenu as unknown as MenuPrimitives}
      room={room}
      context
      actions={actions}
    />
  </ContextMenu.Content>
);

export const RoomMoreMenu = ({
  room,
  actions,
  disabled,
}: {
  room: ServerRoomEntry;
  actions: RoomMenuActions;
  disabled: boolean;
}) => {
  const { t } = useI18n();
  // Rename and delete move focus to their own field or confirmation, so the
  // menu must not pull focus back to its trigger as it closes.
  const handingOff = useRef(false);
  const label = t("myRooms.moreActions", { name: room.name || room.roomId });
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        type="button"
        className="RoomsPage__actionButton RoomsPage__actionButton--more"
        aria-label={label}
        title={label}
        disabled={disabled}
      >
        {DotsHorizontalIcon}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        className="RoomsPage__contextMenu"
        align="end"
        sideOffset={4}
        collisionPadding={8}
        aria-label={label}
        onKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (handingOff.current) {
            handingOff.current = false;
            event.preventDefault();
          }
        }}
      >
        <RoomMenuItems
          Menu={DropdownMenu}
          room={room}
          context={false}
          actions={actions}
          onFocusHandoff={() => {
            handingOff.current = true;
          }}
        />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
};

export type FolderMenuActions = {
  busy: boolean;
  onCreate: (folder: RoomFolder) => void;
  onRename: (folder: RoomFolder) => void;
  onDelete: (folder: RoomFolder) => void;
};

const FolderMenuItems = ({
  Menu,
  folder,
  actions,
  onFocusHandoff,
}: {
  Menu: MenuPrimitives;
  folder: RoomFolder;
  actions: FolderMenuActions;
  onFocusHandoff?: () => void;
}) => {
  const { t } = useI18n();
  return (
    <>
      <Menu.Item
        className="RoomsPage__contextItem"
        disabled={actions.busy}
        onSelect={() => {
          onFocusHandoff?.();
          actions.onCreate(folder);
        }}
      >
        {t("myRooms.newFolder")}
      </Menu.Item>
      <Menu.Item
        className="RoomsPage__contextItem"
        disabled={actions.busy}
        onSelect={() => {
          onFocusHandoff?.();
          actions.onRename(folder);
        }}
      >
        {t("myRooms.renameFolder")}
      </Menu.Item>
      <Menu.Separator className="RoomsPage__menuSeparator" />
      <Menu.Item
        className="RoomsPage__contextItem RoomsPage__contextItem--danger"
        disabled={actions.busy}
        onSelect={() => {
          onFocusHandoff?.();
          actions.onDelete(folder);
        }}
      >
        {t("myRooms.deleteFolder")}
      </Menu.Item>
    </>
  );
};

export const FolderContextMenu = ({
  folder,
  actions,
}: {
  folder: RoomFolder;
  actions: FolderMenuActions;
}) => (
  <ContextMenu.Content
    className="RoomsPage__contextMenu"
    onKeyDown={(event) => event.stopPropagation()}
  >
    <FolderMenuItems
      Menu={ContextMenu as unknown as MenuPrimitives}
      folder={folder}
      actions={actions}
    />
  </ContextMenu.Content>
);

export const FolderMoreMenu = ({
  folder,
  actions,
  disabled,
}: {
  folder: RoomFolder;
  actions: FolderMenuActions;
  disabled: boolean;
}) => {
  const { t } = useI18n();
  const handingOff = useRef(false);
  const label = t("myRooms.folderMoreActions", { name: folder.name });
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        type="button"
        className="RoomsPage__actionButton RoomsPage__actionButton--more"
        aria-label={label}
        title={label}
        disabled={disabled}
      >
        {DotsHorizontalIcon}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        className="RoomsPage__contextMenu"
        align="end"
        sideOffset={4}
        collisionPadding={8}
        aria-label={label}
        onKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (handingOff.current) {
            handingOff.current = false;
            event.preventDefault();
          }
        }}
      >
        <FolderMenuItems
          Menu={DropdownMenu}
          folder={folder}
          actions={actions}
          onFocusHandoff={() => {
            handingOff.current = true;
          }}
        />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
};
