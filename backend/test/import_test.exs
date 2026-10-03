defmodule Whiteboard.ImportTest do
  use ExUnit.Case, async: false
  alias Whiteboard.{Import, Record, Repo, Store}

  setup do
    Repo.delete_all(Record)

    directory =
      Path.join(System.tmp_dir!(), "whiteboard-import-#{System.unique_integer([:positive])}")

    File.mkdir_p!(directory)
    on_exit(fn -> File.rm_rf!(directory) end)
    %{directory: directory}
  end

  test "imports JSON without modifying originals, preserves history and never reimports stale data",
       %{directory: directory} do
    documents = %{
      "rooms" => %{
        "room" => %{
          "key" => "secret",
          "createdAt" => 1,
          "lastActiveAt" => 2,
          "hasScene" => true,
          "folderId" => "folder"
        }
      },
      "folders" => %{
        "folder" => "Legacy folder",
        "child" => %{"name" => "Child", "parentId" => "folder"}
      },
      "codes" => %{"ABCD-EFGH" => "https://deck/#room=room,secret"},
      "scenes" => %{
        "room" => %{
          "iv" => "iv",
          "ciphertext" => "encrypted",
          "version" => 2,
          "updatedAt" => 2,
          "history" => [
            %{"iv" => "old", "ciphertext" => "old-encrypted", "version" => 1, "updatedAt" => 1}
          ]
        }
      }
    }

    for {kind, data} <- documents,
        do: File.write!(Path.join(directory, "#{kind}.json"), Jason.encode!(data))

    assert Import.run!(directory)
    assert Store.get("folders", "folder") == %{"name" => "Legacy folder"}
    assert Store.get("codes", "ABCD-EFGH")["url"] == documents["codes"]["ABCD-EFGH"]
    assert Whiteboard.Scenes.export(Store.get("scenes", "room")) == documents["scenes"]["room"]
    Store.put("rooms", "room", %{"key" => "new-secret"})
    Import.run!(directory)
    assert Store.get("rooms", "room")["key"] == "new-secret"

    for {kind, data} <- documents,
        do: assert(Jason.decode!(File.read!(Path.join(directory, "#{kind}.json"))) == data)
  end

  test "export and import preserve active encrypted patch chains", %{directory: directory} do
    scene = %{
      "iv" => "iv",
      "ciphertext" => "checkpoint",
      "version" => 2,
      "updatedAt" => 2,
      "patches" => [
        %{"iv" => "patch-iv", "ciphertext" => "patch", "baseEtag" => "base", "etag" => "next"}
      ],
      "history" => []
    }

    Store.transaction(fn ->
      Store.put("rooms", "room", %{"key" => "secret"})
      Whiteboard.Scenes.import("room", scene)
    end)

    Whiteboard.Export.run!(directory)
    assert Jason.decode!(File.read!(Path.join(directory, "scenes.json")))["room"] == scene
    Repo.delete_all(Record)
    Import.run!(directory)
    assert Whiteboard.Scenes.export(Whiteboard.Scenes.get("room")) == scene
    assert Store.get("scenes", "room")["patches"] == nil
    assert Store.get("scene-patches", "room")["patches"] == scene["patches"]
  end

  test "corrupt files roll back the entire import", %{directory: directory} do
    File.write!(
      Path.join(directory, "rooms.json"),
      Jason.encode!(%{"room" => %{"key" => "secret"}})
    )

    File.write!(Path.join(directory, "scenes.json"), "broken")
    assert_raise Jason.DecodeError, fn -> Import.run!(directory) end
    assert Store.all("rooms") == %{}
    assert Store.get("meta", "legacy-import") == nil
  end

  test "does not overwrite a populated database", %{directory: directory} do
    Store.put("rooms", "existing", %{"key" => "keep"})
    assert_raise RuntimeError, ~r/populated database/, fn -> Import.run!(directory) end
    assert Store.get("rooms", "existing")["key"] == "keep"
  end

  test "rejects a missing import directory", %{directory: directory} do
    assert_raise RuntimeError, ~r/does not exist/, fn ->
      Import.run!(Path.join(directory, "missing"))
    end

    assert Store.get("meta", "legacy-import") == nil
  end

  test "export round trips keys, codes and encrypted snapshots", %{directory: directory} do
    Store.put("rooms", "room", %{"key" => "secret"})
    Store.put("codes", "ABCD-EFGH", %{"url" => "https://deck/#room=room,secret"})

    Whiteboard.Scenes.import("room", %{
      "iv" => "iv",
      "ciphertext" => "opaque",
      "history" => [],
      "revision" => 1
    })

    Whiteboard.Export.run!(directory)

    assert Jason.decode!(File.read!(Path.join(directory, "codes.json"))) == %{
             "ABCD-EFGH" => "https://deck/#room=room,secret"
           }

    Repo.delete_all(Record)
    Import.run!(directory)
    assert Store.get("rooms", "room")["key"] == "secret"
    assert Store.get("scenes", "room")["ciphertext"] == "opaque"
    assert_raise File.Error, fn -> Whiteboard.Export.run!(directory) end
  end
end
