from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers
from starlette.middleware.trustedhost import TrustedHostMiddleware

from env_utils import load_env_files

# Production installs keep .env root-owned (0600) and rely on systemd's
# EnvironmentFile; an unreadable file must not crash the app.
load_env_files()

if not os.environ.get("GOOGLE_CLIENT_ID", "").strip():
    logging.getLogger("salvage_pulse").warning(
        "Google sign-in is disabled because GOOGLE_CLIENT_ID is not set. "
        "Set it in .env and restart the service."
    )

from gemini_service import is_gemini_configured
import store
import database

# Initialize database schema and run migrations
database.init_schema()
from routers import admin, analytics, auth, billing, calls, forms, roleplay, settings, team
from security import request_origin_allowed

ENVIRONMENT = os.environ.get("ENVIRONMENT", "development").strip().lower()
IS_PRODUCTION = ENVIRONMENT in ("production", "prod")
DOCS_ENABLED = os.environ.get("DOCS_ENABLED", "0" if IS_PRODUCTION else "1").lower() in ("1", "true", "yes")
MAX_JSON_BODY_BYTES = int(os.environ.get("MAX_JSON_BODY_BYTES", str(2 * 1024 * 1024)))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "25")) * 1024 * 1024

app = FastAPI(
    title="Salvage Pulse AI API",
    version="1.0.0-beta.10",
    docs_url="/docs" if DOCS_ENABLED else None,
    redoc_url="/redoc" if DOCS_ENABLED else None,
    openapi_url="/openapi.json" if DOCS_ENABLED else None,
)

allowed_origins = [
    "https://app.salvagepulsepro.com",
    "https://salvagepulsepro.com",
    "http://localhost:8000",
    "http://localhost:5173",
    "http://127.0.0.1:8000",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
]
extra_origin = os.environ.get("APP_URL", "").strip().rstrip("/")
if extra_origin and extra_origin not in allowed_origins:
    allowed_origins.append(extra_origin)
for origin in os.environ.get("ALLOWED_ORIGINS", "").split(","):
    origin = origin.strip().rstrip("/")
    if origin and origin not in allowed_origins:
        allowed_origins.append(origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Optional Host-header allowlist.  This closes DNS-rebinding/CSRF tricks where
# an attacker controls both the Host header and the Origin.  Local health checks
# keep working because loopback hosts are always accepted.
_configured_hosts = [
    h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()
]
if _configured_hosts:
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=_configured_hosts + ["localhost", "127.0.0.1", "[::1]", "testserver"],
    )

_UPLOAD_PATH_HINTS = (
    "/audio",
    "/bulk-audio",
    "/import",
    "/attach",
    "/branding/logo",
    "/uploads",
    "/forms/upload",
)


class _BodyTooLarge(Exception):
    pass


class BodySizeLimitMiddleware:
    """Reject oversized requests before they are buffered into memory."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        limit = MAX_UPLOAD_BYTES if any(hint in path for hint in _UPLOAD_PATH_HINTS) else MAX_JSON_BODY_BYTES
        headers = Headers(scope=scope)
        declared = headers.get("content-length")
        if declared:
            try:
                if int(declared) > limit:
                    await self._too_large(send)
                    return
            except ValueError:
                await self._too_large(send)
                return

        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body", b"") or b"")
                if received > limit:
                    raise _BodyTooLarge()
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _BodyTooLarge:
            await self._too_large(send)

    @staticmethod
    async def _too_large(send):
        body = b'{"detail":"Request body is too large."}'
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})


class CSRFMiddleware:
    """Reject state-changing browser requests from foreign origins.

    Authentication is cookie based, so an attacker's page must not be able to
    submit authenticated requests.  Non-browser clients (no Origin/Referer) are
    unaffected.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") in ("GET", "HEAD", "OPTIONS"):
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive=receive)
        if not request_origin_allowed(request, allowed_origins):
            response = JSONResponse({"detail": "Cross-site request blocked."}, status_code=403)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


class SecurityHeadersMiddleware:
    def __init__(self, app):
        self.app = app
        self.csp = os.environ.get(
            "CONTENT_SECURITY_POLICY",
            "default-src 'self'; "
            "script-src 'self' https://accounts.google.com https://www.gstatic.com; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "img-src 'self' data: blob: https:; "
            "font-src 'self' data: https://fonts.gstatic.com; "
            "connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com https://www.gstatic.com; "
            "frame-src https://accounts.google.com; "
            "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        ).strip()

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message):
            if message.get("type") == "http.response.start":
                headers = list(message.get("headers", []))
                additions = {
                    b"x-content-type-options": b"nosniff",
                    b"x-frame-options": b"DENY",
                    b"referrer-policy": b"strict-origin-when-cross-origin",
                    b"permissions-policy": b"camera=(), microphone=(), geolocation=()",
                    # Allow the Google OAuth popup to keep its opener; plain
                    # "same-origin" breaks postMessage-based sign-in flows.
                    b"cross-origin-opener-policy": b"same-origin-allow-popups",
                }
                if self.csp:
                    additions[b"content-security-policy"] = self.csp.encode("utf-8")
                if IS_PRODUCTION:
                    additions[b"strict-transport-security"] = b"max-age=31536000; includeSubDomains"
                existing = {k.lower() for k, _ in headers}
                for key, value in additions.items():
                    if key not in existing:
                        headers.append((key, value))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)


# Starlette applies middleware in reverse registration order, so the security
# header layer is registered last to become the outermost layer.
app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(CSRFMiddleware)
app.add_middleware(SecurityHeadersMiddleware)

# ==========================================
# Root Health & AI Status Endpoints
# ==========================================
@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": "1.0.0-beta.10",
        "stage": "beta",
        "timestamp": store.now_iso(),
    }


@app.get("/api/system/version")
def system_version() -> dict[str, Any]:
    return {
        "version": "1.0.0-beta.10",
        "stage": "beta",
        "is_beta": True,
        "release_date": "2026-11-04",
    }


@app.get("/api/system/ai-status")
def ai_status() -> dict[str, Any]:
    configured = is_gemini_configured()
    return {
        "provider": "google_gemini" if configured else "heuristic_fallback",
        "configured": configured,
        "model": os.getenv("GEMINI_MODEL", "gemini-3.5-flash") if configured else "heuristic",
        "multimodal_audio_ready": configured,
    }


# ==========================================
# Mount Modular Routers
# ==========================================
app.include_router(auth.router)
app.include_router(settings.router)
app.include_router(calls.router)
app.include_router(forms.router)
app.include_router(analytics.router)
app.include_router(roleplay.router)
app.include_router(team.router)
app.include_router(billing.public_router)
app.include_router(billing.router)
app.include_router(admin.router)

# ==========================================
# Static Files & SPA Fallback (Production)
# ==========================================
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
FRONTEND_DIST = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend", "dist")

dist_dir = None
if os.path.exists(STATIC_DIR) and os.path.exists(os.path.join(STATIC_DIR, "index.html")):
    dist_dir = STATIC_DIR
elif os.path.exists(FRONTEND_DIST) and os.path.exists(os.path.join(FRONTEND_DIST, "index.html")):
    dist_dir = FRONTEND_DIST

if dist_dir:
    dist_root = os.path.realpath(dist_dir)
    assets_dir = os.path.join(dist_root, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api"):
            raise HTTPException(status_code=404, detail="API endpoint not found")

        # Resolve inside the dist directory only; blocks ../ path traversal.
        direct = os.path.realpath(os.path.join(dist_root, full_path))
        if (direct == dist_root or direct.startswith(dist_root + os.sep)) and os.path.isfile(direct):
            return FileResponse(direct)

        index_file = os.path.join(dist_root, "index.html")
        if os.path.isfile(index_file):
            return FileResponse(index_file)
        raise HTTPException(status_code=404, detail="Not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        reload=not IS_PRODUCTION,
    )
