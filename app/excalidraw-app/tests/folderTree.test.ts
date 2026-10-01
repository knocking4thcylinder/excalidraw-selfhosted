import { getFolderDescendantIds, getFolderTree } from "../rooms/folderTree";

describe("room folder hierarchy", () => {
  const folders = [
    { id: "physics", name: "Physics", parentId: "school" },
    { id: "algebra", name: "Algebra", parentId: "math" },
    { id: "work", name: "Work" },
    { id: "school", name: "School" },
    { id: "math", name: "Math", parentId: "school" },
  ];

  it("sorts siblings and includes full paths and nesting depths", () => {
    expect(
      getFolderTree(folders).map(({ folder, depth, path }) => [
        folder.id,
        depth,
        path,
      ]),
    ).toEqual([
      ["school", 0, "School"],
      ["math", 1, "School / Math"],
      ["algebra", 2, "School / Math / Algebra"],
      ["physics", 1, "School / Physics"],
      ["work", 0, "Work"],
    ]);
  });

  it("includes all descendants but not unrelated branches", () => {
    expect(getFolderDescendantIds(folders, "school")).toEqual(
      new Set(["school", "math", "physics", "algebra"]),
    );
    expect(getFolderDescendantIds(folders, "math")).toEqual(
      new Set(["math", "algebra"]),
    );
  });

  it("keeps legacy and orphan folders visible at the top level", () => {
    expect(
      getFolderTree([
        { id: "orphan", name: "Orphan", parentId: "missing" },
        { id: "legacy", name: "Legacy" },
      ]).map(({ path, depth }) => [path, depth]),
    ).toEqual([
      ["Legacy", 0],
      ["Orphan", 0],
    ]);
  });

  it("does not loop forever when persisted data contains a cycle", () => {
    const cyclic = [
      { id: "first", name: "First", parentId: "second" },
      { id: "second", name: "Second", parentId: "first" },
    ];
    expect(getFolderTree(cyclic)).toHaveLength(2);
    expect(getFolderDescendantIds(cyclic, "first")).toEqual(
      new Set(["first", "second"]),
    );
  });
});
