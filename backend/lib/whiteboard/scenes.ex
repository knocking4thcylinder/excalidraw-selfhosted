defmodule Whiteboard.Scenes do
  alias Whiteboard.Store

  def get(id) do
    case Store.get("scenes", id) do
      nil -> nil
      scene -> Map.merge(scene, Store.get("scene-patches", id) || %{})
    end
  end

  def append(id, scene) do
    Store.put(
      "scene-patches",
      id,
      Map.take(scene, ["patches", "version", "updatedAt", "revision", "isEmpty"])
    )
  end

  def etag(scene) do
    case List.last(Map.get(scene, "patches", [])) do
      nil -> fingerprint(scene["iv"] <> scene["ciphertext"])
      patch -> patch["etag"]
    end
  end

  def fingerprint(value) do
    "\"" <> Base.encode16(:crypto.hash(:sha256, value), case: :lower) <> "\""
  end

  def sync_headers(scene) do
    capability =
      if Application.get_env(:whiteboard, :scene_sync_enabled) ||
           Map.get(scene, "patches", []) != [],
         do: [{"x-scene-sync", "1"}],
         else: []

    [
      {"etag", etag(scene)},
      {"x-scene-patches", to_string(length(Map.get(scene, "patches", [])))}
    ] ++ capability
  end

  def sync_snapshot(scene, since) do
    patches = Map.get(scene, "patches", [])

    index =
      if is_binary(since), do: Enum.find_index(patches, &(&1["baseEtag"] == since)), else: nil

    if is_integer(index) do
      %{"syncVersion" => 1, "baseEtag" => since, "patches" => Enum.drop(patches, index)}
    else
      scene
      |> Map.take(["iv", "ciphertext", "version", "updatedAt"])
      |> Map.put("syncVersion", 1)
      |> Map.put("checkpointEtag", fingerprint(scene["iv"] <> scene["ciphertext"]))
      |> Map.put("patches", patches)
    end
  end

  def history(scene) do
    Enum.map(Map.get(scene, "historyIds", []), &Store.get("snapshots", &1))
  end

  def import(id, scene) do
    history_ids =
      Map.get(scene, "history", [])
      |> Enum.with_index()
      |> Enum.map(fn {snapshot, index} ->
        snapshot_id = "#{id}:import:#{index}"
        Store.put("snapshots", snapshot_id, snapshot)
        snapshot_id
      end)

    Store.put(
      "scenes",
      id,
      scene |> Map.drop(["history", "patches"]) |> Map.put("historyIds", history_ids)
    )

    if Map.get(scene, "patches", []) != [], do: append(id, scene)
  end

  def put(id, scene, previous) do
    history_ids =
      if previous do
        snapshot_id = "#{id}:#{Map.get(previous, "revision", 0)}"
        snapshot = previous |> Map.drop(["historyIds", "revision"])
        Store.put("snapshots", snapshot_id, snapshot)
        [snapshot_id | Map.get(previous, "historyIds", [])]
      else
        []
      end

    Enum.each(Enum.drop(history_ids, 10), &Store.delete("snapshots", &1))
    Store.put("scenes", id, Map.put(scene, "historyIds", Enum.take(history_ids, 10)))
    Store.delete("scene-patches", id)
  end

  def delete(id) do
    if scene = get(id) do
      Enum.each(Map.get(scene, "historyIds", []), &Store.delete("snapshots", &1))
    end

    Store.delete("scenes", id)
    Store.delete("scene-patches", id)
  end

  def export(scene), do: scene |> Map.delete("historyIds") |> Map.put("history", history(scene))
end
