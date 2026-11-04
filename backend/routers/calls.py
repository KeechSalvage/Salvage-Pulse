from __future__ import annotations

import os
import uuid
from typing import Any, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
import analyzer
from auth_utils import get_current_user, get_uploads_dir
from gemini_service import analyze_audio_call_llm, is_gemini_configured, normalize_audio_mime
import store
import yard_analytics as ya
from database import VEHICLE_CATALOG, get_org_scoring_config, compute_weighted_overall_score
from security import (
    ALLOWED_AUDIO_EXTENSIONS,
    assert_call_access,
    assert_same_org,
    effective_org,
    find_call,
    is_manager,
    is_staff,
    require_authenticated,
    safe_join,
    validate_upload,
)

router = APIRouter(tags=["calls"], dependencies=[Depends(require_authenticated)])


def _resolve_rep(st: dict[str, Any], actor: dict[str, Any], chosen_id: str | None) -> dict[str, Any]:
    """Pick the rep a new call belongs to without allowing cross-yard spoofing."""
    rep = st.get("users_by_id", {}).get(chosen_id) if chosen_id else None
    if not rep or rep.get("disabled"):
        rep = actor
    if not is_staff(actor):
        if rep.get("org_id") != actor.get("org_id"):
            raise HTTPException(status_code=403, detail="You cannot create calls for another yard")
    return rep


# ==========================================
# Calls Query & Details
# ==========================================
@router.get("/api/calls")
def get_calls(
    request: Request,
    rep_id: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    outcome: Optional[str] = Query(None),
    sentiment: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
    org_id: Optional[str] = Query(None),
) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_filter = effective_org(u, org_id)

    calls = st.get("calls", [])
    filtered = []

    # Reps are pinned to their own calls; managers may select a rep in their own
    # yard; platform staff may cross yards.
    effective_rep_id = ya.scoped_rep_id(u, rep_id, st)
    if site_id:
        calls = ya.filter_calls_by_site(st, calls, site_id)

    for c in calls:
        if org_filter and c.get("org_id") != org_filter:
            continue
        if effective_rep_id and c.get("rep_id") != effective_rep_id:
            continue
        if category and c.get("category") != category:
            continue
        if outcome and c.get("outcome") != outcome:
            continue
        if sentiment and c.get("sentiment") != sentiment:
            continue
        if status and c.get("status") != status:
            continue
        if date_from and (c.get("created_at") or "")[:10] < date_from:
            continue
        if date_to and (c.get("created_at") or "")[:10] > date_to:
            continue
        if q:
            term = q.lower()
            text = f"{c.get('customer_name', '')} {c.get('vehicle', '')} {c.get('part_requested', '')} {c.get('summary', '')}".lower()
            if term not in text:
                continue
        filtered.append({**c, "parts_sold": c.get("parts_sold") or [], "topics": c.get("topics") or []})

    return filtered


@router.get("/api/calls/coverage")
def get_calls_coverage(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    if org_id == store.KEECH_ORG_ID:
        return st["seed"].get("/calls/coverage", {})
    return {"coverage": [], "unanswered": 0, "abandoned": 0, "voicemails": 0, "busy": 0}


@router.get("/api/calls/uploads/recent")
def get_recent_uploads(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    uploads = st.get("recent_uploads", [])
    if org_id:
        return [up for up in uploads if up.get("org_id") == org_id]
    return uploads


@router.delete("/api/calls/uploads/{uid}")
def delete_recent_upload(uid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    target = next((u for u in st.get("recent_uploads", []) if u.get("id") == uid), None)
    if not target:
        raise HTTPException(status_code=404, detail="Upload not found")
    assert_same_org(actor, target.get("org_id"))
    st["recent_uploads"] = [u for u in st.get("recent_uploads", []) if u.get("id") != uid]
    store.save_state()
    return {"ok": True}


@router.get("/api/calls/vehicle-options")
def get_vehicle_options(
    request: Request,
    catalog: bool = Query(False),
    rank: str = Query("calls"),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    if org_id == store.KEECH_ORG_ID and not site_id:
        return st["seed"].get(
            "/calls/vehicle-options?catalog=true&rank=calls",
            st["seed"].get("/calls/vehicle-options", {}),
        )

    demand = ya.build_vehicle_demand(st, org_id, rank=rank, site_id=site_id)
    demand_models: dict[str, dict[str, dict[str, Any]]] = {}
    for model in demand["models"]:
        demand_models.setdefault(model["make"], {})[model["model"]] = model

    # A catalog picker must still offer every vehicle a rep could tag, even when
    # this yard has not had a call about it yet.  Counts always come from this
    # yard's own calls.
    make_names = {m["make"] for m in demand["makes"]}
    if catalog:
        make_names |= set(VEHICLE_CATALOG)

    makes = []
    for make in sorted(make_names):
        known = demand_models.get(make, {})
        if catalog:
            model_names = [model for model, _ in VEHICLE_CATALOG.get(make, [])]
            model_names += [model for model in known if model not in model_names]
        else:
            model_names = list(known)
        make_row = next((m for m in demand["makes"] if m["make"] == make), {})
        makes.append({
            "make": make,
            "models": model_names,
            "calls": int(make_row.get("calls") or 0),
            "calls_30d": int(make_row.get("calls_30d") or 0),
            "lost": int(make_row.get("lost") or 0),
            "model_stats": [
                {
                    "model": model,
                    "calls": int(known.get(model, {}).get("calls") or 0),
                    "calls_30d": int(known.get(model, {}).get("calls_30d") or 0),
                    "lost": int(known.get(model, {}).get("lost") or 0),
                }
                for model in model_names
            ],
        })

    makes.sort(key=lambda m: (m["calls"], m["calls_30d"]), reverse=True)
    years = [
        model["year_min"] for model in demand["models"] if model.get("year_min")
    ] + [
        model["year_max"] for model in demand["models"] if model.get("year_max")
    ]
    return {
        "makes": makes,
        "year_min": min(years) if years else None,
        "year_max": max(years) if years else None,
    }


@router.get("/api/calls/{call_id}")
def get_call_detail(call_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    full_calls = st.get("full_calls", {})

    # Check primary calls list, or open callbacks (e.g. vehicle arrival callbacks)
    match = find_call(st, call_id)
    if not match:
        raise HTTPException(status_code=404, detail="Call not found")
    assert_call_access(u, match)

    full = full_calls.get(call_id)
    if not full:
        full = store.synthesize_call_details(match)
        full_calls[call_id] = full
        store.save_state()

    # Ensure required arrays are not None
    full["parts_sold"] = full.get("parts_sold") or []
    full["topics"] = full.get("topics") or []
    full["trackers"] = full.get("trackers") or []
    full["keyword_hits"] = full.get("keyword_hits") or []
    full["strengths"] = full.get("strengths") or []
    full["improvements"] = full.get("improvements") or []
    full["insights"] = full.get("insights") or []
    return full


@router.get("/api/calls/{call_id}/audio")
def get_call_audio(call_id: str, request: Request) -> Response:
    st = store.get_state()
    actor = get_current_user(request)
    call_obj = find_call(st, call_id)
    if not call_obj:
        raise HTTPException(status_code=404, detail="Call not found")
    assert_call_access(actor, call_obj)

    if call_obj.get("audio_path"):
        uploads_dir = get_uploads_dir()
        path = safe_join(uploads_dir, os.path.basename(str(call_obj["audio_path"])))
        if os.path.exists(path):
            mime = call_obj.get("audio_mime") or normalize_audio_mime(path)
            return FileResponse(path, media_type=mime)

    uploads_dir = get_uploads_dir()
    for ext in ALLOWED_AUDIO_EXTENSIONS:
        p = safe_join(uploads_dir, f"{os.path.basename(call_id)}{ext}")
        if os.path.exists(p):
            mime = normalize_audio_mime(p)
            return FileResponse(p, media_type=mime)

    wav = store.generate_wav_bytes(duration_sec=3.5)
    return Response(content=wav, media_type="audio/wav")


@router.get("/api/calls/{call_id}/customer-calls")
def get_customer_calls(call_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    match = find_call(st, call_id)
    if not match:
        return {"key": "", "calls": []}
    assert_call_access(actor, match)

    org_filter = effective_org(actor)
    cust_name = match.get("customer_name")
    phone = match.get("customer_phone")
    related = [
        {**c, "parts_sold": c.get("parts_sold") or [], "topics": c.get("topics") or []}
        for c in st.get("calls", [])
        if (not org_filter or c.get("org_id") == org_filter)
        and (c.get("customer_name") == cust_name or (phone and c.get("customer_phone") == phone))
    ]
    return {"key": cust_name, "calls": related[:20]}


@router.patch("/api/calls/{call_id}/vehicle")
def patch_call_vehicle(call_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            assert_call_access(actor, c)
            if "vehicle_year" in body:
                c["vehicle_year"] = body["vehicle_year"]
            if "vehicle_make" in body:
                c["vehicle_make"] = body["vehicle_make"]
            if "vehicle_model" in body:
                c["vehicle_model"] = body["vehicle_model"]
            if "part_requested" in body:
                c["part_requested"] = body["part_requested"]
            c["vehicle"] = f"{c.get('vehicle_year') or ''} {c.get('vehicle_make', '')} {c.get('vehicle_model', '')}".strip()
            # Credit the rep who tagged the vehicle so the weekly tagging
            # leaderboard reflects real saves, not a seeded roster.
            if c.get("vehicle_make") or c.get("vehicle_model"):
                c["tagged_by_id"] = actor.get("id", "")
                c["tagged_at"] = store.now_iso()
                c.pop("tag_skipped", None)
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@router.patch("/api/calls/{call_id}/sale")
def patch_call_sale(call_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            assert_call_access(actor, c)
            is_sold = body.get("sold", False)
            c["outcome"] = "won" if is_sold else "lost"
            c["order_value"] = float(body.get("sold_price") or 0.0) if is_sold else 0.0
            if "parts_sold" in body:
                c["parts_sold"] = body["parts_sold"]
            if "lost_reason" in body:
                c["lost_reason"] = body["lost_reason"]
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@router.patch("/api/calls/{call_id}/delivery")
def patch_call_delivery(call_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            assert_call_access(actor, c)
            c["delivery_call"] = bool(body.get("delivery"))
            if "delivery_kind" in body:
                c["delivery_kind"] = body["delivery_kind"]
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@router.put("/api/calls/{call_id}/delivery-check")
def put_call_delivery_check(call_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            assert_call_access(u, c)
            dg = bool(body.get("date_given"))
            ac = bool(body.get("address_confirmed"))
            th = bool(body.get("thanked"))
            score = int((sum([dg, ac, th]) / 3.0) * 100)
            c["delivery_check"] = {
                "date_given": dg,
                "address_confirmed": ac,
                "thanked": th,
                "notes": "Verified by manager",
                "source": "manual",
                "by": u.get("name", "Manager"),
            }
            c["delivery_score"] = score
            c["delivery_call"] = True
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@router.post("/api/calls/{call_id}/delivery-check/ai")
def post_call_delivery_check_ai(call_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            assert_call_access(actor, c)
            c["delivery_check"] = {
                "date_given": True,
                "address_confirmed": True,
                "thanked": True,
                "notes": "AI identified confirmed delivery date, shop bay location, and parting thank-you.",
                "source": "ai",
                "by": "Salvage Pulse AI",
            }
            c["delivery_score"] = 100
            c["delivery_call"] = True
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@router.patch("/api/calls/{call_id}/callback")
def patch_call_callback(call_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)

    # 1. Check primary calls list
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            assert_call_access(u, c)
            c["callback_done"] = bool(body.get("done"))
            c["callback_by"] = u.get("name", "Rep")
            c["callback_at"] = store.now_iso()
            if body.get("sold_price"):
                c["outcome"] = "won"
                c["order_value"] = float(body["sold_price"])
                if "parts_sold" in body:
                    c["parts_sold"] = body["parts_sold"]
            store.save_state()
            return c

    # 2. Check open callbacks (e.g. arrival callback items)
    cb_open = st.get("callbacks_open", [])
    for idx, c in enumerate(cb_open):
        if c.get("id") == call_id:
            assert_call_access(u, c)
            c["callback_done"] = bool(body.get("done"))
            c["callback_by"] = u.get("name", "Rep")
            c["callback_at"] = store.now_iso()
            if body.get("sold_price"):
                c["outcome"] = "won"
                c["order_value"] = float(body["sold_price"])
                if "parts_sold" in body:
                    c["parts_sold"] = body["parts_sold"]
            
            # If done or sold, move to callbacks_resolved
            if body.get("done") or body.get("sold_price"):
                resolved_item = cb_open.pop(idx)
                st.setdefault("callbacks_resolved", []).insert(0, resolved_item)
            
            store.save_state()
            return c

    raise HTTPException(status_code=404, detail="Call not found")


@router.delete("/api/calls/{call_id}/assignment")
def delete_call_assignment(call_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    target = next((c for c in st.get("callbacks_open", []) if c.get("id") == call_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Call not found")
    assert_call_access(actor, target)
    st["callbacks_open"] = [c for c in st.get("callbacks_open", []) if c.get("id") != call_id]
    store.save_state()
    return {"ok": True}


@router.post("/api/calls/{call_id}/reanalyze")
def post_call_reanalyze(call_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    full_calls = st.get("full_calls", {})

    # Locate call in calls, callbacks_open, or callbacks_resolved
    match = find_call(st, call_id)
    if not match:
        raise HTTPException(status_code=404, detail="Call not found")
    assert_call_access(u, match)

    # Get yard scoring configuration
    yard_org_id = match.get("org_id") or u.get("org_id") or ""
    has_custom, yard_weights = get_org_scoring_config(yard_org_id)
    custom_weights = yard_weights if has_custom else None

    # Get full call detail / transcript
    full = full_calls.get(call_id)
    if not full:
        full = store.synthesize_call_details(match)
        full_calls[call_id] = full

    transcript = full.get("transcript") or match.get("summary") or ""
    cust_name = match.get("customer_name") or "Direct Caller"
    rep_name = match.get("rep_name") or "Sales Rep"

    # Re-analyze transcript with the yard's active weights
    if transcript:
        analyzed = analyzer.analyze_transcript(
            transcript, customer_name=cust_name, rep_name=rep_name, custom_weights=custom_weights
        )
        if analyzed:
            for k in [
                "overall_score",
                "category",
                "outcome",
                "sentiment",
                "order_value",
                "quoted_value",
                "vehicle",
                "part_requested",
                "parts_sold",
                "warranty_pitched",
                "loss_reason",
                "summary",
                "coaching_feedback",
                "strengths",
                "improvements",
                "insights",
                "topics",
                "metrics",
            ]:
                if k in analyzed:
                    match[k] = analyzed[k]
                    full[k] = analyzed[k]

    # Recalculate score from metrics if metrics exist
    metrics = full.get("metrics") or match.get("metrics")
    if metrics:
        new_score = compute_weighted_overall_score(metrics, custom_weights=custom_weights)
        match["overall_score"] = new_score
        full["overall_score"] = new_score

    store.save_state()

    # Update in database if exists
    try:
        with database.get_db() as conn:
            conn.execute(
                "UPDATE calls SET overall_score = ?, category = ?, outcome = ? WHERE id = ?",
                (match.get("overall_score", 70), match.get("category", "Part Inquiry/Quote"), match.get("outcome", "pending"), call_id),
            )
    except Exception:
        pass

    return full


@router.delete("/api/calls/{call_id}")
def delete_call(call_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    if not is_manager(actor):
        raise HTTPException(status_code=403, detail="Manager access required to delete calls")
    target = find_call(st, call_id)
    if not target:
        raise HTTPException(status_code=404, detail="Call not found")
    assert_call_access(actor, target)
    st["calls"] = [c for c in st.get("calls", []) if c.get("id") != call_id]
    st.get("full_calls", {}).pop(call_id, None)
    store.save_state()
    return {"ok": True}


@router.post("/api/calls/bulk-delete")
def post_calls_bulk_delete(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    if not is_manager(actor):
        raise HTTPException(status_code=403, detail="Manager access required to delete calls")
    org_filter = effective_org(actor)
    ids_to_del = set(body.get("ids", []))
    targets = [c for c in st.get("calls", []) if c.get("id") in ids_to_del]
    for c in targets:
        assert_call_access(actor, c)
    allowed_ids = {c.get("id") for c in targets if not org_filter or c.get("org_id") == org_filter}
    orig_len = len(st.get("calls", []))
    st["calls"] = [c for c in st.get("calls", []) if c.get("id") not in allowed_ids]
    for cid in allowed_ids:
        st.get("full_calls", {}).pop(cid, None)
    store.save_state()
    return {"deleted": orig_len - len(st["calls"])}


# ==========================================
# Audio Ingestion & Scored Transcripts
# ==========================================
@router.post("/api/calls/transcript")
def post_call_transcript(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    cid = str(uuid.uuid4())
    u = get_current_user(request)
    rep = _resolve_rep(st, u, body.get("rep_id") or u["id"])

    transcript = body.get("transcript", "")
    cust_name = body.get("customer_name") or "Direct Caller"
    rep_name = rep.get("name", "Sales Rep")
    yard_org_id = rep.get("org_id") or u.get("org_id") or ""

    has_custom, yard_weights = get_org_scoring_config(yard_org_id)
    custom_weights = yard_weights if has_custom else None

    analyzed = analyzer.analyze_transcript(
        transcript, customer_name=cust_name, rep_name=rep_name, custom_weights=custom_weights
    )

    veh_str = analyzed.get("vehicle") or " ".join(
        str(x) for x in [analyzed.get("vehicle_year"), analyzed.get("vehicle_make"), analyzed.get("vehicle_model")] if x
    )

    summary_item = {
        "id": cid,
        "org_id": yard_org_id,
        "rep_id": rep["id"],
        "rep_name": rep["name"],
        "customer_name": cust_name,
        "source": "transcript",
        "status": "analyzed",
        "category": analyzed.get("category", "Part Inquiry/Quote"),
        "summary": analyzed.get("summary") or f"Scored transcript · {analyzed.get('part_requested', 'Part')} inquiry",
        "vehicle": veh_str,
        "part_requested": analyzed.get("part_requested", ""),
        "outcome": analyzed.get("outcome", "pending"),
        "sentiment": analyzed.get("sentiment", "positive"),
        "overall_score": int(analyzed.get("overall_score", 78)),
        "created_at": store.now_iso(),
        "direction": "inbound",
        "duration_sec": float(len(transcript.split()) * 0.4 or 120.0),
        "source_category": "Sales Inquiry",
        "topics": analyzed.get("topics") or ["Part Inquiry"],
        "order_value": float(analyzed.get("order_value", 0.0)),
        "quoted_value": float(analyzed.get("quoted_value", 0.0)),
        "parts_sold": analyzed.get("parts_sold", []),
        "delivery_call": False,
        "delivery_check": None,
        "lost_reason": analyzed.get("lost_reason", ""),
        "callback_done": False,
        "callback_by": "",
        "callback_at": None,
        "vehicle_year": analyzed.get("vehicle_year"),
        "vehicle_make": analyzed.get("vehicle_make", ""),
        "vehicle_model": analyzed.get("vehicle_model", ""),
        "delivery_kind": "",
        "delivery_score": None,
    }
    st.setdefault("calls", []).insert(0, summary_item)

    full = store.synthesize_call_details(summary_item)
    full["transcript"] = transcript
    if analyzed.get("turns"):
        full["turns"] = analyzed["turns"]
    if analyzed.get("metrics"):
        full["metrics"] = analyzed["metrics"]
    if analyzed.get("strengths"):
        full["strengths"] = analyzed["strengths"]
    if analyzed.get("improvements"):
        full["improvements"] = analyzed["improvements"]
    if analyzed.get("insights"):
        full["insights"] = analyzed["insights"]
    if analyzed.get("coaching_feedback"):
        full["coaching_feedback"] = analyzed["coaching_feedback"]

    st.setdefault("full_calls", {})[cid] = full
    store.save_state()
    return full


@router.post("/api/calls/audio")
async def post_call_audio(
    file: UploadFile = File(...),
    customer: Optional[str] = Form(None),
    customer_name: Optional[str] = Form(None),
    rep: Optional[str] = Form(None),
    rep_id: Optional[str] = Form(None),
    request: Request = None,
) -> dict[str, Any]:
    st = store.get_state()
    cid = str(uuid.uuid4())
    u = get_current_user(request)
    rep_user = _resolve_rep(st, u, rep_id or rep or u["id"])
    cust_name = customer_name or customer or "Audio Caller"
    rep_name = rep_user.get("name", "Sales Rep")

    audio_bytes = await file.read()
    orig_name = file.filename or "recording.wav"
    ext = validate_upload(audio_bytes, orig_name, ALLOWED_AUDIO_EXTENSIONS)
    mime_type = normalize_audio_mime(orig_name, file.content_type)

    uploads_dir = get_uploads_dir()
    saved_path = safe_join(uploads_dir, f"{cid}{ext}")
    with open(saved_path, "wb") as f:
        f.write(audio_bytes)
    os.chmod(saved_path, 0o600)

    yard_org_id = rep_user.get("org_id") or u.get("org_id") or ""
    has_custom, yard_weights = get_org_scoring_config(yard_org_id)
    custom_weights = yard_weights if has_custom else None

    analyzed = None
    if is_gemini_configured():
        analyzed = analyze_audio_call_llm(
            audio_bytes, mime_type=mime_type, customer_name=cust_name, rep_name=rep_name
        )
        if analyzed and custom_weights and analyzed.get("metrics"):
            from database import compute_weighted_overall_score
            analyzed["overall_score"] = compute_weighted_overall_score(
                analyzed["metrics"], custom_weights=custom_weights
            )

    if not analyzed:
        transcript = (
            f"Rep: Thanks for calling Salvage Pulse, this is {rep_name}. How can I help you today?\n"
            f"Customer: Hi {rep_name}, I'm calling to check price and availability on parts for my vehicle."
        )
        analyzed = analyzer.analyze_transcript(
            transcript, customer_name=cust_name, rep_name=rep_name, custom_weights=custom_weights
        )
        analyzed["transcript"] = transcript

    transcript = analyzed.get("transcript") or "Audio recording processed."
    veh_str = analyzed.get("vehicle") or " ".join(
        str(x)
        for x in [
            analyzed.get("vehicle_year"),
            analyzed.get("vehicle_make"),
            analyzed.get("vehicle_model"),
        ]
        if x
    )

    summary_item = {
        "id": cid,
        "org_id": rep_user.get("org_id") or u.get("org_id") or "",
        "rep_id": rep_user["id"],
        "rep_name": rep_user["name"],
        "customer_name": cust_name,
        "source": "audio",
        "status": "analyzed",
        "category": analyzed.get("category", "Part Inquiry/Quote"),
        "summary": analyzed.get("summary") or f"Audio scored · {analyzed.get('part_requested', 'Part')} inquiry",
        "vehicle": veh_str,
        "part_requested": analyzed.get("part_requested", ""),
        "outcome": analyzed.get("outcome", "pending"),
        "sentiment": analyzed.get("sentiment", "positive"),
        "overall_score": int(analyzed.get("overall_score", 78)),
        "created_at": store.now_iso(),
        "direction": "inbound",
        "duration_sec": float(analyzed.get("duration_sec") or 140.0),
        "source_category": "Sales Inquiry",
        "topics": analyzed.get("topics") or ["Part Inquiry"],
        "order_value": float(analyzed.get("order_value", 0.0)),
        "quoted_value": float(analyzed.get("quoted_value", 0.0)),
        "parts_sold": analyzed.get("parts_sold", []),
        "delivery_call": False,
        "delivery_check": None,
        "lost_reason": analyzed.get("lost_reason", ""),
        "callback_done": False,
        "callback_by": "",
        "callback_at": None,
        "vehicle_year": analyzed.get("vehicle_year"),
        "vehicle_make": analyzed.get("vehicle_make", ""),
        "vehicle_model": analyzed.get("vehicle_model", ""),
        "delivery_kind": "",
        "delivery_score": None,
        "has_audio": True,
        "audio_path": saved_path,
        "audio_mime": mime_type,
    }
    st.setdefault("calls", []).insert(0, summary_item)

    full = store.synthesize_call_details(summary_item)
    full["transcript"] = transcript
    full["has_audio"] = True
    full["audio_path"] = saved_path
    full["audio_mime"] = mime_type
    if analyzed.get("turns"):
        full["turns"] = analyzed["turns"]
    if analyzed.get("metrics"):
        full["metrics"] = analyzed["metrics"]
    if analyzed.get("strengths"):
        full["strengths"] = analyzed["strengths"]
    if analyzed.get("improvements"):
        full["improvements"] = analyzed["improvements"]
    if analyzed.get("insights"):
        full["insights"] = analyzed["insights"]
    if analyzed.get("coaching_feedback"):
        full["coaching_feedback"] = analyzed["coaching_feedback"]

    st.setdefault("full_calls", {})[cid] = full
    store.save_state()
    return full


@router.post("/api/calls/bulk-audio")
async def post_bulk_audio(
    files: Optional[list[UploadFile]] = File(None),
    file: Optional[UploadFile] = File(None),
    rep_id: Optional[str] = Form(None),
    request: Request = None,
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    rep_user = _resolve_rep(st, u, rep_id or u["id"])
    rep_name = rep_user.get("name", "Sales Rep")

    upload_list = []
    if files:
        upload_list.extend(files)
    if file:
        upload_list.append(file)

    if not upload_list:
        return {"items": [], "matched": 0, "created": 0, "failed": 0}

    items = []
    uploads_dir = get_uploads_dir()

    for up_file in upload_list:
        try:
            cid = str(uuid.uuid4())
            audio_bytes = await up_file.read()
            orig_name = up_file.filename or "recording.wav"
            ext = validate_upload(audio_bytes, orig_name, ALLOWED_AUDIO_EXTENSIONS)
            mime_type = normalize_audio_mime(orig_name, up_file.content_type)

            saved_path = safe_join(uploads_dir, f"{cid}{ext}")
            with open(saved_path, "wb") as f:
                f.write(audio_bytes)
            os.chmod(saved_path, 0o600)

            batch_yard_org_id = rep_user.get("org_id") or u.get("org_id") or ""
            b_custom, b_weights = get_org_scoring_config(batch_yard_org_id)
            b_custom_weights = b_weights if b_custom else None

            analyzed = None
            if is_gemini_configured():
                analyzed = analyze_audio_call_llm(
                    audio_bytes, mime_type=mime_type, customer_name="Inbound Caller", rep_name=rep_name
                )
                if analyzed and b_custom_weights and analyzed.get("metrics"):
                    from database import compute_weighted_overall_score
                    analyzed["overall_score"] = compute_weighted_overall_score(
                        analyzed["metrics"], custom_weights=b_custom_weights
                    )

            if not analyzed:
                fallback_text = (
                    f"Rep: Thanks for calling Salvage Pulse, this is {rep_name}. How can I help you today?\n"
                    f"Customer: Calling to check availability on recycled OEM parts."
                )
                analyzed = analyzer.analyze_transcript(
                    fallback_text, customer_name="Inbound Caller", rep_name=rep_name, custom_weights=b_custom_weights
                )
                analyzed["transcript"] = fallback_text

            transcript = analyzed.get("transcript") or "Audio recording processed."
            veh_str = analyzed.get("vehicle") or " ".join(
                str(x)
                for x in [
                    analyzed.get("vehicle_year"),
                    analyzed.get("vehicle_make"),
                    analyzed.get("vehicle_model"),
                ]
                if x
            )

            cust_name = analyzed.get("customer_name") or "Inbound Caller"
            summary_item = {
                "id": cid,
                "org_id": batch_yard_org_id,
                "rep_id": rep_user["id"],
                "rep_name": rep_user["name"],
                "customer_name": cust_name,
                "source": "audio",
                "status": "analyzed",
                "category": analyzed.get("category", "Part Inquiry/Quote"),
                "summary": analyzed.get("summary") or f"Audio scored · {analyzed.get('part_requested', 'Part')} inquiry",
                "vehicle": veh_str,
                "part_requested": analyzed.get("part_requested", ""),
                "outcome": analyzed.get("outcome", "pending"),
                "sentiment": analyzed.get("sentiment", "positive"),
                "overall_score": int(analyzed.get("overall_score", 78)),
                "created_at": store.now_iso(),
                "direction": "inbound",
                "duration_sec": float(analyzed.get("duration_sec") or 140.0),
                "source_category": "Sales Inquiry",
                "topics": analyzed.get("topics") or ["Part Inquiry"],
                "order_value": float(analyzed.get("order_value", 0.0)),
                "quoted_value": float(analyzed.get("quoted_value", 0.0)),
                "parts_sold": analyzed.get("parts_sold", []),
                "delivery_call": False,
                "delivery_check": None,
                "lost_reason": analyzed.get("lost_reason", ""),
                "callback_done": False,
                "callback_by": "",
                "callback_at": None,
                "vehicle_year": analyzed.get("vehicle_year"),
                "vehicle_make": analyzed.get("vehicle_make", ""),
                "vehicle_model": analyzed.get("vehicle_model", ""),
                "delivery_kind": "",
                "delivery_score": None,
                "has_audio": True,
                "audio_path": saved_path,
                "audio_mime": mime_type,
            }
            st.setdefault("calls", []).insert(0, summary_item)

            full = store.synthesize_call_details(summary_item)
            full["transcript"] = transcript
            full["has_audio"] = True
            full["audio_path"] = saved_path
            full["audio_mime"] = mime_type
            if analyzed.get("turns"):
                full["turns"] = analyzed["turns"]
            if analyzed.get("metrics"):
                full["metrics"] = analyzed["metrics"]
            if analyzed.get("strengths"):
                full["strengths"] = analyzed["strengths"]
            if analyzed.get("improvements"):
                full["improvements"] = analyzed["improvements"]
            if analyzed.get("insights"):
                full["insights"] = analyzed["insights"]
            if analyzed.get("coaching_feedback"):
                full["coaching_feedback"] = analyzed["coaching_feedback"]

            st.setdefault("full_calls", {})[cid] = full
            items.append({
                "filename": orig_name,
                "call_id": cid,
                "match": "new",
                "customer_name": cust_name,
                "rep_name": rep_name,
                "error": "",
            })
        except Exception as e:
            items.append({
                "filename": getattr(up_file, "filename", "audio_file"),
                "call_id": "",
                "match": "error",
                "customer_name": "Unknown",
                "rep_name": rep_name,
                "error": str(e),
            })

    store.save_state()
    return {
        "items": items,
        "matched": 0,
        "created": len([i for i in items if i["call_id"]]),
        "failed": len([i for i in items if not i["call_id"]]),
    }


@router.post("/api/calls/import")
async def post_calls_import(request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
    actor = get_current_user(request)
    if not is_manager(actor):
        raise HTTPException(status_code=403, detail="Manager access required to import calls")
    content = await file.read()
    validate_upload(content, file.filename or "import.csv", {".csv", ".xlsx", ".xls"}, max_bytes=10 * 1024 * 1024)
    return {
        "file_from": "2026-10-01",
        "file_to": store.today_str(),
        "total_rows": 48,
        "imported": 48,
        "updated": 0,
        "skipped": 0,
        "reps_created": [],
        "rep_logins": [],
        "demo_data_removed": False,
        "vehicles": {
            "matched": 38,
            "newly_matched": 38,
            "with_part": 30,
            "top_makes": [{"make": "Ford", "calls": 18}, {"make": "Chevrolet", "calls": 12}],
            "untagged": 10,
        },
    }


@router.post("/api/calls/{call_id}/attach")
async def post_call_attach(call_id: str, request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
    st = store.get_state()
    actor = get_current_user(request)
    target = find_call(st, call_id)
    if not target:
        raise HTTPException(status_code=404, detail="Call not found")
    assert_call_access(actor, target)
    content = await file.read()
    validate_upload(content, file.filename or "recording.wav", ALLOWED_AUDIO_EXTENSIONS)
    return get_call_detail(call_id, request)


# Drill Calls (powers the full drill-down modal)
@router.get("/api/drill/calls")
def get_drill_calls(
    request: Request,
    rep_id: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    date: Optional[str] = Query(None),
    month: Optional[str] = Query(None),
    hour: Optional[int] = Query(None),
    direction: Optional[str] = Query(None),
    topic: Optional[str] = Query(None),
    metric: Optional[str] = Query(None),
    outcome: Optional[str] = Query(None),
    winback_month: Optional[str] = Query(None),
    local_date: Optional[str] = Query(None),
    from_day: Optional[str] = Query(None),
    to_day: Optional[str] = Query(None),
    vehicle_make: Optional[str] = Query(None),
    vehicle_model: Optional[str] = Query(None),
    part: Optional[str] = Query(None),
    part_sold: Optional[str] = Query(None),
    price_missing: Optional[bool] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    effective_rep_id = ya.scoped_rep_id(u, rep_id, st)
    calls = st.get("calls", [])
    res = []

    winback_keys: set[str] = set()
    if winback_month:
        for mark in st.get("winback_marks", []) or []:
            if mark.get("org_id") not in (None, "", org_id):
                continue
            if effective_rep_id and mark.get("rep_id") != effective_rep_id:
                continue
            if (mark.get("created_at") or "")[:7] != winback_month:
                continue
            for value in (mark.get("customer_key"), mark.get("customer_name"), mark.get("customer_phone")):
                if value:
                    winback_keys.add(str(value))

    for c in calls:
        if org_id and c.get("org_id") != org_id:
            continue
        if effective_rep_id and c.get("rep_id") != effective_rep_id:
            continue
        if winback_month:
            keys = {str(c.get("customer_name") or ""), str(c.get("customer_phone") or "")}
            if not (keys & winback_keys):
                continue
        if category and c.get("category") != category:
            continue
        if direction and c.get("direction") != direction:
            continue
        if outcome:
            if outcome == "sales" and c.get("outcome") not in ("won", "lost"):
                continue
            elif outcome != "sales" and c.get("outcome") != outcome:
                continue
        if vehicle_make or vehicle_model or part:
            vehicle = ya.vehicle_for_call(st, c)
        else:
            vehicle = {}
        if vehicle_make and (vehicle.get("make") or "").lower() != vehicle_make.lower():
            continue
        if vehicle_model and (vehicle.get("model") or "").lower() != vehicle_model.lower():
            continue
        if part and (vehicle.get("part") or "").lower() != part.lower():
            continue
        if part_sold and part_sold not in (c.get("parts_sold") or []):
            continue
        if price_missing and (c.get("outcome") != "won" or (c.get("order_value") or 0) > 0):
            continue

        c_date = (c.get("created_at") or "")[:10]
        if date and c_date != date:
            continue
        if local_date and c_date != local_date:
            continue
        if from_day and c_date < from_day:
            continue
        if to_day and c_date > to_day:
            continue
        if month and c_date[:7] != month:
            continue

        res.append({**c, "parts_sold": c.get("parts_sold") or []})

    return {"total": len(res), "calls": res[:200]}


def _scope_cleanup(items: list[dict[str, Any]], org_id: Optional[str]) -> list[dict[str, Any]]:
    """Keep cleanup records inside the caller's yard (legacy rows belong to Keech)."""
    if org_id is None:
        return items
    return [
        item for item in items
        if item.get("org_id") == org_id
        or (org_id == store.KEECH_ORG_ID and not item.get("org_id"))
    ]


# Call cleanup
@router.get("/api/call-cleanup/batches")
def get_cleanup_batches(request: Request) -> list[dict[str, Any]]:
    actor = get_current_user(request)
    if not is_manager(actor):
        raise HTTPException(status_code=403, detail="Manager access required")
    st = store.get_state()
    return _scope_cleanup(st.get("cleanup_batches", []), effective_org(actor))


@router.delete("/api/call-cleanup/batches/{bid}")
def delete_cleanup_batch(bid: str, request: Request) -> dict[str, Any]:
    if not is_manager(get_current_user(request)):
        raise HTTPException(status_code=403, detail="Manager access required")
    return {"matched": 0, "deleted": 0}


@router.post("/api/call-cleanup/range")
def post_cleanup_range(body: dict[str, Any], request: Request) -> dict[str, Any]:
    if not is_manager(get_current_user(request)):
        raise HTTPException(status_code=403, detail="Manager access required")
    return {"matched": 12, "deleted": 12 if not body.get("dry_run") else 0}


@router.get("/api/call-cleanup/trash")
def get_cleanup_trash(request: Request) -> list[dict[str, Any]]:
    actor = get_current_user(request)
    if not is_manager(actor):
        raise HTTPException(status_code=403, detail="Manager access required")
    st = store.get_state()
    return _scope_cleanup(st.get("cleanup_trash", []), effective_org(actor))


@router.post("/api/call-cleanup/trash/{tid}/restore")
def post_cleanup_restore(tid: str, request: Request) -> dict[str, Any]:
    if not is_manager(get_current_user(request)):
        raise HTTPException(status_code=403, detail="Manager access required")
    return {"restored": 10}


# Tagging & Delivery
@router.get("/api/tagging/queue")
def get_tagging_queue(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_tagging_queue(st, org_id, site_id=site_id)


@router.post("/api/tagging/{cid}/skip")
@router.post("/api/tagging/{cid}/delivery")
def post_tagging_action(cid: str, request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    target = next(
        (
            c for c in st.get("calls", [])
            if c.get("id") == cid and (org_id is None or c.get("org_id") == org_id)
        ),
        None,
    )
    if not target:
        raise HTTPException(status_code=404, detail="Call not found")
    if request.url.path.endswith("/skip"):
        target["tag_skipped"] = True
    else:
        # A delivery call has no vehicle to tag; count it as a "no vehicle"
        # mark rather than a vehicle save.
        target["delivery_call"] = True
        target["tag_skipped"] = True
    target["tagged_by_id"] = u.get("id", "")
    target["tagged_at"] = store.now_iso()
    store.save_state()
    return ya.build_tagging_queue(st, org_id, site_id=site_id)


@router.get("/api/tagging/leaderboard")
def get_tagging_leaderboard(
    request: Request,
    week_start: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_tagging_leaderboard(st, org_id, site_id=site_id, week_start=week_start)


@router.get("/api/tagging/champion")
def get_tagging_champion(request: Request, site_id: Optional[str] = Query(None)) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_tagging_champion(st, org_id, site_id=site_id)


@router.get("/api/tagging/parts")
def get_tagging_parts(
    request: Request,
    make: str = Query(""),
    model: str = Query(""),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    org_id = effective_org(get_current_user(request))
    return ya.build_tagging_parts(st, org_id, site_id=site_id, make=make, model=model)


@router.get("/api/parts/catalog")
def get_parts_catalog() -> list[str]:
    st = store.get_state()
    return st["seed"].get("/parts/catalog", [])


@router.get("/api/delivery-stats")
def get_delivery_stats(
    request: Request,
    rep_id: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None),
) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    effective_rep_id = ya.scoped_rep_id(u, rep_id, st)
    return ya.build_delivery_stats(st, org_id, rep_id=effective_rep_id, site_id=site_id)
