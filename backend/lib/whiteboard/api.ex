defmodule Whiteboard.API do
  alias Whiteboard.{Files, Scenes, Store}
  @id ~r/^[A-Za-z0-9_-]{1,64}$/
  @alphabet "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

  def dispatch("POST", ["api", "code"], payload, _query, _headers) do
    with url when is_binary(url) <- payload["url"],
         [_, room, key] <- Regex.run(~r/#room=([A-Za-z0-9_-]+),([A-Za-z0-9_-]+)/, url),
         %URI{scheme: scheme, host: host} = uri <- URI.parse(url),
         true <- scheme in ["http", "https"] and is_binary(host) do
      target = URI.to_string(%{uri | query: nil, fragment: "room=#{room},#{key}"})
      codes = Store.all("codes")
      existing = Enum.find(codes, fn {_id, value} -> value["url"] == target end)
      code = if existing, do: elem(existing, 0), else: new_code(codes)
      Store.put("codes", code, %{"url" => target})
      ok(%{code: code})
    else
      _ -> error(400, "bad url")
    end
  end

  def dispatch("GET", ["s", code], _payload, _query, _headers) do
    with %{"url" => url} <- Store.get("codes", String.upcase(code)),
         [fragment] <- Regex.run(~r/room=[A-Za-z0-9_-]+,[A-Za-z0-9_-]+/, url) do
      # Redirect within this site only: the stored URL's host is client-supplied.
      {302, nil, [{"location", "/#" <> fragment}]}
    else
      _ -> error(404, "unknown code")
    end
  end

  def dispatch("GET", ["api", "resolve", code], _payload, _query, _headers) do
    case Store.get("codes", String.upcase(code)) do
      nil -> error(404, "unknown code")
      value -> ok(value)
    end
  end

  def dispatch("POST", ["api", "rooms"], payload, _query, _headers) do
    with id when is_binary(id) <- payload["roomId"],
         key when is_binary(key) and key != "" <- payload["roomKey"],
         true <- Regex.match?(@id, id) do
      id = normalize_id(id)
      room = Store.get("rooms", id)

      cond do
        room && room["key"] != key ->
          error(409, "roomId already registered with a different key")

        room ->
          Store.put("rooms", id, Map.put(room, "lastActiveAt", now()))
          ok(%{ok: true, created: false})

        true ->
          Store.put("rooms", id, %{
            "key" => key,
            "createdAt" => now(),
            "lastActiveAt" => now(),
            "hasScene" => false
          })

          ok(%{ok: true, created: true})
      end
    else
      _ -> error(400, "invalid roomId or roomKey")
    end
  end

  # Cheap reachability probe for offline clients; never returns room data.
  def dispatch("HEAD", ["api", "rooms"], _payload, _query, _headers), do: {200, nil, []}

  def dispatch("GET", ["api", "rooms"], _payload, _query, _headers) do
    folders = Store.all("folders")

    rooms =
      Store.all("rooms")
      |> Enum.map(fn {id, room} ->
        room =
          if Map.has_key?(folders, room["folderId"]), do: room, else: Map.delete(room, "folderId")

        Map.put(room, "roomId", id)
      end)
      |> Enum.sort_by(& &1["lastActiveAt"], :desc)

    ok(%{rooms: rooms})
  end

  def dispatch("GET", ["api", "rooms", "folders"], _payload, _query, _headers) do
    ok(%{
      folders: Enum.map(Store.all("folders"), fn {id, folder} -> Map.put(folder, "id", id) end)
    })
  end

  def dispatch("POST", ["api", "rooms", "folders"], payload, _query, _headers),
    do: save_folder(nil, payload)

  def dispatch(method, ["api", "rooms", "folders", id], payload, _query, _headers)
      when method in ["POST", "DELETE"] do
    cond do
      !Regex.match?(@id, id) -> error(404, "unknown folder")
      !Store.get("folders", id) -> error(404, "unknown folder")
      method == "POST" -> save_folder(id, payload)
      true -> delete_folder(id)
    end
  end

  def dispatch(method, ["api", "rooms", id | rest], payload, query, headers) do
    if Regex.match?(@id, id) do
      id = normalize_id(id)

      key =
        if method in ["POST", "PATCH", "DELETE"],
          do: Map.get(payload, "key", query["key"]),
          else: query["key"]

      case Store.get("rooms", id) do
        nil -> error(404, "unknown room")
        %{"key" => ^key} = room -> room_action(method, rest, id, room, payload, query, headers)
        _ -> error(403, "wrong key")
      end
    else
      error(404, "unknown room")
    end
  end

  def dispatch("GET", [], _payload, _query, _headers), do: ok(%{status: "ok"})
  def dispatch(_method, _path, _payload, _query, _headers), do: error(404, "not found")

  defp room_action("POST", ["rename"], id, room, payload, _query, _headers) do
    with name when is_binary(name) <- payload["name"],
         name = String.trim(name),
         true <- String.length(name) <= 64 do
      room = if name == "", do: Map.delete(room, "name"), else: Map.put(room, "name", name)
      Store.put("rooms", id, room)
      ok(%{ok: true})
    else
      _ -> error(400, "invalid name")
    end
  end

  defp room_action("POST", ["folder"], id, room, payload, _query, _headers) do
    folder = payload["folderId"]

    if Map.has_key?(payload, "folderId") &&
         (is_nil(folder) || (is_binary(folder) && Store.get("folders", folder))) do
      room =
        if is_nil(folder),
          do: Map.delete(room, "folderId"),
          else: Map.put(room, "folderId", folder)

      Store.put("rooms", id, room)
      ok(%{ok: true})
    else
      error(400, "unknown folder")
    end
  end

  defp room_action("DELETE", [], id, _room, _payload, _query, _headers) do
    Store.delete("rooms", id)
    Scenes.delete(id)
    Files.delete_room(id)
    delete_codes(id)
    ok(%{ok: true})
  end

  defp room_action("PUT", ["files", file_id], id, _room, {:binary, data}, _query, _headers)
       when byte_size(data) > 0 do
    if Regex.match?(@id, file_id) do
      Files.put(id, file_id, data)
      ok(%{ok: true})
    else
      error(400, "invalid file id")
    end
  end

  defp room_action("GET", ["files", file_id], id, _room, _payload, _query, _headers) do
    case Files.get(id, file_id) do
      nil -> error(404, "unknown file")
      data -> {200, {:binary, data}, []}
    end
  end

  defp room_action("GET", ["scene-history"], id, _room, _payload, _query, _headers) do
    case Scenes.get(id) do
      nil ->
        error(404, "no scene")

      scene ->
        versions =
          [scene | Scenes.history(scene)]
          |> Enum.with_index()
          |> Enum.map(fn {snapshot, slot} -> Map.put(snapshot(snapshot), "slot", slot) end)

        ok(%{versions: versions})
    end
  end

  defp room_action(method, ["scene"], id, _room, _payload, query, headers)
       when method in ["GET", "HEAD"] do
    scene = Scenes.get(id)
    slot = Integer.parse(query["slot"] || "0")

    picked =
      case {scene, slot} do
        {nil, _} ->
          nil

        {scene, {0, ""}} ->
          scene

        {scene, {index, ""}} when index > 0 ->
          case Enum.at(Map.get(scene, "historyIds", []), index - 1) do
            nil -> nil
            snapshot_id -> Store.get("snapshots", snapshot_id)
          end

        _ ->
          nil
      end

    if picked do
      etag = Scenes.etag(picked)

      response_headers =
        Scenes.sync_headers(picked) ++
          [
            {"x-scene-revision", to_string(Map.get(scene, "revision", 0))}
          ]

      cond do
        method == "HEAD" ->
          {200, nil, response_headers}

        query["sync"] != "1" && Map.get(picked, "patches", []) != [] ->
          error(409, "scene sync client required")

        headers["if-none-match"] == etag ->
          {304, nil, response_headers}

        query["sync"] == "1" ->
          {200, Scenes.sync_snapshot(picked, query["since"]), response_headers}

        true ->
          {200, Map.take(snapshot(picked), ["iv", "ciphertext", "version", "updatedAt"]),
           response_headers}
      end
    else
      capability =
        if Application.get_env(:whiteboard, :scene_sync_enabled),
          do: [{"x-scene-sync", "1"}],
          else: []

      {404, %{error: "no such scene or slot"}, capability}
    end
  end

  defp room_action("POST", ["scene"], id, room, payload, _query, _headers) do
    previous = Scenes.get(id)
    version = if is_number(payload["sceneVersion"]), do: payload["sceneVersion"], else: nil

    incoming_empty =
      payload["isEmpty"] == true ||
        (payload["isEmpty"] != false && is_number(version) && version <= 0)

    previous_nonempty =
      previous && previous["isEmpty"] != true &&
        !(is_number(previous["version"]) && previous["version"] <= 0)

    cond do
      !is_binary(payload["iv"]) || payload["iv"] == "" || !is_binary(payload["ciphertext"]) ||
          payload["ciphertext"] == "" ->
        error(400, "iv and ciphertext required")

      payload["syncVersion"] == 1 &&
          payload["baseEtag"] != if(previous, do: Scenes.etag(previous), else: nil) ->
        error(412, "scene changed")

      previous && Map.get(previous, "patches", []) != [] && payload["syncVersion"] != 1 ->
        error(409, "scene sync client required")

      incoming_empty && previous_nonempty ->
        error(409, "refusing empty overwrite")

      true ->
        revision = if previous, do: Map.get(previous, "revision", 0) + 1, else: 1

        Scenes.put(
          id,
          %{
            "iv" => payload["iv"],
            "ciphertext" => payload["ciphertext"],
            "version" => version,
            "updatedAt" => now(),
            "isEmpty" => payload["isEmpty"] == true,
            "revision" => revision
          },
          previous
        )

        Store.put(
          "rooms",
          id,
          room |> Map.put("hasScene", true) |> Map.put("lastActiveAt", now())
        )

        {200, %{ok: true}, Scenes.sync_headers(Scenes.get(id))}
    end
  end

  defp room_action("PATCH", ["scene"], id, room, payload, _query, _headers) do
    previous = Scenes.get(id)
    patches = if previous, do: Map.get(previous, "patches", []), else: []

    cond do
      !Application.get_env(:whiteboard, :scene_sync_enabled) ->
        error(413, "scene checkpoint required")

      payload["syncVersion"] != 1 || !is_binary(payload["iv"]) || payload["iv"] == "" ||
        !is_binary(payload["ciphertext"]) || payload["ciphertext"] == "" ||
        !is_number(payload["sceneVersion"]) || payload["sceneVersion"] < 0 ||
          payload["isEmpty"] != false ->
        error(400, "invalid scene patch")

      !previous || payload["baseEtag"] != Scenes.etag(previous) ->
        error(412, "scene changed")

      length(patches) >= 32 ||
          Enum.reduce(patches, byte_size(payload["ciphertext"]), fn patch, size ->
            size + byte_size(patch["ciphertext"])
          end) > 5 * 1024 * 1024 ->
        error(413, "scene checkpoint required")

      true ->
        patch = Map.take(payload, ["iv", "ciphertext", "baseEtag"])

        patch =
          Map.put(
            patch,
            "etag",
            Scenes.fingerprint(payload["baseEtag"] <> payload["iv"] <> payload["ciphertext"])
          )

        scene =
          previous
          |> Map.put("patches", patches ++ [patch])
          |> Map.put("version", payload["sceneVersion"])
          |> Map.put("updatedAt", now())
          |> Map.put("revision", Map.get(previous, "revision", 0) + 1)
          |> Map.put("isEmpty", false)

        Scenes.append(id, scene)
        Store.put("rooms", id, Map.put(room, "lastActiveAt", now()))
        {200, %{ok: true}, Scenes.sync_headers(scene)}
    end
  end

  defp room_action(_method, _rest, _id, _room, _payload, _query, _headers),
    do: error(404, "not found")

  defp save_folder(id, payload) do
    folders = Store.all("folders")
    name = if is_binary(payload["name"]), do: String.trim(payload["name"]), else: ""
    parent = Map.get(payload, "parentId", get_in(folders, [id, "parentId"]))

    cond do
      name == "" || String.length(name) > 64 ->
        error(400, "folder name must be 1–64 characters")

      parent != nil && (!is_binary(parent) || !Map.has_key?(folders, parent)) ->
        error(400, "unknown parent folder")

      cycle?(id, parent, folders, MapSet.new()) ->
        error(400, "folder cannot contain itself")

      Enum.any?(folders, fn {other_id, folder} ->
        other_id != id && folder["parentId"] == parent &&
            String.downcase(folder["name"]) == String.downcase(name)
      end) ->
        error(409, "folder name already exists")

      true ->
        id = id || Ecto.UUID.generate()
        folder = if parent, do: %{"name" => name, "parentId" => parent}, else: %{"name" => name}
        Store.put("folders", id, folder)
        ok(%{folder: Map.put(folder, "id", id)})
    end
  end

  defp cycle?(_id, nil, _folders, _seen), do: false

  defp cycle?(id, parent, folders, seen) do
    parent == id || MapSet.member?(seen, parent) ||
      cycle?(id, get_in(folders, [parent, "parentId"]), folders, MapSet.put(seen, parent))
  end

  defp delete_folder(id) do
    folders = Store.all("folders")
    deleted = descendants(MapSet.new([id]), folders)
    Enum.each(deleted, &Store.delete("folders", &1))

    for {room_id, room} <- Store.all("rooms"), MapSet.member?(deleted, room["folderId"]) do
      Store.put("rooms", room_id, Map.delete(room, "folderId"))
    end

    ok(%{ok: true})
  end

  defp descendants(deleted, folders) do
    expanded =
      Enum.reduce(folders, deleted, fn {id, folder}, result ->
        if MapSet.member?(result, folder["parentId"]), do: MapSet.put(result, id), else: result
      end)

    if expanded == deleted, do: deleted, else: descendants(expanded, folders)
  end

  # Short codes embed the room key, so they must not outlive the room.
  defp delete_codes(room_id) do
    for {code, %{"url" => url}} <- Store.all("codes"),
        [_, room] <- [Regex.run(~r/#room=([A-Za-z0-9_-]+),/, url)],
        normalize_id(room) == room_id do
      Store.delete("codes", code)
    end
  end

  defp new_code(codes) do
    raw =
      for <<byte <- :crypto.strong_rand_bytes(8)>>,
        into: "",
        do: binary_part(@alphabet, rem(byte, byte_size(@alphabet)), 1)

    code = binary_part(raw, 0, 4) <> "-" <> binary_part(raw, 4, 4)
    if Map.has_key?(codes, code), do: new_code(codes), else: code
  end

  defp snapshot(scene),
    do:
      scene
      |> Map.take(["iv", "ciphertext", "updatedAt", "patches"])
      |> Map.put("version", scene["version"])
      |> Map.put("isEmpty", scene["isEmpty"] == true)

  defp normalize_id(id),
    do: if(Regex.match?(~r/^[A-Za-z0-9]+$/, id), do: String.downcase(id), else: id)

  defp now, do: System.system_time(:millisecond)
  defp ok(body), do: {200, body, []}
  defp error(status, message), do: {status, %{error: message}, []}
end
