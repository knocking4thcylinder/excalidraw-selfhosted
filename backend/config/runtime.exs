import Config

if config_env() != :test do
  database = System.get_env("DATABASE_PATH", "data/whiteboard.sqlite3") |> Path.expand()
  config :whiteboard, Whiteboard.Repo, database: database
  config :whiteboard, :legacy_data_dir, System.get_env("LEGACY_DATA_DIR")
  config :whiteboard, :scene_sync_enabled, System.get_env("SCENE_SYNC_ENABLED", "false") == "true"

  config :whiteboard, Whiteboard.Endpoint,
    http: [
      ip:
        System.get_env("BIND_ADDRESS", "127.0.0.1")
        |> String.to_charlist()
        |> :inet.parse_address()
        |> elem(1),
      port: String.to_integer(System.get_env("PORT", "3003"))
    ]
end
