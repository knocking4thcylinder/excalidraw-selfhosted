# Commands for the Deck stack. deploy.sh does the work; `just` lists recipes.
# Deploy recipes take --local to skip `git pull` and deploy the working tree.

_default:
    @just --list --unsorted

# Pull, rebuild the app and API, update Caddy routes, check HTTPS
[group('deploy')]
deploy *flags:
    ./deploy.sh full {{ flags }}

# Rebuild and restart the frontend only
[group('deploy')]
app *flags:
    ./deploy.sh app {{ flags }}

# Rebuild and restart the Elixir API only
[group('deploy')]
backend *flags:
    ./deploy.sh backend {{ flags }}

# Build the app image without restarting anything
[group('deploy')]
build:
    ./deploy.sh build

# Install the units, renew the certificate and start the stack; no rebuild
[group('stack')]
start:
    ./deploy.sh start

# Container and service state, plus HTTPS checks
[group('stack')]
status:
    ./deploy.sh status

# HTTPS checks against the app, room server and API
[group('stack')]
check:
    ./deploy.sh check

# Recent logs from all four services
[group('stack')]
logs:
    ./deploy.sh logs

# Restart the whole stack
[group('stack')]
restart:
    sudo systemctl restart excalidraw-stack.target

# Remove dangling images
[group('stack')]
cleanup:
    ./deploy.sh cleanup

# Test the deploy scripts against a mocked host
[group('dev')]
test:
    node --test deploy.test.js

# Run the frontend dev server
[group('dev')]
dev:
    cd app && yarn start
