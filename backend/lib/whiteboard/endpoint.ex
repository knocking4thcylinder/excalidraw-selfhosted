defmodule Whiteboard.Endpoint do
  use Phoenix.Endpoint, otp_app: :whiteboard
  plug(Whiteboard.Router)
end
