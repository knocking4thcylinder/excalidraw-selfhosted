FROM docker.io/library/elixir:1.18.4-otp-27-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
ENV MIX_ENV=prod
RUN mix local.hex --force && mix local.rebar --force
COPY mix.exs mix.lock ./
COPY config config
RUN mix deps.get --only prod && mix deps.compile
COPY lib lib
COPY priv priv
RUN mix compile --warnings-as-errors && mix release

FROM docker.io/library/debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libncurses6 libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY --from=build /srv/_build/prod/rel/whiteboard ./
ENV DATABASE_PATH=/data/whiteboard.sqlite3 BIND_ADDRESS=127.0.0.1 PORT=3003 LANG=C.UTF-8
CMD ["/srv/bin/whiteboard", "start"]
