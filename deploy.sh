#!/usr/bin/env bash
# Deploy the current checkout on this server; only manages these two named units.
set -euo pipefail
SIGNLANGUE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SIGNLANGUE_ROOT"

# Units deliberately describe this server's absolute installation path.
if [[ "$SIGNLANGUE_ROOT" != /home/nguyenhuynh/Documents/sign-lang/signlangue ]]; then
    echo 'Update deploy/*.service installation paths for this machine first.' >&2
    exit 1
fi
for unit in signlangue-vsl.service signlangue-tunnel.service; do
    existing="$(systemctl --user show "$unit" --property=FragmentPath --value 2>/dev/null || true)"
    if [[ -n "$existing" && "$(readlink -f -- "$existing")" != "$SIGNLANGUE_ROOT/deploy/$unit" ]]; then
        echo "Refusing to replace an unrelated service: $unit ($existing)" >&2
        exit 1
    fi
done

.venv/bin/python -c 'from app.api.camera_recognition import _check_assets; _check_assets()'
npm --prefix app/frontend run build

# Never take a port from an unrelated process. An existing owned unit can restart.
if ! systemctl --user is-active --quiet signlangue-vsl.service; then
    .venv/bin/python - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 8010))
PY
fi
if ! systemctl --user is-active --quiet signlangue-tunnel.service; then
    .venv/bin/python - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 20245))
PY
fi

systemctl --user link "$SIGNLANGUE_ROOT/deploy/signlangue-vsl.service" "$SIGNLANGUE_ROOT/deploy/signlangue-tunnel.service"
systemctl --user daemon-reload
systemctl --user enable signlangue-vsl.service signlangue-tunnel.service
systemctl --user restart signlangue-vsl.service
ready=0
for attempt in {1..45}; do
    if curl --fail --silent --max-time 2 http://127.0.0.1:8010/healthz > /dev/null; then
        ready=1
        break
    fi
    sleep 1
done
if [[ "$ready" != 1 ]]; then
    echo 'SignLang did not become ready; inspect journalctl --user -u signlangue-vsl.service.' >&2
    exit 1
fi
systemctl --user start signlangue-tunnel.service
echo 'SignLang is ready at http://127.0.0.1:8010'
echo 'HTTPS URL: journalctl --user -u signlangue-tunnel.service -o cat | rg "https://[a-z0-9-]+\.trycloudflare\.com"'
