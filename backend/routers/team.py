from __future__ import annotations

import uuid
from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from auth_utils import get_current_user
import store
from security import assert_same_org, effective_org, is_manager, require_authenticated, resolve_write_org

router = APIRouter(tags=["team"], dependencies=[Depends(require_authenticated)])


def _find(st: dict[str, Any], bucket: str, item_id: str) -> dict[str, Any]:
    item = next((x for x in st.get(bucket, []) if x.get("id") == item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Request not found")
    return item


# ==========================================
# Time Off & Cover Requests
# ==========================================
@router.get("/api/time-off")
def get_time_off(request: Request, month: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    items = st.get("time_off", [])
    if org_id:
        return [t for t in items if t.get("org_id") == org_id]
    return items


@router.post("/api/time-off")
def post_time_off(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = resolve_write_org(u, body.get("org_id"))
    rep_id = str(body.get("rep_id") or u["id"])
    rep = st["users_by_id"].get(rep_id)
    if not rep:
        raise HTTPException(status_code=400, detail="Unknown team member")
    if not is_manager(u) and rep_id != u["id"]:
        raise HTTPException(status_code=403, detail="You can only request time off for yourself")
    assert_same_org(u, rep.get("org_id"))

    cover_id = str(body.get("cover_rep_id") or "")
    cover = st["users_by_id"].get(cover_id, {}) if cover_id else {}
    if cover_id and not cover:
        raise HTTPException(status_code=400, detail="Unknown cover team member")
    if cover:
        assert_same_org(u, cover.get("org_id"))

    entry = {
        "id": str(uuid.uuid4()),
        "org_id": org_id,
        "rep_id": rep["id"],
        "rep_name": rep["name"],
        "start": str(body.get("start") or store.today_str())[:32],
        "end": str(body.get("end") or store.today_str())[:32],
        "cover_rep_id": cover.get("id", ""),
        "cover_rep_name": cover.get("name", ""),
        "note": str(body.get("note") or "")[:500],
        "created_by": u.get("name", "Manager"),
        "handed_off": False,
        "moved": 0,
        "gap_days": [],
    }
    st.setdefault("time_off", []).append(entry)
    store.save_state()
    return entry


@router.delete("/api/time-off/{tid}")
def delete_time_off(tid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    entry = _find(st, "time_off", tid)
    assert_same_org(u, entry.get("org_id"))
    if not is_manager(u) and entry.get("rep_id") != u.get("id"):
        raise HTTPException(status_code=403, detail="You can only delete your own time off")
    st["time_off"] = [t for t in st.get("time_off", []) if t.get("id") != tid]
    store.save_state()
    return {"ok": True}


@router.post("/api/time-off/{tid}/briefing-preview")
def post_time_off_briefing_preview(tid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    entry = _find(st, "time_off", tid)
    assert_same_org(u, entry.get("org_id"))
    if not is_manager(u) and entry.get("rep_id") != u.get("id"):
        raise HTTPException(status_code=403, detail="Access denied")
    return {"ok": True}


@router.get("/api/time-off/away")
def get_time_off_away(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    items = st.get("time_off_away", [])
    if org_id:
        return [t for t in items if t.get("org_id") == org_id]
    return items


@router.get("/api/time-off/gaps")
def get_time_off_gaps(month: Optional[str] = Query(None)) -> list[dict[str, Any]]:
    return []


@router.get("/api/cover-requests")
def get_cover_requests(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    items = st.get("cover_requests", [])
    if org_id:
        return [r for r in items if r.get("org_id") == org_id]
    return items


@router.post("/api/cover-requests")
def post_cover_request(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = resolve_write_org(u, body.get("org_id"))
    to_id = str(body.get("to_rep_id") or "")
    to_u = st["users_by_id"].get(to_id)
    if to_id and not to_u:
        raise HTTPException(status_code=400, detail="Unknown team member")
    if to_u:
        assert_same_org(u, to_u.get("org_id"))

    cr = {
        "id": str(uuid.uuid4()),
        "org_id": org_id,
        "from_rep_id": u["id"],
        "from_rep_name": u["name"],
        "to_rep_id": to_u.get("id", "") if to_u else "",
        "to_rep_name": to_u.get("name", "Teammate") if to_u else "",
        "start": str(body.get("start") or store.today_str())[:32],
        "end": str(body.get("end") or body.get("start") or store.today_str())[:32],
        "note": str(body.get("note") or "")[:500],
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
def delete_cover_request(cid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    item = _find(st, "cover_requests", cid)
    assert_same_org(u, item.get("org_id"))
    if not is_manager(u) and item.get("from_rep_id") != u.get("id"):
        raise HTTPException(status_code=403, detail="You can only delete your own cover request")
    st["cover_requests"] = [r for r in st.get("cover_requests", []) if r.get("id") != cid]
    store.save_state()
    return {"ok": True}


@router.post("/api/cover-requests/{cid}/accept")
def post_cover_request_accept(cid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    item = _find(st, "cover_requests", cid)
    assert_same_org(u, item.get("org_id"))
    if not is_manager(u) and item.get("to_rep_id") != u.get("id"):
        raise HTTPException(status_code=403, detail="Only the requested team member can accept this")
    item["status"] = "accepted"
    store.save_state()
    return item


@router.post("/api/cover-requests/{cid}/decline")
def post_cover_request_decline(cid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    item = _find(st, "cover_requests", cid)
    assert_same_org(u, item.get("org_id"))
    if not is_manager(u) and item.get("to_rep_id") != u.get("id"):
        raise HTTPException(status_code=403, detail="Only the requested team member can decline this")
    item["status"] = "declined"
    store.save_state()
    return item


@router.post("/api/cover-requests/{cid}/approve")
def post_cover_request_approve(cid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    item = _find(st, "cover_requests", cid)
    assert_same_org(u, item.get("org_id"))
    item["status"] = "approved"
    item["approved_by"] = u.get("name", "Manager")
    store.save_state()
    return item


@router.post("/api/cover-requests/{cid}/block")
def post_cover_request_block(cid: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    if not is_manager(u):
        raise HTTPException(status_code=403, detail="Manager access required")
    item = _find(st, "cover_requests", cid)
    assert_same_org(u, item.get("org_id"))
    item["status"] = "blocked"
    item["block_reason"] = str(body.get("reason") or "Scheduling conflict")[:300]
    item["approved_by"] = u.get("name", "Manager")
    store.save_state()
    return item
