defmodule Whiteboard.LegacySnapshotTest do
  use ExUnit.Case, async: false
  alias Whiteboard.{LegacySnapshot, Record, Repo, Store}

  setup do
    Repo.delete_all(Record)

    directory =
      Path.join(
        System.tmp_dir!(),
        "whiteboard-legacy-export-#{System.unique_integer([:positive])}"
      )

    on_exit(fn -> File.rm_rf!(directory) end)
    %{directory: directory}
  end

  defp secret, do: String.duplicate("a", 16)
  defp key, do: Base.url_encode64(secret(), padding: false)

  defp encrypted(value) do
    iv = :crypto.strong_rand_bytes(12)

    {ciphertext, tag} =
      :crypto.crypto_one_time_aead(:aes_128_gcm, secret(), iv, Jason.encode!(value), "", true)

    %{"iv" => Base.encode64(iv), "ciphertext" => Base.encode64(ciphertext <> tag)}
  end

  defp decrypted(value) do
    encrypted = Base.decode64!(value["ciphertext"])
    size = byte_size(encrypted) - 16
    <<ciphertext::binary-size(size), tag::binary-size(16)>> = encrypted

    :crypto.crypto_one_time_aead(
      :aes_128_gcm,
      secret(),
      Base.decode64!(value["iv"]),
      ciphertext,
      "",
      tag,
      false
    )
    |> Jason.decode!()
  end

  defp scene do
    encrypted([%{"id" => "edited", "x" => 0}, %{"id" => "removed"}, %{"id" => "tombstone"}])
    |> Map.put("patches", [
      encrypted(%{
        "format" => 1,
        "upserts" => [
          %{"id" => "edited", "x" => 100},
          %{"id" => "added"},
          %{"id" => "tombstone", "isDeleted" => true}
        ],
        "removedIds" => ["removed"],
        "order" => ["added", "edited", "tombstone"]
      })
    ])
    |> Map.put("history", [])
    |> Map.put("version", 4)
  end

  test "legacy compaction authenticates, replays and re-encrypts a complete scene" do
    original = scene()
    compacted = LegacySnapshot.compact(original, key())

    assert decrypted(compacted) == [
             %{"id" => "added"},
             %{"id" => "edited", "x" => 100},
             %{"id" => "tombstone", "isDeleted" => true}
           ]

    refute Map.has_key?(compacted, "patches")
    assert compacted["version"] == 4
    assert length(original["patches"]) == 1

    assert LegacySnapshot.compact(%{"iv" => "opaque", "ciphertext" => "opaque"}, "invalid") == %{
             "iv" => "opaque",
             "ciphertext" => "opaque"
           }
  end

  test "legacy compaction preserves order for edit-only patches" do
    original =
      encrypted([%{"id" => "first"}, %{"id" => "second"}])
      |> Map.put("patches", [
        encrypted(%{
          "format" => 1,
          "upserts" => [%{"id" => "second", "x" => 2}],
          "removedIds" => []
        })
      ])

    assert decrypted(LegacySnapshot.compact(original, key())) == [
             %{"id" => "first"},
             %{"id" => "second", "x" => 2}
           ]
  end

  test "wrong keys and inconsistent ordering abort instead of losing shapes" do
    assert_raise RuntimeError, ~r/authentication failed/, fn ->
      LegacySnapshot.compact(
        scene(),
        Base.url_encode64(String.duplicate("b", 16), padding: false)
      )
    end

    invalid =
      Map.put(scene(), "patches", [
        encrypted(%{"format" => 1, "upserts" => [], "removedIds" => [], "order" => []})
      ])

    assert_raise RuntimeError, ~r/scene order/, fn -> LegacySnapshot.compact(invalid, key()) end
  end

  test "legacy exports include compacted current and historical scenes without modifying storage",
       %{directory: directory} do
    original = Map.put(scene(), "history", [scene()])

    Store.transaction(fn ->
      Store.put("rooms", "room", %{"key" => key()})
      Whiteboard.Scenes.import("room", original)
    end)

    Whiteboard.Export.run!(directory, legacy: true)
    exported = Jason.decode!(File.read!(Path.join(directory, "scenes.json")))["room"]
    assert decrypted(exported) == decrypted(hd(exported["history"]))
    refute Map.has_key?(exported, "patches")
    refute Map.has_key?(hd(exported["history"]), "patches")
    assert length(Whiteboard.Scenes.get("room")["patches"]) == 1
  end

  test "failed legacy authentication writes no export files", %{directory: directory} do
    Store.transaction(fn ->
      Store.put("rooms", "room", %{
        "key" => Base.url_encode64(String.duplicate("b", 16), padding: false)
      })

      Whiteboard.Scenes.import("room", scene())
    end)

    assert_raise RuntimeError, ~r/authentication failed/, fn ->
      Whiteboard.Export.run!(directory, legacy: true)
    end

    assert File.ls!(directory) == []
  end
end
