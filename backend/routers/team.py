from __future__ import annotations

import uuid
from typing import Any, Optional
from fastapi import APIRouter, HTTPException, Query, Request
from auth_utils import get_current_user
import store

router = APIRouter(tags=["team"])


# ==========================================
# Time Off & Cover Requests
# ==========================================
@router.get("/api/time-off")
def get_time_off(request: Request, month: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    items = st.get("time_off", [])
    if org_id:
        return [t for t in items if t.get("org_id") == org_id]
    return items


@router.post("/api/time-off")
def post_time_off(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    tid = str(uuid.uuid4())
    rep = st["users_by_id"].get(body.get("rep_id", ""), u)
    cover = st["users_by_id"].get(body.get("cover_rep_id", ""), {})

    entry = {
        "id": tid,
        "org_id": u.get("org_id"),
        "rep_id": rep["id"],
        "rep_name": rep["name"],
        "start": body.get("start", store.today_str()),
        "end": body.get("end", store.today_str()),
        "cover_rep_id": cover.get("id", ""),
        "cover_rep_name": cover.get("name", ""),
        "note": body.get("note", ""),
        "created_by": u.get("name", "Manager"),
        "handed_off": False,
        "moved": 0,
        "gap_days": [],
    }
    st.setdefault("time_off", []).append(entry)
    store.save_state()
    return entry


@router.delete("/api/time-off/{tid}")
def delete_time_off(tid: str) -> dict[str, Any]:
    st = store.get_state()
    st["time_off"] = [t for t in st.get("time_off", []) if t.get("id") != tid]
    store.save_state()
    return {"ok": True}


@router.post("/api/time-off/{tid}/briefing-preview")
def post_time_off_briefing_preview(tid: str) -> dict[str, Any]:
    return {"ok": True}


@router.get("/api/time-off/away")
def get_time_off_away() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("time_off_away", [])


@router.get("/api/time-off/gaps")
def get_time_off_gaps(month: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    return []


@router.get("/api/cover-requests")
def get_cover_requests(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    items = st.get("cover_requests", [])
    if org_id:
        return [r for r in items if r.get("org_id") == org_id]
    return items


@router.post("/api/cover-requests")
def post_cover_request(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    cid = str(uuid.uuid4())
    to_u = st["users_by_id"].get(body.get("to_rep_id", ""), {})

    cr = {
        "id": cid,
        "org_id": u.get("org_id"),
        "from_rep_id": u["id"],
        "from_rep_name": u["name"],
        "to_rep_id": to_u.get("id", ""),
        "to_rep_name": to_u.get("name", "Teammate"),
        "start": body.get("start", store.today_str()),
        "end": body.get("end", body.get("start", store.today_str())),
        "note": body.get("note", ""),
        "status": "pending",
        "approved_by": "",
        "block_reason": "",
        "time_off_id": "",
        "texted": False,
        "created_at": store.now_iso(),
    }
    st.setdefault("cover_requests", []).insert(0, cr)
    store.save_state()
    return cr


@router.delete("/api/cover-requests/{cid}")
def delete_cover_request(cid: str) -> dict[str, Any]:
    st = store.get_state()
    st["cover_requests"] = [r for r in st.get("cover_requests", []) if r.get("id") != cid]
    store.save_state()
    return {"ok": True}


@router.post("/api/cover-requests/{cid}/accept")
def post_cover_request_accept(cid: str) -> dict[str, Any]:
    st = store.get_state()
    for r in st.get("cover_requests", []):
        if r.get("id") == cid:
            r["status"] = "accepted"
            store.save_state()
            return r
    raise HTTPException(status_code=404, detail="Cover request not found")


@router.post("/api/cover-requests/{cid}/decline")
def post_cover_request_decline(cid: str) -> dict[str, Any]:
    st = store.get_state()
    for r in st.get("cover_requests", []):
        if r.get("id") == cid:
            r["status"] = "declined"
            store.save_state()
            return r
    raise HTTPException(status_code=404, detail="Cover request not found")


@router.post("/api/cover-requests/{cid}/approve")
def post_cover_request_approve(cid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for r in st.get("cover_requests", []):
        if r.get("id") == cid:
            r["status"] = "approved"
            r["approved_by"] = u.get("name", "Manager")
            store.save_state()
            return r
    raise HTTPException(status_code=404, detail="Cover request not found")


@router.post("/api/cover-requests/{cid}/block")
def post_cover_request_block(cid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for r in st.get("cover_requests", []):
        if r.get("id") == cid:
            r["status"] = "blocked"
            r["block_reason"] = body.get("reason", "Scheduling conflict")
            r["approved_by"] = u.get("name", "Manager")
            store.save_state()
            return r
    raise HTTPException(status_code=404, detail="Cover request not found")
