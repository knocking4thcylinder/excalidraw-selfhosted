import type { SyncableExcalidrawElement } from ".";

export type ScenePatch = {
  format: 1;
  upserts: readonly SyncableExcalidrawElement[];
  removedIds: string[];
  order?: string[];
};

export const createScenePatch = (
  baseline: readonly SyncableExcalidrawElement[],
  current: readonly SyncableExcalidrawElement[],
): ScenePatch => {
  const previous = new Map(baseline.map((element) => [element.id, element]));
  const order = current.map((element) => element.id);
  const currentIds = new Set(order);
  const orderChanged =
    baseline.length !== order.length ||
    baseline.some((element, index) => element.id !== order[index]);
  return {
    format: 1,
    upserts: current.filter(
      (element) =>
        JSON.stringify(previous.get(element.id)) !== JSON.stringify(element),
    ),
    removedIds: baseline
      .filter((element) => !currentIds.has(element.id))
      .map((element) => element.id),
    ...(orderChanged ? { order } : {}),
  };
};

export const applyScenePatch = (
  baseline: readonly SyncableExcalidrawElement[],
  value: unknown,
): readonly SyncableExcalidrawElement[] => {
  const patch = value as ScenePatch | null;
  if (
    !patch ||
    patch.format !== 1 ||
    !Array.isArray(patch.upserts) ||
    !Array.isArray(patch.removedIds) ||
    patch.removedIds.some((id) => typeof id !== "string") ||
    patch.upserts.some((element) => !element || typeof element.id !== "string")
  ) {
    throw new Error("Invalid encrypted scene patch");
  }
  const upsertIds = new Set(patch.upserts.map((element) => element.id));
  if (
    upsertIds.size !== patch.upserts.length ||
    patch.removedIds.some((id) => upsertIds.has(id))
  ) {
    throw new Error("Invalid encrypted scene patch");
  }
  const elements = new Map(baseline.map((element) => [element.id, element]));
  for (const id of patch.removedIds) {
    elements.delete(id);
  }
  for (const element of patch.upserts) {
    elements.set(element.id, element);
  }
  if (patch.order !== undefined) {
    if (
      !Array.isArray(patch.order) ||
      patch.order.length !== elements.size ||
      new Set(patch.order).size !== elements.size ||
      patch.order.some((id) => typeof id !== "string" || !elements.has(id))
    ) {
      throw new Error("Invalid encrypted scene order");
    }
    return patch.order.map((id) => elements.get(id)!);
  }
  return [...elements.values()];
};
