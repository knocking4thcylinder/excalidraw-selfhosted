#!/bin/bash
set -euo pipefail
BASE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec bash "$BASE/deploy.sh" deploy "$@"
