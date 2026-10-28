from __future__ import annotations

import os
from typing import Any
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Load .env file
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
load_dotenv()

from gemini_service import is_gemini_configured
import store
from routers import admin, analytics, auth, billing, calls, roleplay, settings, team

app = FastAPI(title="Salvage Pulse AI API", version="2.0.0")

allowed_origins = [
    "https://app.salvagepulsepro.com",
    "https://salvagepulsepro.com",
    "http://localhost:8000",
    "http://localhost:5173",
    "http://127.0.0.1:8000",
]
extra_origin = os.environ.get("APP_URL", "").strip().rstrip("/")
if extra_origin and extra_origin not in allowed_origins:
    allowed_origins.append(extra_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# ==========================================
# Root Health & AI Status Endpoints
# ==========================================
@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "timestamp": store.now_iso()}


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
app.include_router(analytics.router)
app.include_router(roleplay.router)
app.include_router(team.router)
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
    assets_dir = os.path.join(dist_dir, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api"):
            raise HTTPException(status_code=404, detail="API endpoint not found")
        direct = os.path.join(dist_dir, full_path)
        if os.path.isfile(direct):
            return FileResponse(direct)
        index_file = os.path.join(dist_dir, "index.html")
        if os.path.isfile(index_file):
            return FileResponse(index_file)
        raise HTTPException(status_code=404, detail="Not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
