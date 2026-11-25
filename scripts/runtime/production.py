"""One-origin production frontend + API, with SPA routing and VSL readiness."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi.concurrency import run_in_threadpool
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from app.api.camera_recognition import _ensure_model, model_status
from app.api.server import app as api

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "app" / "frontend" / "dist"


class FrontendFiles(StaticFiles):
    async def get_response(self, path, scope):
        try:
            response = await super().get_response(path, scope)
        except HTTPException as error:
            # BrowserRouter pages need index.html, while missing assets stay 404.
            if error.status_code != 404 or path not in {
                ".", "camera", "learn", "translate", "video-translate",
            }:
                raise
            response = await super().get_response("index.html", scope)
        if path.startswith("assets/") and response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif response.headers.get("content-type", "").startswith("text/html"):
            response.headers["Cache-Control"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response


frontend = FrontendFiles(directory=DIST, html=True, check_dir=False)


async def dispatch(scope, receive, send):
    path = scope.get("path", "/")
    if path == "/api" or path.startswith("/api/"):
        await api(scope, receive, send)
    else:
        # Serve /models from the built frontend, not the backend's legacy mount.
        await frontend(scope, receive, send)


async def health(request):
    status = model_status()
    ready = status["available"] and status["loaded"]
    return JSONResponse({"status": "ready" if ready else "unavailable", **status},
                        status_code=200 if ready else 503)


@asynccontextmanager
async def lifespan(application):
    if not (DIST / "index.html").is_file():
        raise RuntimeError("Frontend build missing: run npm run build in app/frontend.")
    async with api.router.lifespan_context(api):
        await run_in_threadpool(_ensure_model)
        yield


app = Starlette(routes=[Route("/healthz", health), Mount("/", app=dispatch)],
                lifespan=lifespan)
