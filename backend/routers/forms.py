"""Per-yard form library.

Owners and sales managers can upload and delete the forms their yard uses
(vendor forms, warranty paperwork, delivery sheets, fillable PDFs, and so on).
Files and metadata are always scoped to one org so yards never see each
other's documents.
"""
from __future__ import annotations

import mimetypes
import os
import re
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

import store

from auth_utils import get_current_user, get_uploads_dir
from security import (
    assert_same_org,
    effective_org,
    is_staff,
    require_authenticated,
    resolve_write_org,
    safe_join,
    validate_upload,
)

router = APIRouter(tags=["forms"], dependencies=[Depends(require_authenticated)])

FORM_EXTENSIONS = frozenset({
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
    ".txt",
    ".rtf",
    ".odt",
    ".ods",
    ".ppt",
    ".pptx",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
})
FORM_MANAGER_ROLES = frozenset({"owner", "sales_manager"})
MAX_FILES_PER_UPLOAD = 20


def _forms_root() -> str:
    root = os.path.join(get_uploads_dir(), "forms")
    os.makedirs(root, mode=0o700, exist_ok=True)
    try:
        os.chmod(root, 0o700)
    except OSError:
        pass
    return root


def _org_folder(org_id: str) -> str:
    """A filesystem-safe folder name for one yard."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(org_id or ""))[:120]
    if not safe or safe in (".", ".."):
        return "yard"
    return safe


def _form_path(org_id: str, stored_name: str) -> str:
    return safe_join(_forms_root(), _org_folder(org_id), os.path.basename(stored_name))


def _display_name(filename: Optional[str]) -> str:
    base = os.path.basename(str(filename or "form"))
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip()
    return (base or "form")[:240]


def _require_form_manager(user: dict[str, Any]) -> None:
    if user.get("role") not in FORM_MANAGER_ROLES and not is_staff(user):
        raise HTTPException(status_code=403, detail="Only owners and sales managers can manage the form library")


def _public_form(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item.get("id", ""),
        "org_id": item.get("org_id", ""),
        "filename": item.get("filename", ""),
        "content_type": item.get("content_type", "application/octet-stream"),
        "size_bytes": int(item.get("size_bytes") or 0),
        "uploaded_by": item.get("uploaded_by", ""),
        "uploaded_at": item.get("uploaded_at", ""),
        "download_url": f"/api/forms/{item.get('id', '')}/download",
    }


def _find_form(st: dict[str, Any], form_id: str) -> dict[str, Any] | None:
    return next((item for item in st.get("form_library", []) if item.get("id") == form_id), None)


@router.get("/api/forms")
def list_forms(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    items = st.get("form_library", [])
    if org_id:
        items = [item for item in items if item.get("org_id") == org_id]
    items = sorted(items, key=lambda item: item.get("uploaded_at", ""), reverse=True)
    return [_public_form(item) for item in items]


@router.post("/api/forms/upload")
async def upload_forms(
    request: Request,
    files: list[UploadFile] = File(...),
    org_id: str = Form(""),
) -> dict[str, Any]:
    u = get_current_user(request)
    _require_form_manager(u)
    target_org = resolve_write_org(u, org_id or None)
    if not target_org:
        raise HTTPException(status_code=400, detail="Choose a yard before uploading forms")
    if not files:
        raise HTTPException(status_code=400, detail="Choose at least one form to upload")
    if len(files) > MAX_FILES_PER_UPLOAD:
        raise HTTPException(status_code=400, detail=f"Upload at most {MAX_FILES_PER_UPLOAD} forms at a time")

    # Read and validate the whole batch before writing anything, so one bad
    # file cannot leave orphaned files or half-saved metadata behind.
    prepared: list[tuple[UploadFile, str, bytes, str]] = []
    for upload in files:
        filename = _display_name(upload.filename)
        content = await upload.read()
        ext = validate_upload(content, filename, FORM_EXTENSIONS)
        prepared.append((upload, filename, content, ext))

    st = store.get_state()
    created: list[dict[str, Any]] = []
    for upload, filename, content, ext in prepared:
        stored_name = f"{uuid.uuid4().hex}{ext}"
        path = _form_path(target_org, stored_name)
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(content)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

        content_type = (
            (upload.content_type or "").split(";", 1)[0].strip()
            or mimetypes.guess_type(filename)[0]
            or "application/octet-stream"
        )
        item = {
            "id": uuid.uuid4().hex,
            "org_id": target_org,
            "filename": filename,
            "content_type": content_type,
            "size_bytes": len(content),
            "stored_name": stored_name,
            "uploaded_by": u.get("name", "Manager"),
            "uploaded_by_id": u.get("id", ""),
            "uploaded_at": store.now_iso(),
        }
        st.setdefault("form_library", []).insert(0, item)
        created.append(_public_form(item))

    store.save_state()
    return {"uploaded": len(created), "items": created}


@router.get("/api/forms/{form_id}/download")
def download_form(form_id: str, request: Request) -> FileResponse:
    st = store.get_state()
    u = get_current_user(request)
    item = _find_form(st, form_id)
    if not item:
        raise HTTPException(status_code=404, detail="Form not found")
    assert_same_org(u, item.get("org_id"))
    path = _form_path(str(item.get("org_id") or ""), str(item.get("stored_name") or ""))
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Form file is missing")
    return FileResponse(
        path,
        media_type=item.get("content_type") or "application/octet-stream",
        filename=item.get("filename") or "form",
    )


@router.delete("/api/forms/{form_id}")
def delete_form(form_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_form_manager(u)
    item = _find_form(st, form_id)
    if not item:
        raise HTTPException(status_code=404, detail="Form not found")
    assert_same_org(u, item.get("org_id"))
    path = _form_path(str(item.get("org_id") or ""), str(item.get("stored_name") or ""))
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        # Metadata is still removed so a missing file cannot leave a dead row.
        pass
    st["form_library"] = [row for row in st.get("form_library", []) if row.get("id") != form_id]
    store.save_state()
    return {"ok": True, "id": form_id}

