defmodule Whiteboard.Import do
  alias Whiteboard.Store

  def run!(directory) do
    Store.transaction(fn ->
      unless Store.get("meta", "legacy-import") do
        unless File.dir?(directory),
          do: raise("legacy data directory does not exist: #{directory}")

        existing = Enum.any?(["rooms", "folders", "scenes", "codes"], &(Store.all(&1) != %{}))
        if existing, do: raise("refusing legacy import into a populated database")

        for kind <- ["rooms", "folders", "scenes", "codes"] do
          path = Path.join(directory, "#{kind}.json")

          data =
            case File.read(path) do
              {:ok, contents} -> Jason.decode!(contents)
              {:error, :enoent} -> %{}
              {:error, reason} -> raise File.Error, reason: reason, action: "read", path: path
            end

          unless is_map(data), do: raise("#{path} must contain a JSON object")

          for {id, value} <- data do
            value = normalize(kind, value)
            unless is_map(value), do: raise("invalid #{kind} record #{id}")

            if kind == "scenes",
              do: Whiteboard.Scenes.import(id, value),
              else: Store.put(kind, id, value)
          end
        end

        Store.put("meta", "legacy-import", %{"directory" => Path.expand(directory)})
      end
    end)
  end

  defp normalize("folders", value) when is_binary(value), do: %{"name" => value}
  defp normalize("codes", value) when is_binary(value), do: %{"url" => value}
  defp normalize(_kind, value), do: value
end
