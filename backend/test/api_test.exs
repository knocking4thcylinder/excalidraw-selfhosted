defmodule Whiteboard.APITest do
  use ExUnit.Case, async: false
  import Plug.Test
  import Plug.Conn
  alias Whiteboard.{Record, Repo, Router, Store}

  setup do
    Repo.delete_all(Record)
    Repo.delete_all(Whiteboard.RoomFile)
    :ok
  end

  defp request(method, path, payload \\ nil, headers \\ []) do
    body = if is_nil(payload), do: "", else: Jason.encode!(payload)
    conn = conn(method, path, body) |> put_req_header("content-type", "application/json")

    conn =
      Enum.reduce(headers, conn, fn {name, value}, conn -> put_req_header(conn, name, value) end)

    Router.call(conn, Router.init([]))
  end

  defp json(conn), do: Jason.decode!(conn.resp_body)

  defp register(id \\ "room", key \\ "secret") do
    request(:post, "/api/rooms", %{roomId: id, roomKey: key})
  end

  defp save(version, options \\ %{}) do
    payload =
      Map.merge(
        %{
          key: "secret",
          iv: "iv-#{version}",
          ciphertext: "cipher-#{version}",
          sceneVersion: version,
          isEmpty: false
        },
        options
      )

    request(:post, "/api/rooms/room/scene", payload)
  end

  test "room registration, normalization, rename, authorization and deletion" do
    assert json(register("ROOM"))["created"]
    refute json(register("room"))["created"]
    assert register("room", "wrong").status == 409
    assert register("bad/id").status == 400
    assert register("valid", "").status == 400
    assert request(:post, "/api/rooms/room/rename", %{key: "wrong", name: "Name"}).status == 403

    assert request(:post, "/api/rooms/room/rename", %{key: "secret", name: " Drawing "}).status ==
             200

    [room] = json(request(:get, "/api/rooms"))["rooms"]
    assert room["name"] == "Drawing"
    assert room["roomId"] == "room"

    assert request(:post, "/api/rooms/room/rename", %{
             key: "secret",
             name: String.duplicate("a", 65)
           }).status == 400

    assert request(:delete, "/api/rooms/room", %{key: "wrong"}).status == 403
    assert request(:delete, "/api/rooms/room?key=secret").status == 200
    assert json(request(:get, "/api/rooms"))["rooms"] == []
    assert request(:get, "/api/rooms/missing/scene?key=secret").status == 404
    assert json(register("Case-Sensitive"))["created"]
    assert json(register("case-sensitive"))["created"]
  end

  test "short codes are stable, case insensitive and retain room keys" do
    payload = %{url: "https://deck.example:8443/draw?ignored=1#room=Room-ID,Secret_KEY"}
    first = request(:post, "/api/code", payload)
    code = json(first)["code"]
    assert Regex.match?(~r/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, code)
    assert json(request(:post, "/api/code", payload))["code"] == code
    expected = "https://deck.example:8443/draw#room=Room-ID,Secret_KEY"
    assert json(request(:get, "/api/resolve/#{String.downcase(code)}"))["url"] == expected
    redirect = request(:get, "/s/#{code}")
    assert redirect.status == 302
    assert get_resp_header(redirect, "location") == ["/#room=Room-ID,Secret_KEY"]
    assert request(:get, "/api/resolve/UNKNOWN").status == 404
    assert request(:post, "/api/code", %{url: "not a room"}).status == 400
    assert request(:post, "/api/code", %{url: "javascript:alert(1)#room=a,b"}).status == 400
  end

  test "short code redirects stay on this site and codes die with their room" do
    register("ROOM")

    other =
      json(request(:post, "/api/code", %{url: "https://deck.example/#room=other,k"}))["code"]

    evil =
      json(request(:post, "/api/code", %{url: "https://evil.example/\\x#room=room,secret"}))[
        "code"
      ]

    assert get_resp_header(request(:get, "/s/#{evil}"), "location") == ["/#room=room,secret"]

    assert request(:delete, "/api/rooms/room", %{key: "secret"}).status == 200
    assert request(:get, "/api/resolve/#{evil}").status == 404
    assert request(:get, "/s/#{evil}").status == 404
    assert request(:get, "/api/resolve/#{other}").status == 200
  end

  test "room files store opaque bytes behind the room key and die with the room" do
    register()
    blob = <<0, 255, 1, 2, 3>> <> String.duplicate("x", 70_000)
    put = fn path -> conn(:put, path, blob) |> Router.call(Router.init([])) end

    assert put.("/api/rooms/room/files/abc123?key=wrong").status == 403
    assert put.("/api/rooms/missing/files/abc123?key=secret").status == 404
    assert put.("/api/rooms/room/files/bad.id?key=secret").status == 400
    assert put.("/api/rooms/room/files/abc123?key=secret").status == 200

    fetched = request(:get, "/api/rooms/room/files/abc123?key=secret")
    assert fetched.status == 200
    assert fetched.resp_body == blob
    assert get_resp_header(fetched, "content-type") == ["application/octet-stream"]
    assert request(:get, "/api/rooms/room/files/abc123?key=wrong").status == 403
    assert request(:get, "/api/rooms/room/files/other?key=secret").status == 404

    assert request(:delete, "/api/rooms/room", %{key: "secret"}).status == 200
    register()
    assert request(:get, "/api/rooms/room/files/abc123?key=secret").status == 404
  end

  test "scene etags are stored on write, with a hashing fallback for older records" do
    register()
    [etag] = get_resp_header(save(1), "etag")
    assert etag == Whiteboard.Scenes.fingerprint("iv-1cipher-1")
    assert Store.get("scenes", "room")["checkpointEtag"] == etag

    Store.put("scenes", "room", Map.delete(Store.get("scenes", "room"), "checkpointEtag"))
    legacy = request(:get, "/api/rooms/room/scene?key=secret")
    assert get_resp_header(legacy, "etag") == [etag]
    refute Map.has_key?(json(legacy), "checkpointEtag")
  end

  test "HEAD /api/rooms is a body-less reachability probe" do
    register()
    probe = request(:head, "/api/rooms")
    assert probe.status == 200
    assert probe.resp_body == ""
  end

  test "folders preserve nesting, reject cycles and delete subtrees without deleting scenes" do
    register()
    save(1)
    root = json(request(:post, "/api/rooms/folders", %{name: " School "}))["folder"]
    assert root["name"] == "School"
    assert request(:post, "/api/rooms/folders", %{name: "school"}).status == 409

    child =
      json(request(:post, "/api/rooms/folders", %{name: "Math", parentId: root["id"]}))["folder"]

    grandchild =
      json(request(:post, "/api/rooms/folders", %{name: "Algebra", parentId: child["id"]}))[
        "folder"
      ]

    assert request(:post, "/api/rooms/folders", %{name: "Math"}).status == 200

    assert request(:post, "/api/rooms/folders", %{name: "Math", parentId: root["id"]}).status ==
             409

    assert request(:post, "/api/rooms/folders/#{root["id"]}", %{
             name: "School",
             parentId: grandchild["id"]
           }).status == 400

    renamed =
      json(request(:post, "/api/rooms/folders/#{child["id"]}", %{name: "Mathematics"}))["folder"]

    assert renamed["parentId"] == root["id"]

    for invalid <- ["missing", "__proto__", 123] do
      assert request(:post, "/api/rooms/folders", %{name: "Invalid", parentId: invalid}).status ==
               400

      assert request(:post, "/api/rooms/room/folder", %{key: "secret", folderId: invalid}).status ==
               400
    end

    assert request(:post, "/api/rooms/room/folder", %{key: "secret"}).status == 400

    assert request(:post, "/api/rooms/room/folder", %{key: "wrong", folderId: root["id"]}).status ==
             403

    assert request(:post, "/api/rooms/room/folder", %{key: "secret", folderId: grandchild["id"]}).status ==
             200

    assert request(:delete, "/api/rooms/folders/#{root["id"]}").status == 200
    folders = json(request(:get, "/api/rooms/folders"))["folders"]
    assert length(folders) == 1
    [room] = json(request(:get, "/api/rooms"))["rooms"]
    refute Map.has_key?(room, "folderId")
    assert room["hasScene"]
    assert json(request(:get, "/api/rooms/room/scene?key=secret"))["ciphertext"] == "cipher-1"
    assert request(:delete, "/api/rooms/folders/#{root["id"]}").status == 404
  end

  test "snapshot ETags match the old API, with authenticated HEAD and conditional GET" do
    register()
    assert request(:get, "/api/rooms/room/scene?key=secret").status == 404
    assert save(1).status == 200
    scene = request(:get, "/api/rooms/room/scene?key=secret")
    expected = "\"" <> Base.encode16(:crypto.hash(:sha256, "iv-1cipher-1"), case: :lower) <> "\""
    assert get_resp_header(scene, "etag") == [expected]
    assert get_resp_header(scene, "x-scene-revision") == ["1"]
    assert get_resp_header(scene, "content-length") == [to_string(byte_size(scene.resp_body))]

    unchanged =
      request(:get, "/api/rooms/room/scene?key=secret", nil, [{"if-none-match", expected}])

    assert unchanged.status == 304
    assert unchanged.resp_body == ""

    assert request(:get, "/api/rooms/room/scene?key=wrong", nil, [{"if-none-match", expected}]).status ==
             403

    head = request(:head, "/api/rooms/room/scene?key=secret")
    assert head.status == 200
    assert head.resp_body == ""
    assert get_resp_header(head, "etag") == [expected]
    assert request(:head, "/api/rooms/room/scene?key=wrong").status == 403
    assert save(2).status == 200

    assert request(:get, "/api/rooms/room/scene?key=secret", nil, [{"if-none-match", expected}]).status ==
             200
  end

  test "snapshot history is bounded and empty overwrites cannot destroy a drawing" do
    register()
    assert save(1).status == 200
    assert save(0, %{isEmpty: true}).status == 409
    assert save(0, %{isEmpty: nil}).status == 409
    assert save(2, %{isEmpty: true}).status == 409
    assert save(2, %{key: "wrong"}).status == 403
    assert save(2, %{iv: ""}).status == 400
    for version <- 2..15, do: assert(save(version).status == 200)
    versions = json(request(:get, "/api/rooms/room/scene-history?key=secret"))["versions"]
    assert Enum.map(versions, & &1["version"]) == Enum.to_list(15..5//-1)
    assert json(request(:get, "/api/rooms/room/scene?key=secret&slot=10"))["version"] == 5
    assert request(:get, "/api/rooms/room/scene?key=secret&slot=11").status == 404
    assert request(:get, "/api/rooms/room/scene?key=secret&slot=-1").status == 404
    assert request(:get, "/api/rooms/room/scene?key=secret&slot=bad").status == 404
    assert request(:delete, "/api/rooms/room", %{key: "secret"}).status == 200
    assert Store.get("scenes", "room") == nil
    assert Store.all("snapshots") == %{}
  end

  test "malformed and oversized bodies are rejected before storage" do
    malformed = conn(:post, "/api/rooms", "{bad") |> Router.call(Router.init([]))
    assert malformed.status == 400
    assert request(:post, "/api/rooms", []).status == 400

    oversized =
      conn(:post, "/api/rooms/room/scene", String.duplicate("x", 5 * 1024 * 1024 + 1))
      |> Router.call(Router.init([]))

    assert oversized.status == 413
    assert Store.all("rooms") == %{}
  end

  defp patch(base, version, options \\ %{}) do
    request(
      :patch,
      "/api/rooms/room/scene",
      Map.merge(
        %{
          key: "secret",
          syncVersion: 1,
          baseEtag: base,
          iv: "patch-iv-#{version}",
          ciphertext: "patch-cipher-#{version}",
          sceneVersion: version,
          isEmpty: false
        },
        options
      )
    )
  end

  test "encrypted patch tails are authenticated, revision checked and persisted separately" do
    register()
    saved = save(1)
    [base] = get_resp_header(saved, "etag")
    assert get_resp_header(saved, "x-scene-sync") == ["1"]
    checkpoint = Store.get("scenes", "room")
    assert patch(base, 2, %{key: "wrong"}).status == 403
    assert patch("stale", 2).status == 412
    changed = patch(base, 2)
    assert changed.status == 200
    [next] = get_resp_header(changed, "etag")
    refute next == base
    assert Store.get("scenes", "room") == checkpoint
    assert Store.all("snapshots") == %{}
    assert Store.get("scene-patches", "room")["version"] == 2
    cold = json(request(:get, "/api/rooms/room/scene?key=secret&sync=1"))
    assert cold["ciphertext"] == "cipher-1"
    assert cold["checkpointEtag"] == base
    assert length(cold["patches"]) == 1

    tail =
      json(
        request(
          :get,
          "/api/rooms/room/scene?key=secret&sync=1&since=#{URI.encode_www_form(base)}"
        )
      )

    refute Map.has_key?(tail, "ciphertext")
    assert tail["baseEtag"] == base
    assert tail["patches"] == cold["patches"]

    assert request(:get, "/api/rooms/room/scene?key=secret&sync=1", nil, [{"if-none-match", next}]).status ==
             304

    assert request(:head, "/api/rooms/room/scene?key=secret").status == 200
    assert request(:get, "/api/rooms/room/scene?key=secret").status == 409
    assert save(3).status == 409
    assert patch(base, 3).status == 412
  end

  test "checkpoint compaction retains recoverable encrypted history and stale baselines get a full checkpoint" do
    register()
    [base] = get_resp_header(save(1), "etag")
    [next] = get_resp_header(patch(base, 2), "etag")
    assert save(3, %{syncVersion: 1, baseEtag: base}).status == 412
    saved = save(3, %{syncVersion: 1, baseEtag: next})
    assert saved.status == 200
    assert get_resp_header(saved, "x-scene-patches") == ["0"]
    assert Store.get("scene-patches", "room") == nil

    current =
      json(
        request(
          :get,
          "/api/rooms/room/scene?key=secret&sync=1&since=#{URI.encode_www_form(base)}"
        )
      )

    assert current["ciphertext"] == "cipher-3"
    assert current["patches"] == []
    history = json(request(:get, "/api/rooms/room/scene?key=secret&sync=1&slot=1"))
    assert history["ciphertext"] == "cipher-1"
    assert length(history["patches"]) == 1
    assert request(:delete, "/api/rooms/room", %{key: "secret"}).status == 200
    assert Store.all("snapshots") == %{}
    assert Store.all("scene-patches") == %{}
  end

  test "concurrent conditional writes have exactly one winner" do
    register()
    [base] = get_resp_header(save(1), "etag")
    tasks = for version <- 2..9, do: Task.async(fn -> patch(base, version).status end)
    statuses = Enum.map(tasks, &Task.await/1)
    assert Enum.count(statuses, &(&1 == 200)) == 1
    assert Enum.count(statuses, &(&1 == 412)) == 7
    assert length(Whiteboard.Scenes.get("room")["patches"]) == 1
  end

  test "patch chains require checkpoints after 32 records and reject malformed payloads" do
    register()
    [base] = get_resp_header(save(1), "etag")

    for invalid <- [
          %{iv: ""},
          %{ciphertext: ""},
          %{syncVersion: 2},
          %{sceneVersion: -1},
          %{isEmpty: true}
        ] do
      assert patch(base, 2, invalid).status == 400
    end

    latest =
      Enum.reduce(2..33, base, fn version, etag ->
        changed = patch(etag, version)
        assert changed.status == 200
        hd(get_resp_header(changed, "etag"))
      end)

    assert patch(latest, 34).status == 413
    assert save(34, %{syncVersion: 1, baseEtag: latest}).status == 200
  end

  test "patch storage is byte bounded without discarding the acknowledged chain" do
    register()
    [base] = get_resp_header(save(1), "etag")
    changed = patch(base, 2, %{ciphertext: String.duplicate("a", 3 * 1024 * 1024)})
    assert changed.status == 200
    [latest] = get_resp_header(changed, "etag")
    assert patch(latest, 3, %{ciphertext: String.duplicate("b", 3 * 1024 * 1024)}).status == 413
    assert Whiteboard.Scenes.etag(Whiteboard.Scenes.get("room")) == latest
  end

  test "new room creation uses a null baseline and stale creators cannot overwrite it" do
    register()
    missing = request(:get, "/api/rooms/room/scene?key=secret&sync=1")
    assert missing.status == 404
    assert get_resp_header(missing, "x-scene-sync") == ["1"]
    assert save(1, %{syncVersion: 1, baseEtag: nil}).status == 200
    assert save(2, %{syncVersion: 1, baseEtag: nil}).status == 412
  end

  test "disabling patch creation keeps active chains readable until a conditional checkpoint" do
    register()
    [base] = get_resp_header(save(1), "etag")
    [latest] = get_resp_header(patch(base, 2), "etag")
    Application.put_env(:whiteboard, :scene_sync_enabled, false)
    on_exit(fn -> Application.put_env(:whiteboard, :scene_sync_enabled, true) end)
    current = request(:get, "/api/rooms/room/scene?key=secret&sync=1")
    assert get_resp_header(current, "x-scene-sync") == ["1"]
    assert length(json(current)["patches"]) == 1
    assert patch(latest, 3).status == 413
    checkpoint = save(3, %{syncVersion: 1, baseEtag: latest})
    assert checkpoint.status == 200
    assert get_resp_header(checkpoint, "x-scene-sync") == []
    assert request(:get, "/api/rooms/room/scene?key=secret").status == 200
  end

  test "concurrent scene writes preserve every revision and history entry" do
    register()
    tasks = for version <- 1..8, do: Task.async(fn -> save(version).status end)
    assert Enum.map(tasks, &Task.await/1) == List.duplicate(200, 8)
    scene = Store.get("scenes", "room")
    assert scene["revision"] == 8
    history = Whiteboard.Scenes.history(scene)
    assert length(history) == 7
    assert Enum.sort(Enum.map([scene | history], & &1["version"])) == Enum.to_list(1..8)
  end
end
