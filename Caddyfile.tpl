@@FQDN@@ {
  tls /certs/@@FQDN@@.crt /certs/@@FQDN@@.key
  handle /socket.io/* {
    reverse_proxy localhost:3002
  }
  handle {
    reverse_proxy localhost:3000
  }
}
