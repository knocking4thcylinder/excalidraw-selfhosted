import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { vi } from "vitest";
import { clear, createStore } from "idb-keyval";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  cacheFolders,
  cacheRooms,
  clearRoomMemoryCache,
  flushRoomCache,
} from "../data/roomCache";

import { appJotaiStore, Provider } from "../app-jotai";
import { activeRoomLinkAtom } from "../collab/Collab";
import {
  deleteRoom,
  deleteRoomFolder,
  fetchRoomFolders,
  fetchRooms,
  moveRoomToFolder,
  saveRoomFolder,
} from "../data/rooms";
import { RoomsPage } from "../rooms/RoomsPage";
import { roomFoldersAtom, roomsRegistryAtom } from "../rooms/explorerState";
import { JoinRoom } from "../share/JoinRoom";
import { ShareDialog, shareDialogStateAtom } from "../share/ShareDialog";

import type { CollabAPI } from "../collab/Collab";

vi.mock("@excalidraw/excalidraw/components/App", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@excalidraw/excalidraw/components/App")
  >()),
  useExcalidrawContainer: () => ({ container: document.body }),
}));

vi.mock("../collab/Collab", async () => {
  const { atom } = await import("../app-jotai");
  return { activeRoomLinkAtom: atom<string | null>(null) };
});

vi.mock("@excalidraw/excalidraw/i18n", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@excalidraw/excalidraw/i18n")
  >();
  return { ...actual, useI18n: () => ({ t: actual.t, langCode: "en" }) };
});

vi.mock("../data/rooms", () => ({
  fetchRooms: vi.fn(),
  renameRoom: vi.fn(),
  deleteRoom: vi.fn(),
  fetchRoomFolders: vi.fn(),
  saveRoomFolder: vi.fn(),
  deleteRoomFolder: vi.fn(),
  moveRoomToFolder: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock(
  "@excalidraw/excalidraw/context/ui-appState",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@excalidraw/excalidraw/context/ui-appState")
    >()),
    useUIAppState: () => ({ openDialog: null }),
  }),
);

const rooms = [
  {
    roomId: "room-a",
    key: "key-a",
    name: "Algebra",
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    hasScene: true,
  },
  {
    roomId: "room-b",
    key: "key-b",
    name: "Physics",
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    hasScene: false,
  },
];

const mountRooms = (props: Partial<Parameters<typeof RoomsPage>[0]> = {}) => {
  const onClose = vi.fn();
  return {
    ...render(
      <RoomsPage
        collabAPI={null}
        excalidrawAPI={null}
        onClose={onClose}
        {...props}
      />,
    ),
    onClose,
  };
};

const chooseFolder = async (label: string, option: string) => {
  fireEvent.keyDown(await screen.findByRole("button", { name: label }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: option }));
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
};

const chooseTreeFolder = async (path: string) => {
  const names = path.replace(/ \(\d+\)$/, "").split(" / ");
  for (let index = 0; index < names.length; index++) {
    const name = names.slice(0, index + 1).join(" / ");
    const button = await screen.findByRole("button", {
      name: `Open folder ${name}`,
    });
    if (
      index === names.length - 1 ||
      button.parentElement?.getAttribute("aria-expanded") !== "true"
    ) {
      fireEvent.click(button);
    }
  }
};

beforeEach(async () => {
  await flushRoomCache();
  clearRoomMemoryCache();
  await clear(createStore("excalidraw-rooms-db", "cache"));
  appJotaiStore.set(roomsRegistryAtom, null);
  appJotaiStore.set(roomFoldersAtom, null);
  vi.mocked(fetchRooms).mockResolvedValue(rooms);
  vi.mocked(fetchRoomFolders).mockResolvedValue([]);
  appJotaiStore.set(activeRoomLinkAtom, null);
  appJotaiStore.set(shareDialogStateAtom, { isOpen: false });
});

afterEach(async () => {
  cleanup();
  await flushRoomCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("rooms UI", () => {
  it("loads persisted rooms and folders while network refresh is pending, including offline", async () => {
    await cacheRooms(rooms.map((room) => ({ ...room, folderId: "school" })));
    await cacheFolders([{ id: "school", name: "School" }]);
    let resolveRooms!: (rooms: Awaited<ReturnType<typeof fetchRooms>>) => void;
    let resolveFolders!: (
      folders: Awaited<ReturnType<typeof fetchRoomFolders>>,
    ) => void;
    vi.mocked(fetchRooms).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRooms = resolve;
        }),
    );
    vi.mocked(fetchRoomFolders).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFolders = resolve;
        }),
    );
    mountRooms();
    expect(
      await screen.findByRole("button", { name: "Open folder School" }),
    ).toBeInTheDocument();
    await chooseTreeFolder("School");
    expect(
      await screen.findByRole("treeitem", { name: "Algebra" }),
    ).toBeInTheDocument();
    await act(async () => {
      resolveRooms(null);
      resolveFolders(null);
    });
    expect(
      screen.getByRole("treeitem", { name: "Algebra" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open folder School" }),
    ).toBeInTheDocument();
  });
  it("reopens immediately with cached rooms while a fresh request is still pending", async () => {
    const first = mountRooms();
    await screen.findByRole("treeitem", { name: "Algebra" });
    first.unmount();
    let resolveRooms!: (result: Awaited<ReturnType<typeof fetchRooms>>) => void;
    vi.mocked(fetchRooms).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRooms = resolve;
        }),
    );
    mountRooms();
    expect(
      screen.getByRole("treeitem", { name: "Algebra" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => resolveRooms(rooms));
  });

  it("shows rooms before a slow folder request finishes", async () => {
    let resolveFolders!: (
      folders: Awaited<ReturnType<typeof fetchRoomFolders>>,
    ) => void;
    vi.mocked(fetchRoomFolders).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFolders = resolve;
        }),
    );
    mountRooms();
    expect(
      await screen.findByRole("button", { name: "Algebra" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => resolveFolders([]));
  });

  it("keeps the room tree visible during a background refresh", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValueOnce(null);
    mountRooms();
    await screen.findByRole("button", { name: "Algebra" });
    let resolveRooms!: (result: Awaited<ReturnType<typeof fetchRooms>>) => void;
    vi.mocked(fetchRooms).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRooms = resolve;
        }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      screen.getByRole("treeitem", { name: "Algebra" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => resolveRooms(rooms));
  });

  it("deletes a room only after confirming and immediately removes its tree row", async () => {
    vi.mocked(deleteRoom).mockResolvedValue(true);
    mountRooms();
    const algebra = await screen.findByRole("treeitem", { name: "Algebra" });
    fireEvent.click(within(algebra).getByRole("button", { name: "Delete" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Delete" });
    expect(confirmation).toHaveTextContent("Algebra");
    expect(
      within(confirmation).getByRole("button", { name: "Delete" }),
    ).toHaveFocus();
    expect(deleteRoom).not.toHaveBeenCalled();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("treeitem", { name: "Algebra" }),
      ).not.toBeInTheDocument(),
    );
    expect(deleteRoom).toHaveBeenCalledWith("room-a", "key-a");
    expect(
      screen.getByRole("treeitem", { name: "Physics" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("cancels room deletion without closing Explorer or calling the API", async () => {
    const { onClose } = mountRooms();
    fireEvent.contextMenu(
      await screen.findByRole("treeitem", { name: "Physics" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Delete" });
    expect(confirmation).toHaveTextContent("Physics");
    fireEvent.keyDown(confirmation, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the failed deletion visible so the user can retry", async () => {
    vi.mocked(deleteRoom)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mountRooms();
    fireEvent.click(
      within(
        await screen.findByRole("treeitem", { name: "Algebra" }),
      ).getByRole("button", { name: "Delete" }),
    );
    const confirmation = screen.getByRole("alertdialog", { name: "Delete" });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Delete" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't delete the room",
    );
    expect(
      screen.getByRole("treeitem", { name: "Algebra" }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("treeitem", { name: "Algebra" }),
      ).not.toBeInTheDocument(),
    );
    expect(deleteRoom).toHaveBeenCalledTimes(2);
  });

  it("blocks repeated deletion requests until the first one completes", async () => {
    let resolveDelete!: (deleted: boolean) => void;
    vi.mocked(deleteRoom).mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve;
      }),
    );
    mountRooms();
    fireEvent.click(
      within(
        await screen.findByRole("treeitem", { name: "Algebra" }),
      ).getByRole("button", { name: "Delete" }),
    );
    const button = within(
      screen.getByRole("alertdialog", { name: "Delete" }),
    ).getByRole("button", { name: "Delete" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(deleteRoom).toHaveBeenCalledTimes(1);
    await act(async () => resolveDelete(true));
    expect(
      screen.queryByRole("treeitem", { name: "Algebra" }),
    ).not.toBeInTheDocument();
  });

  it.each(["Escape", "blur"])(
    "cancels an empty inline folder draft on %s",
    async (action) => {
      mountRooms();
      fireEvent.click(
        await screen.findByRole("button", { name: "New folder" }),
      );
      const input = screen.getByRole("textbox", { name: "Folder name" });
      expect(input).toHaveFocus();
      expect(input.closest('[role="treeitem"]')).toHaveAttribute(
        "aria-level",
        "1",
      );
      expect(
        screen.queryByRole("button", { name: "Parent folder" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save folder" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Cancel" }),
      ).not.toBeInTheDocument();
      if (action === "Escape") {
        fireEvent.keyDown(input, { key: "Escape" });
      } else {
        fireEvent.blur(input);
      }
      expect(
        screen.queryByRole("textbox", { name: "Folder name" }),
      ).not.toBeInTheDocument();
      expect(saveRoomFolder).not.toHaveBeenCalled();
    },
  );

  it("saves a nonempty inline folder draft on blur", async () => {
    vi.mocked(saveRoomFolder).mockResolvedValue({
      id: "school",
      name: "School",
    });
    mountRooms();
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    const input = screen.getByRole("textbox", { name: "Folder name" });
    fireEvent.change(input, { target: { value: "School" } });
    fireEvent.blur(input);
    expect(
      await screen.findByRole("treeitem", { name: "School" }),
    ).toBeInTheDocument();
    expect(saveRoomFolder).toHaveBeenCalledWith("School", undefined, null);
    expect(saveRoomFolder).toHaveBeenCalledTimes(1);
  });

  it("renames a nested folder inline without changing its parent", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
    ]);
    vi.mocked(saveRoomFolder).mockResolvedValue({
      id: "math",
      name: "Calculus",
      parentId: "school",
    });
    mountRooms();
    await chooseTreeFolder("School / Math");
    fireEvent.keyDown(screen.getByRole("treeitem", { name: "Math" }), {
      key: "F2",
    });
    const input = screen.getByRole("textbox", { name: "Folder name" });
    expect(input.closest('[role="treeitem"]')).toHaveAttribute(
      "aria-level",
      "2",
    );
    fireEvent.change(input, { target: { value: "Calculus" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(
      await screen.findByRole("treeitem", { name: "Calculus" }),
    ).toHaveAttribute("aria-level", "2");
    expect(saveRoomFolder).toHaveBeenCalledWith("Calculus", "math", "school");
    expect(saveRoomFolder).toHaveBeenCalledTimes(1);
  });

  it("renames rooms through the Explorer context menu", async () => {
    mountRooms();
    fireEvent.contextMenu(
      await screen.findByRole("treeitem", { name: "Algebra" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "Room name" })).toHaveValue(
      "Algebra",
    );
    expect(screen.getByRole("textbox", { name: "Room name" })).toHaveFocus();
  });

  it("renames focused folders with F2 and cancels without closing the page", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    const { onClose } = mountRooms();
    const school = await screen.findByRole("treeitem", { name: "School" });
    fireEvent.keyDown(school, { key: "F2" });
    const input = screen.getByRole("textbox", { name: "Folder name" });
    expect(input).toHaveValue("School");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.queryByRole("textbox", { name: "Folder name" }),
    ).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renames focused rooms with F2", async () => {
    mountRooms();
    const algebra = await screen.findByRole("treeitem", { name: "Algebra" });
    fireEvent.keyDown(algebra, { key: "F2" });
    const input = screen.getByRole("textbox", { name: "Room name" });
    expect(input).toHaveValue("Algebra");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.queryByRole("textbox", { name: "Room name" }),
    ).not.toBeInTheDocument();
  });

  it("drags rooms into folders and back to the root", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(moveRoomToFolder).mockResolvedValue(true);
    mountRooms();
    const algebra = await screen.findByRole("treeitem", { name: "Algebra" });
    const transfer = { setData: vi.fn() };
    fireEvent.dragStart(algebra, { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("treeitem", { name: "School" }), {
      dataTransfer: transfer,
    });
    await waitFor(() =>
      expect(moveRoomToFolder).toHaveBeenCalledWith(rooms[0], "school"),
    );
    const nested = await screen.findByRole("treeitem", { name: "Algebra" });
    expect(nested).toHaveAttribute("aria-level", "2");
    fireEvent.dragStart(nested, { dataTransfer: transfer });
    fireEvent.drop(screen.getByText("Top level"), { dataTransfer: transfer });
    await waitFor(() =>
      expect(moveRoomToFolder).toHaveBeenLastCalledWith(
        { ...rooms[0], folderId: "school" },
        null,
      ),
    );
    expect(
      await screen.findByRole("treeitem", { name: "Algebra" }),
    ).toHaveAttribute("aria-level", "1");
    expect(transfer.setData).toHaveBeenCalledWith(
      "application/x-excalidraw-room-tree",
      "room:room-a",
    );
  });

  it("drags folders with their subtrees and rejects cyclic drops", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
      { id: "work", name: "Work" },
    ]);
    vi.mocked(saveRoomFolder).mockResolvedValue({
      id: "school",
      name: "School",
      parentId: "work",
    });
    mountRooms();
    await chooseTreeFolder("School");
    const transfer = { setData: vi.fn() };
    const school = screen.getByRole("treeitem", { name: "School" });
    fireEvent.dragStart(school, { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("treeitem", { name: "Math" }), {
      dataTransfer: transfer,
    });
    expect(saveRoomFolder).not.toHaveBeenCalled();
    fireEvent.drop(school, { dataTransfer: transfer });
    expect(saveRoomFolder).not.toHaveBeenCalled();
    fireEvent.drop(screen.getByRole("treeitem", { name: "Work" }), {
      dataTransfer: transfer,
    });
    await waitFor(() =>
      expect(saveRoomFolder).toHaveBeenCalledWith("School", "school", "work"),
    );
    expect(
      await screen.findByRole("button", {
        name: "Open folder Work / School / Math",
      }),
    ).toBeInTheDocument();
  });

  it("keeps room membership when a drag move fails", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(moveRoomToFolder).mockResolvedValue(false);
    mountRooms();
    const algebra = await screen.findByRole("treeitem", { name: "Algebra" });
    const transfer = { setData: vi.fn() };
    fireEvent.dragStart(algebra, { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("treeitem", { name: "School" }), {
      dataTransfer: transfer,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't move");
    expect(screen.getByRole("treeitem", { name: "Algebra" })).toHaveAttribute(
      "aria-level",
      "1",
    );
  });

  it("finds folder names and includes rooms below matching branches", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "math" },
      rooms[1],
    ]);
    mountRooms();
    await screen.findByRole("treeitem", { name: "School" });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "School" },
    });
    expect(screen.getByRole("treeitem", { name: "Algebra" })).toHaveAttribute(
      "aria-level",
      "3",
    );
    expect(
      screen.queryByRole("treeitem", { name: "Physics" }),
    ).not.toBeInTheDocument();
  });

  it("creates subfolders inside the selected folder", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(saveRoomFolder).mockResolvedValue({
      id: "math",
      name: "Math",
      parentId: "school",
    });
    mountRooms();
    await chooseTreeFolder("School (0)");
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(
      screen.queryByRole("button", { name: "Parent folder" }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByRole("textbox", { name: "Folder name" })
        .closest('[role="treeitem"]'),
    ).toHaveAttribute("aria-level", "2");
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
      target: { value: "Math" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Folder name" }), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "All rooms" }),
      ).toHaveTextContent("School / Math"),
    );
    expect(saveRoomFolder).toHaveBeenCalledWith("Math", undefined, "school");
  });

  it("expands nested folders without filtering sibling rooms", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "school" },
      { ...rooms[1], folderId: "math" },
    ]);
    mountRooms();
    const school = await screen.findByRole("treeitem", { name: "School" });
    expect(school).toHaveAttribute("aria-expanded", "false");
    await chooseTreeFolder("School");
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Physics" }),
    ).not.toBeInTheDocument();
    await chooseTreeFolder("School / Math");
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "Physics" })).toHaveAttribute(
      "aria-level",
      "3",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open folder School" }));
    expect(
      screen.queryByRole("button", { name: "Algebra" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("treeitem", { name: "Math" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Folders" }),
    ).not.toBeInTheDocument();
  });

  it("moves rooms into deeply nested folders", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
      { id: "algebra", name: "Algebra", parentId: "math" },
    ]);
    vi.mocked(moveRoomToFolder).mockResolvedValue(true);
    mountRooms();
    await chooseFolder("Move Algebra to folder", "School / Math / Algebra");
    expect(moveRoomToFolder).toHaveBeenCalledWith(rooms[0], "algebra");
    await chooseTreeFolder("School (1)");
    expect(
      screen.queryByRole("button", { name: "Algebra" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Physics" })).toBeInTheDocument();
    await chooseTreeFolder("School / Math / Algebra");
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
  });

  it("renames a folder inline without moving it or its descendants", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
      { id: "work", name: "Work" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "math" },
    ]);
    vi.mocked(saveRoomFolder).mockResolvedValue({
      id: "school",
      name: "Classes",
    });
    mountRooms();
    await chooseTreeFolder("School (1)");
    fireEvent.click(screen.getByRole("button", { name: "Rename folder" }));
    const input = screen.getByRole("textbox", { name: "Folder name" });
    expect(input.closest('[role="treeitem"]')).toHaveAttribute(
      "aria-label",
      "School",
    );
    expect(
      screen.queryByRole("button", { name: "Parent folder" }),
    ).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Classes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "All rooms" }),
      ).toHaveTextContent("Classes"),
    );
    expect(saveRoomFolder).toHaveBeenCalledWith("Classes", "school", null);
    expect(
      screen.getByRole("button", { name: "Open folder Classes / Math" }),
    ).toBeInTheDocument();
  });

  it("moves a nested folder back to the root by dragging", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
    ]);
    vi.mocked(saveRoomFolder).mockResolvedValue({ id: "math", name: "Math" });
    mountRooms();
    await chooseTreeFolder("School / Math (0)");
    const transfer = { setData: vi.fn() };
    fireEvent.dragStart(screen.getByRole("treeitem", { name: "Math" }), {
      dataTransfer: transfer,
    });
    fireEvent.drop(screen.getByText("Top level"), { dataTransfer: transfer });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "All rooms" }),
      ).toHaveTextContent("Math"),
    );
    expect(saveRoomFolder).toHaveBeenCalledWith("Math", "math", null);
  });

  it("deletes the whole folder subtree without deleting its rooms", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "math" },
    ]);
    vi.mocked(deleteRoomFolder).mockResolvedValue(true);
    mountRooms();
    await chooseTreeFolder("School (1)");
    fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    expect(screen.getByText(/and its subfolders/)).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByText(/and its subfolders/).parentElement!).getByRole(
        "button",
        { name: "Delete folder" },
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "All rooms" }),
      ).toHaveTextContent("Rooms"),
    );
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Move Algebra to folder" }),
    ).not.toBeInTheDocument();
  });

  it("searches across collapsed folders and restores expansion after clearing", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "math" },
      rooms[1],
    ]);
    mountRooms();
    await screen.findByRole("treeitem", { name: "School" });
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "Algebra" } });
    expect(screen.getByRole("treeitem", { name: "School" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("treeitem", { name: "Math" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Physics" }),
    ).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("No rooms match");
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("treeitem", { name: "School" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      screen.queryByRole("button", { name: "Algebra" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Physics" })).toBeInTheDocument();
  });

  it("creates an empty folder and keeps it after remounting", async () => {
    vi.mocked(saveRoomFolder).mockResolvedValue({
      id: "school",
      name: "School",
    });
    const { unmount } = mountRooms();
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    const name = screen.getByRole("textbox", { name: "Folder name" });
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: " School " } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Folder name" }), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "All rooms" }),
      ).toHaveTextContent("School"),
    );
    expect(saveRoomFolder).toHaveBeenCalledWith("School", undefined, null);
    expect(
      screen.getByRole("treeitem", { name: "School" }),
    ).toBeInTheDocument();
    unmount();
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    mountRooms();
    await chooseTreeFolder("School (0)");
    expect(screen.getByRole("button", { name: "All rooms" })).toHaveTextContent(
      "School",
    );
  });

  it("renames a folder without changing room membership", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "school" },
    ]);
    vi.mocked(saveRoomFolder).mockResolvedValue({
      id: "school",
      name: "Classes",
    });
    mountRooms();
    await chooseTreeFolder("School (1)");
    fireEvent.click(screen.getByRole("button", { name: "Rename folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
      target: { value: "Classes" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Folder name" }), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "All rooms" }),
      ).toHaveTextContent("Classes"),
    );
    expect(saveRoomFolder).toHaveBeenCalledWith("Classes", "school", null);
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
  });

  it("moves rooms to folders and back to Unfiled", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(moveRoomToFolder).mockResolvedValue(true);
    mountRooms();
    await screen.findByRole("button", {
      name: "Move Algebra to folder",
    });
    await chooseFolder("Move Algebra to folder", "School");
    await chooseTreeFolder("School");
    expect(
      screen.getByRole("button", { name: "Move Algebra to folder" }),
    ).toHaveTextContent("School");
    expect(moveRoomToFolder).toHaveBeenCalledWith(rooms[0], "school");
    await chooseFolder("Move Algebra to folder", "Unfiled");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Move Algebra to folder" }),
      ).toHaveTextContent("Unfiled"),
    );
    expect(moveRoomToFolder).toHaveBeenLastCalledWith(
      { ...rooms[0], folderId: "school" },
      null,
    );
  });

  it("keeps the room in place when moving fails", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(moveRoomToFolder).mockResolvedValue(false);
    mountRooms();
    const move = await screen.findByRole("button", {
      name: "Move Algebra to folder",
    });
    await chooseFolder("Move Algebra to folder", "School");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't move the room",
    );
    expect(move).toHaveTextContent("Unfiled");
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
  });

  it("confirms folder deletion and preserves its rooms", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "school" },
    ]);
    vi.mocked(deleteRoomFolder).mockResolvedValue(true);
    mountRooms();
    await chooseTreeFolder("School (1)");
    fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    expect(
      screen.getByText(/All rooms inside will move to Unfiled/),
    ).toBeInTheDocument();
    expect(deleteRoomFolder).not.toHaveBeenCalled();
    fireEvent.click(
      within(
        screen.getByText(/All rooms inside will move to Unfiled/)
          .parentElement!,
      ).getByRole("button", { name: "Delete folder" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "All rooms" }),
      ).toHaveTextContent("Rooms"),
    );
    expect(deleteRoomFolder).toHaveBeenCalledWith("school");
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    expect(
      screen.queryByRole("treeitem", { name: "School" }),
    ).not.toBeInTheDocument();
  });

  it("shows failed folder saves without losing the input", async () => {
    vi.mocked(saveRoomFolder).mockResolvedValue(null);
    mountRooms();
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
      target: { value: "School" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Folder name" }), {
      key: "Enter",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't save the folder",
    );
    expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue(
      "School",
    );
  });

  it("retries failed folder loads without hiding rooms", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValueOnce(null);
    mountRooms();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load folders",
    );
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("tree", { name: "Folders" }),
    ).toBeInTheDocument();
  });

  it("keeps move menus in-app and closes them on Escape without closing rooms", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    const { onClose } = mountRooms();
    const trigger = await screen.findByRole("button", {
      name: "Move Algebra to folder",
    });
    expect(document.querySelector(".RoomsPage select")).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", {
      name: "Move Algebra to folder",
    });
    expect(
      screen.getByRole("menuitemradio", { name: "Unfiled" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("navigates the tree with arrows, Home, End, and Enter", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "math" },
      rooms[1],
    ]);
    mountRooms();
    const school = await screen.findByRole("treeitem", { name: "School" });
    act(() => school.focus());
    fireEvent.keyDown(school, { key: "ArrowRight" });
    expect(school).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(school, { key: "ArrowDown" });
    const math = screen.getByRole("treeitem", { name: "Math" });
    expect(math).toHaveFocus();
    fireEvent.keyDown(math, { key: "Enter" });
    expect(math).toHaveAttribute("aria-selected", "true");
    expect(math).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(math, { key: "ArrowRight" });
    const algebra = screen.getByRole("treeitem", { name: "Algebra" });
    expect(algebra).toHaveFocus();
    fireEvent.keyDown(algebra, { key: "ArrowLeft" });
    expect(math).toHaveFocus();
    fireEvent.keyDown(math, { key: "ArrowLeft" });
    expect(math).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(math, { key: "ArrowLeft" });
    expect(school).toHaveFocus();
    fireEvent.keyDown(school, { key: "End" });
    const physics = screen.getByRole("treeitem", { name: "Physics" });
    expect(physics).toHaveFocus();
    fireEvent.keyDown(physics, { key: "Home" });
    expect(school).toHaveFocus();
    expect(
      screen.getAllByRole("treeitem").filter((node) => node.tabIndex === 0),
    ).toHaveLength(1);
  });

  it("dismisses a move menu when clicking outside it", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    mountRooms();
    const trigger = await screen.findByRole("button", {
      name: "Move Algebra to folder",
    });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemradio", { name: "Unfiled" }),
      ).toHaveFocus(),
    );
    fireEvent.pointerDown(
      screen.getByRole("searchbox", { name: "Search rooms" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("complementary", { name: "My rooms" }),
    ).toBeInTheDocument();
  });

  it("focuses the sidebar without trapping Tab, closes on Escape, and restores focus", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { onClose, unmount } = mountRooms();
    const toggleButton = screen.getByRole("searchbox", {
      name: "Search rooms",
    });
    expect(toggleButton).toHaveFocus();
    expect(screen.getByRole("complementary")).not.toHaveAttribute("aria-modal");
    await screen.findByRole("button", { name: "Physics" });
    expect(
      fireEvent.keyDown(toggleButton, { key: "Tab", shiftKey: true }),
    ).toBe(true);
    expect(toggleButton).toHaveFocus();
    fireEvent.keyDown(toggleButton, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("expands and collapses the whole folder tree", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "math" },
    ]);
    mountRooms();
    await screen.findByRole("treeitem", { name: "School" });
    expect(
      screen.queryByRole("treeitem", { name: "Algebra" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(
      screen.getByRole("treeitem", { name: "Algebra" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.getByRole("treeitem", { name: "School" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      screen.queryByRole("treeitem", { name: "Math" }),
    ).not.toBeInTheDocument();
  });

  it("filters rooms by name and shows a no-results state", async () => {
    mountRooms();
    await screen.findByRole("button", { name: "Physics" });
    const search = screen.getByRole("searchbox", { name: "Search rooms" });
    fireEvent.change(search, { target: { value: "ALG" } });
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Physics" }),
    ).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("No rooms match");
  });

  it("retries failed room-list loads", async () => {
    vi.mocked(fetchRooms).mockResolvedValueOnce(null);
    mountRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Algebra" }),
    ).toBeInTheDocument();
  });

  it("ignores share-code responses for a previously selected room", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: "BBBB-2222" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    mountRooms();
    await screen.findByRole("button", { name: "Algebra" });
    const shareButtons = screen.getAllByRole("button", { name: "Share" });
    fireEvent.click(shareButtons[0]);
    fireEvent.click(shareButtons[1]);
    expect(await screen.findByDisplayValue("BBBB-2222")).toBeInTheDocument();
    await act(async () => {
      resolveFirst({
        ok: true,
        json: async () => ({ code: "AAAA-1111" }),
      } as Response);
    });
    expect(screen.getByDisplayValue("BBBB-2222")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("AAAA-1111")).not.toBeInTheDocument();
  });

  it("restores the previous drawing when empty-room creation fails", async () => {
    const elements = [{ id: "local-drawing" }];
    const updateScene = vi.fn();
    const startCollaboration = vi
      .fn()
      .mockRejectedValue(new Error("unreachable"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mountRooms({
      collabAPI: {
        startCollaboration,
        isCollaborating: () => false,
      } as unknown as CollabAPI,
      excalidrawAPI: {
        getSceneElements: () => elements,
        getSceneElementsIncludingDeleted: () => elements,
        getAppState: () => ({}),
        getFiles: () => ({}),
        addFiles: vi.fn(),
        updateScene,
      } as unknown as ExcalidrawImperativeAPI,
    });
    await screen.findByRole("button", { name: "Algebra" });
    fireEvent.click(screen.getByRole("button", { name: "New empty room" }));
    await waitFor(() =>
      expect(updateScene).toHaveBeenLastCalledWith({ elements, appState: {} }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't create the room",
    );
  });

  it.each(["Algebra", "New empty room"])(
    "keeps the explorer open after selecting %s",
    async (label) => {
      let collaborating = false;
      const startCollaboration = vi.fn().mockImplementation(async () => {
        collaborating = true;
        window.history.pushState({}, "", "/#room=room-a,key-a");
        return null;
      });
      const { onClose } = mountRooms({
        collabAPI: {
          startCollaboration,
          isCollaborating: () => collaborating,
        } as unknown as CollabAPI,
        excalidrawAPI: {
          getSceneElements: () => [],
          getSceneElementsIncludingDeleted: () => [],
          getAppState: () => ({}),
          getFiles: () => ({}),
          updateScene: vi.fn(),
        } as unknown as ExcalidrawImperativeAPI,
      });
      fireEvent.click(await screen.findByRole("button", { name: label }));
      await waitFor(() => expect(fetchRooms).toHaveBeenCalledTimes(2));
      expect(startCollaboration).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(
        screen.getByRole("complementary", { name: "My rooms" }),
      ).toBeInTheDocument();
      expect(
        await screen.findByRole("treeitem", { name: "Algebra" }),
      ).toBeInTheDocument();
    },
  );

  it("does not replace the drawing when empty-room creation is cancelled", async () => {
    const startCollaboration = vi.fn();
    const updateScene = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mountRooms({
      collabAPI: {
        startCollaboration,
        isCollaborating: () => false,
      } as unknown as CollabAPI,
      excalidrawAPI: {
        getSceneElements: () => [{ id: "local" }],
        updateScene,
      } as unknown as ExcalidrawImperativeAPI,
    });
    fireEvent.click(screen.getByRole("button", { name: "New empty room" }));
    await screen.findByRole("button", { name: "Algebra" });
    expect(startCollaboration).not.toHaveBeenCalled();
    expect(updateScene).not.toHaveBeenCalled();
  });
});

describe("join form", () => {
  it("labels its input and associates validation errors", () => {
    render(<JoinRoom onJoin={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Room link or code" });
    fireEvent.click(screen.getByRole("button", { name: "Join room" }));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("alert").id,
    );
  });

  it("blocks repeated requests while resolving a short code", async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<JoinRoom onJoin={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Room link or code" });
    fireEvent.change(input, { target: { value: "AAAA-1111" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Join room" })).toBeDisabled();
    await act(async () => {
      resolveRequest({ ok: false } as Response);
    });
    expect(
      screen.getByRole("button", { name: "Join room" }),
    ).not.toBeDisabled();
  });
});

describe("sharing the current drawing", () => {
  it("starts collaboration without clearing the existing canvas", async () => {
    const startCollaboration = vi.fn().mockResolvedValue(null);
    const updateScene = vi.fn();
    appJotaiStore.set(shareDialogStateAtom, { isOpen: true, type: "share" });
    render(
      <Provider store={appJotaiStore}>
        <ShareDialog
          collabAPI={
            {
              startCollaboration,
              isCollaborating: () => true,
            } as unknown as CollabAPI
          }
          excalidrawAPI={{ updateScene } as unknown as ExcalidrawImperativeAPI}
          onExportToBackend={vi.fn()}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Share this drawing" }));
    await waitFor(() => expect(startCollaboration).toHaveBeenCalledWith(null));
    expect(updateScene).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Share this drawing" }),
      ).not.toBeDisabled(),
    );
  });

  it("shows an error without clearing the canvas when starting fails", async () => {
    const startCollaboration = vi
      .fn()
      .mockRejectedValue(new Error("unreachable"));
    const updateScene = vi.fn();
    appJotaiStore.set(shareDialogStateAtom, { isOpen: true, type: "share" });
    render(
      <Provider store={appJotaiStore}>
        <ShareDialog
          collabAPI={
            {
              startCollaboration,
              isCollaborating: () => false,
            } as unknown as CollabAPI
          }
          excalidrawAPI={{ updateScene } as unknown as ExcalidrawImperativeAPI}
          onExportToBackend={vi.fn()}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Share this drawing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't create the room",
    );
    expect(updateScene).not.toHaveBeenCalled();
  });
});
