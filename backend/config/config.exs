import Config

config :whiteboard, ecto_repos: [Whiteboard.Repo]
config :whiteboard, :scene_sync_enabled, config_env() == :test

config :whiteboard, Whiteboard.Repo,
  database: Path.expand("../data/whiteboard.sqlite3", __DIR__),
  pool_size: 1,
  journal_mode: :wal,
  busy_timeout: 5_000

config :whiteboard, :http,
  ip: {127, 0, 0, 1},
  port: 3003,
  server: config_env() != :test

config :logger, level: :info
config :logger, :console, format: "$time $level $message\n"

if config_env() == :test do
  config :whiteboard, Whiteboard.Repo,
    database: Path.join(System.tmp_dir!(), "whiteboard-test-#{System.pid()}.sqlite3")
end
