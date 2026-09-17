#!/bin/sh
set -eu
fresco_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec "$fresco_root/work/build/fresco_cad.app/Contents/MacOS/fresco_cad" "$@"
