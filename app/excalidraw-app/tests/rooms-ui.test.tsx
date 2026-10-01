import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore, Provider } from "../app-jotai";
import { activeRoomLinkAtom } from "../collab/Collab";
import {
  deleteRoomFolder,
  fetchRoomFolders,
  fetchRooms,
  moveRoomToFolder,
  saveRoomFolder,
} from "../data/rooms";
import { RoomsPage } from "../rooms/RoomsPage";
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

beforeEach(() => {
  vi.mocked(fetchRooms).mockResolvedValue(rooms);
  vi.mocked(fetchRoomFolders).mockResolvedValue([]);
  appJotaiStore.set(activeRoomLinkAtom, null);
  appJotaiStore.set(shareDialogStateAtom, { isOpen: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("rooms UI", () => {
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
      screen.getByRole("button", { name: "Parent folder" }),
    ).toHaveTextContent("School");
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
      target: { value: "Math" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
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

  it("moves a folder with its descendants while blocking descendant parents", async () => {
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
      name: "School",
      parentId: "work",
    });
    mountRooms();
    await chooseTreeFolder("School (1)");
    fireEvent.click(screen.getByRole("button", { name: "Rename folder" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Parent folder" }), {
      key: "ArrowDown",
    });
    expect(
      screen.queryByRole("menuitemradio", { name: "School" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitemradio", { name: "School / Math" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "All rooms" }),
      ).toHaveTextContent("Work / School"),
    );
    expect(saveRoomFolder).toHaveBeenCalledWith("School", "school", "work");
    expect(
      screen.getByRole("button", { name: "Open folder Work / School / Math" }),
    ).toBeInTheDocument();
  });

  it("can move a nested folder back to the top level", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
      { id: "math", name: "Math", parentId: "school" },
    ]);
    vi.mocked(saveRoomFolder).mockResolvedValue({ id: "math", name: "Math" });
    mountRooms();
    await chooseTreeFolder("School / Math (0)");
    fireEvent.click(screen.getByRole("button", { name: "Rename folder" }));
    await chooseFolder("Parent folder", "Top level");
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
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
      screen.getAllByRole("button", { name: "Delete folder" })[1],
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
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
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
      screen.getAllByRole("button", { name: "Delete folder" })[1],
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
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
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
    const toggleButton = screen.getByRole("button", {
      name: "Collapse rooms sidebar",
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

  it("collapses to a rail and preserves search and expanded folders", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "school" },
    ]);
    const { onClose } = mountRooms();
    await chooseTreeFolder("School");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "Algebra" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse rooms sidebar" }),
    );
    const expandButton = screen.getByRole("button", {
      name: "Expand rooms sidebar",
    });
    expect(expandButton).toHaveAttribute("aria-expanded", "false");
    expect(expandButton).toHaveFocus();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(expandButton);
    expect(screen.getByRole("searchbox", { name: "Search rooms" })).toHaveValue(
      "Algebra",
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "" },
    });
    expect(screen.getByRole("treeitem", { name: "School" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      screen.getByRole("treeitem", { name: "Algebra" }),
    ).toBeInTheDocument();
    expect(fetchRooms).toHaveBeenCalledTimes(1);
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
