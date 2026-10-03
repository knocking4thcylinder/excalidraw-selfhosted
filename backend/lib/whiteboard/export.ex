defmodule Whiteboard.Export do
  alias Whiteboard.Store

  def run!(directory, options \\ []) do
    File.mkdir_p!(directory)

    documents =
      Store.transaction(fn ->
        Map.new(["rooms", "folders", "scenes", "codes"], fn kind ->
          records = Store.all(kind)

          values =
            Map.new(records, fn {id, value} ->
              value =
                case kind do
                  "codes" -> value["url"]
                  "scenes" -> export_scene(id, options)
                  _ -> value
                end

              {id, value}
            end)

          {kind, Jason.encode!(values)}
        end)
      end)

    for {kind, body} <- documents do
      path = Path.join(directory, "#{kind}.json")
      File.write!(path, body, [:exclusive])
      File.chmod!(path, 0o600)
    end
  end

  defp export_scene(id, options) do
    scene = Whiteboard.Scenes.export(Whiteboard.Scenes.get(id))

    if Keyword.get(options, :legacy, false) do
      key = Store.get("rooms", id)["key"]
      scene = Whiteboard.LegacySnapshot.compact(scene, key)

      Map.update!(scene, "history", fn history ->
        Enum.map(history, &Whiteboard.LegacySnapshot.compact(&1, key))
      end)
    else
      scene
    end
  end
end
