import { buildExplorerEntries } from "../rooms/explorerEntries";

import type { RoomFolder, ServerRoomEntry } from "../data/rooms";

const room = (
  roomId: string,
  name?: string,
  folderId?: string,
): ServerRoomEntry => ({
  roomId,
  key: `key-${roomId}`,
  createdAt: 0,
  lastActiveAt: 0,
  hasScene: false,
  name,
  folderId,
});

const build = (
  args: Partial<Parameters<typeof buildExplorerEntries>[0]> = {},
) =>
  buildExplorerEntries({
    folders: [],
    rooms: [],
    search: "",
    expanded: new Set<string>(),
    ...args,
  });

const ids = (entries: ReturnType<typeof buildExplorerEntries>) =>
  entries.map((entry) => entry.id);

describe("room explorer entries", () => {
  const folders: RoomFolder[] = [
    { id: "school", name: "School" },
    { id: "math", name: "Math", parentId: "school" },
  ];
  const rooms = [room("a", "Algebra", "math"), room("p", "Physics")];

  it("sorts folders before the rooms of the same parent", () => {
    const alpha = room("a", "Alpha", "school");
    const entries = build({
      folders: [
        { id: "work", name: "Work" },
        { id: "school", name: "School" },
      ],
      rooms: [room("z", "Zeta"), alpha],
      expanded: new Set(["school"]),
    });
    expect(ids(entries)).toEqual(["school", "room:a", "work", "room:z"]);
    expect(entries[0]).toMatchObject({
      depth: 0,
      path: "School",
      count: 1,
    });
    expect(entries[1]).toMatchObject({
      depth: 1,
      parentId: "school",
      room: alpha,
    });
    expect(entries[3].parentId).toBeUndefined();
  });

  it("hides children of collapsed folders and nests them once expanded", () => {
    expect(ids(build({ folders, rooms }))).toEqual(["school", "room:p"]);
    expect(
      ids(build({ folders, rooms, expanded: new Set(["school"]) })),
    ).toEqual(["school", "math", "room:p"]);
    expect(
      ids(
        build({
          folders,
          rooms,
          expanded: new Set(["school", "math"]),
        }),
      ),
    ).toEqual(["school", "math", "room:a", "room:p"]);
  });

  it("keeps matching folders, their ancestors, and rooms below matching branches", () => {
    const entries = build({ folders, rooms, search: "  School " });
    expect(ids(entries)).toEqual(["school", "math", "room:a"]);
    expect(entries.map((entry) => entry.depth)).toEqual([0, 1, 2]);
    expect(entries[1].path).toBe("School / Math");
    expect(ids(build({ folders, rooms, search: "math" }))).toEqual([
      "school",
      "math",
      "room:a",
    ]);
  });

  it("shows only matching rooms when no ancestor path matches", () => {
    const folders: RoomFolder[] = [
      { id: "classes", name: "Classes" },
      { id: "home", name: "Home" },
    ];
    const rooms = [
      room("a", "Algebra", "classes"),
      room("p", "Physics", "classes"),
      room("h", "Homework", "home"),
    ];
    expect(ids(build({ folders, rooms, search: "algebra" }))).toEqual([
      "classes",
      "room:a",
    ]);
    expect(ids(build({ folders, rooms, search: "HOME" }))).toEqual([
      "home",
      "room:h",
    ]);
    expect(ids(build({ folders, rooms, search: "classes" }))).toEqual([
      "classes",
      "room:a",
      "room:p",
    ]);
  });

  it("ignores the expansion state while filtering and clears back to it", () => {
    expect(ids(build({ folders, rooms, search: "Algebra" }))).toEqual([
      "school",
      "math",
      "room:a",
    ]);
    expect(build({ folders, rooms, search: "missing" })).toEqual([]);
    expect(ids(build({ folders, rooms, search: "" }))).toEqual([
      "school",
      "room:p",
    ]);
  });

  it("matches room names and ids case-insensitively", () => {
    expect(
      ids(
        build({
          rooms: [room("r1", "Algebra"), room("r2", "Physics")],
          search: "ALG",
        }),
      ),
    ).toEqual(["room:r1"]);
    expect(
      ids(build({ rooms: [room("room-a"), room("room-b")], search: "ROOM-B" })),
    ).toEqual(["room:room-b"]);
  });

  it("filters each room independently even if ids are duplicated", () => {
    const matching = room("shared", "Algebra");
    const unrelated = room("shared", "Physics");
    expect(
      build({ rooms: [matching, unrelated], search: "Algebra" }).map(
        (entry) => entry.room,
      ),
    ).toEqual([matching]);
  });

  it("adds a draft row under its parent and opens that parent", () => {
    const entries = build({
      folders: [{ id: "school", name: "School" }],
      rooms: [room("a", "Algebra", "school"), room("p", "Physics")],
      folderDraft: { parentId: "school" },
    });
    expect(ids(entries)).toEqual([
      "school",
      "draft-folder",
      "room:a",
      "room:p",
    ]);
    expect(entries[1]).toMatchObject({
      depth: 1,
      parentId: "school",
      draft: true,
    });
  });

  it("adds a root draft row and none without a draft", () => {
    expect(
      ids(build({ rooms: [room("p", "Physics")], folderDraft: {} })),
    ).toEqual(["draft-folder", "room:p"]);
    expect(ids(build({ rooms: [room("p", "Physics")] }))).toEqual(["room:p"]);
  });

  it("keeps orphan folders at the root and breaks parent cycles", () => {
    const folders: RoomFolder[] = [
      { id: "orphan", name: "Orphan", parentId: "missing" },
      { id: "legacy", name: "Legacy" },
      { id: "first", name: "First", parentId: "second" },
      { id: "second", name: "Second", parentId: "first" },
    ];
    const rooms = [room("n", "Notes", "second")];
    const collapsed = build({ folders, rooms });
    expect(ids(collapsed)).toEqual(["legacy", "orphan", "first"]);
    expect(collapsed.map((entry) => entry.depth)).toEqual([0, 0, 0]);
    expect(new Set(ids(collapsed)).size).toBe(collapsed.length);
    const opened = build({ folders, rooms, expanded: new Set(["first"]) });
    expect(ids(opened)).toEqual(["legacy", "orphan", "first", "second"]);
    expect(opened.map((entry) => entry.depth)).toEqual([0, 0, 0, 1]);
    expect(opened[3].parentId).toBe("first");
    expect(
      ids(build({ folders, rooms, expanded: new Set(["first", "second"]) })),
    ).toEqual(["legacy", "orphan", "first", "second", "room:n"]);
    expect(ids(build({ folders, rooms, search: "second" }))).toEqual([
      "first",
      "second",
      "room:n",
    ]);
  });

  it("treats rooms of a missing folder as root rooms", () => {
    const entries = build({
      folders: [{ id: "school", name: "School" }],
      rooms: [room("g", "Ghost", "deleted")],
    });
    expect(ids(entries)).toEqual(["school", "room:g"]);
    expect(entries[1].parentId).toBeUndefined();
    expect(entries[0].count).toBe(0);
  });

  it("counts every room of a folder even while filtering", () => {
    const entries = build({
      folders: [{ id: "classes", name: "Classes" }],
      rooms: [room("a", "Algebra", "classes"), room("p", "Physics", "classes")],
      search: "algebra",
    });
    expect(ids(entries)).toEqual(["classes", "room:a"]);
    expect(entries[0].count).toBe(2);
  });
});
