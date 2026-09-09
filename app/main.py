"""
HomeDock Web-Based Server Manager.
Main FastAPI application entrypoint.
"""

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import BASE_DIR, DATA_DIR, HOST, PORT
from app.database import init_db
from app.services.storage_manager import storage_manager
from app.services.download_manager import download_manager

from app.routers.auth import router as auth_router
from app.routers.system import router as system_router
from app.routers.storage import router as storage_router
from app.routers.files import router as files_router
from app.routers.downloads import router as downloads_router
from app.routers.settings import router as settings_router
from app.routers.users import router as users_router
from app.routers.ws import router as ws_router

STATIC_DIR = BASE_DIR / "static"

# Security Headers Middleware
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        # Content Security Policy allowing inline scripts for self-hosted dashboard
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "img-src 'self' data: blob:; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "font-src 'self' data:; "
            "connect-src 'self' ws: wss:;"
        )
        return response

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    init_db()
    storage_manager.start_monitoring()
    try:
        download_manager.ensure_daemon_started()
    except Exception as e:
        print(f"[Warning] Failed to pre-start aria2 daemon: {e}", file=sys.stderr)
        
    yield
    
    # Shutdown
    storage_manager.stop_monitoring()
    download_manager.stop_daemon()

app = FastAPI(
    title="HomeDock",
    description="Lightweight, modern, responsive web-based server manager",
    version="1.0.0",
    lifespan=lifespan
)

# Middleware
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API Routers
app.include_router(auth_router)
app.include_router(system_router)
app.include_router(storage_router)
app.include_router(files_router)
app.include_router(downloads_router)
app.include_router(settings_router)
app.include_router(users_router)
app.include_router(ws_router)

# Mount static files
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
@app.head("/")
async def root():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return {"message": "HomeDock API Online"}

# SPA catch-all fallback for frontend routes
@app.get("/{full_path:path}")
async def catch_all(full_path: str):
    # If path starts with api/, return 404
    if full_path.startswith("api/") or full_path.startswith("static/"):
        return FileResponse(status_code=404)
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return {"detail": "Not Found"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=False)
