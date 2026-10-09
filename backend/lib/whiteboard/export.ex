defmodule Whiteboard.Export do
  alias Whiteboard.{Scenes, Store}

  def run!(directory) do
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
                  "scenes" -> Scenes.export(Scenes.get(id))
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
end
