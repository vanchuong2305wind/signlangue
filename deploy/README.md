# Deployment on the current server

Installation: `/home/nguyenhuynh/Documents/sign-lang/signlangue`, user
`nguyenhuynh`. The production frontend and FastAPI API share
`http://127.0.0.1:8010`. A separate Cloudflare Quick Tunnel provides public HTTPS,
which browsers need to use the camera from another machine or phone.

## Deploy the current checkout

```bash
cd /home/nguyenhuynh/Documents/sign-lang/signlangue
./deploy.sh
```

Prerequisites: the existing `.venv`, frontend `node_modules`, `cloudflared`, and
the two VSL224 assets documented in `docs/CAMERA_VSL.md`. The script builds the
frontend, verifies assets and free ports, links/enables two user systemd units,
and restarts only `signlangue-vsl.service`. It starts the tunnel after the API
health check succeeds. Re-running does not change or restart unrelated services.
Changing the installation path or ports requires updating both unit files.

The server was configured with `Linger=yes` for this user so user services keep
running after logout and start at boot. This can be checked with:

```bash
loginctl show-user nguyenhuynh -p Linger
```

## Status and management

```bash
systemctl --user status signlangue-vsl.service signlangue-tunnel.service
journalctl --user -u signlangue-vsl.service -n 100 --no-pager
journalctl --user -u signlangue-tunnel.service -n 100 --no-pager
curl --fail http://127.0.0.1:8010/healthz
```

Retrieve the current temporary HTTPS URL:

```bash
journalctl --user -u signlangue-tunnel.service -o cat --no-pager | rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1
```

The tunnel URL changes when the tunnel process restarts, including after a
reboot or a backend restart through its service dependency. `deploy/runtime/status.json` records the URL verified at deployment time;
it is a snapshot, not a guarantee that a later restarted tunnel has the same URL.
A fixed domain requires a named tunnel/domain configuration supplied separately.
The Quick Tunnel exposes the application's existing API as well as its frontend;
the project currently uses a shared profile and has no user authentication.

To stop just this deployment:

```bash
systemctl --user stop signlangue-tunnel.service signlangue-vsl.service
```

To start it again:

```bash
systemctl --user start signlangue-vsl.service signlangue-tunnel.service
```

## Runtime details

`scripts/runtime/production.py` serves Vite's built `dist`, supports direct SPA
navigation to `/camera`, `/learn`, `/translate`, and `/video-translate`, and sends
`/api/*` requests to the existing backend. `/models/avatar.vrm` comes from the
frontend build; private model checkpoints and project files are not served.
Fingerprint-named `/assets/*` files are cached; HTML uses `no-cache`.

Startup requires a built frontend and a successful strict load of VSL224. A
failed checkpoint load fails service startup rather than serving an old model.
`/healthz` returns 200 only when the model is loaded and assets are available.
One worker keeps a single model instance and the existing inference lock.
`LOCAL_AI_PRELOAD=0` avoids loading unrelated speech/NLP models in the background;
their existing on-demand paths remain available.

At deployment, the HTTPS homepage, camera page, model status, dictionary stats,
JS asset and avatar HEAD requests passed. A real dataset clip was recognized
through loopback HTTP only; no dataset video was sent through the public tunnel.
The loopback result was `tự_tin` (0.708 confidence), model VSL224-Hiera-RGB on CUDA.
Three production routing tests passed. Camera hardware has not been tested.

The server currently reports `gemini_configured=false`. “Tạo câu có nghĩa” uses
the existing local word-joining fallback; configure a valid Gemini key separately
to enable its language-model path. No secret values are stored in these files.
