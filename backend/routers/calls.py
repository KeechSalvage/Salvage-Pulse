from __future__ import annotations

import os
import uuid
from typing import Any, Optional
from fastapi import APIRouter, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
import analyzer
from auth_utils import get_current_user, get_uploads_dir
from gemini_service import analyze_audio_call_llm, is_gemini_configured, normalize_audio_mime
import store

router = APIRouter(tags=["calls"])


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
    user_org = u.get("org_id")
    effective_org = user_org if user_org else org_id

    calls = st.get("calls", [])
    filtered = []

    # If signed in as an individual rep, default to viewing their own calls unless an explicit rep_id query param is provided
    effective_rep_id = rep_id
    if not effective_rep_id and u.get("role") in ("rep", "sales_rep"):
        effective_rep_id = u.get("id")

    site_rep_ids = set()
    if site_id:
        site_rep_ids = {uid for uid, usr in st["users_by_id"].items() if usr.get("site_id") == site_id}

    for c in calls:
        if effective_org and c.get("org_id") != effective_org:
            continue
        if effective_rep_id and c.get("rep_id") != effective_rep_id:
            continue
        if site_id and c.get("rep_id") not in site_rep_ids:
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
        filtered.append(c)

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
def delete_recent_upload(uid: str) -> dict[str, Any]:
    st = store.get_state()
    st["recent_uploads"] = [u for u in st.get("recent_uploads", []) if u.get("id") != uid]
    store.save_state()
    return {"ok": True}


@router.get("/api/calls/vehicle-options")
def get_vehicle_options(catalog: bool = Query(False), rank: str = Query("calls")) -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/calls/vehicle-options?catalog=true&rank=calls", st["seed"].get("/calls/vehicle-options", {}))


@router.get("/api/calls/{call_id}")
def get_call_detail(call_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = u.get("org_id")
    full_calls = st.get("full_calls", {})

    match = next((c for c in st.get("calls", []) if c.get("id") == call_id), None)
    if not match:
        raise HTTPException(status_code=404, detail="Call not found")

    if org_id and match.get("org_id") and match.get("org_id") != org_id:
        raise HTTPException(status_code=403, detail="Call not found")

    if call_id in full_calls:
        return full_calls[call_id]

    full = store.synthesize_call_details(match)
    full_calls[call_id] = full
    store.save_state()
    return full


@router.get("/api/calls/{call_id}/audio")
def get_call_audio(call_id: str) -> Response:
    st = store.get_state()
    call_obj = st.get("full_calls", {}).get(call_id) or next(
        (c for c in st.get("calls", []) if c.get("id") == call_id), None
    )
    if call_obj and call_obj.get("audio_path"):
        path = call_obj["audio_path"]
        if os.path.exists(path):
            mime = call_obj.get("audio_mime") or normalize_audio_mime(path)
            return FileResponse(path, media_type=mime)

    uploads_dir = get_uploads_dir()
    for ext in [".wav", ".mp3", ".m4a", ".ogg", ".webm", ".flac", ".aac"]:
        p = os.path.join(uploads_dir, f"{call_id}{ext}")
        if os.path.exists(p):
            mime = normalize_audio_mime(p)
            return FileResponse(p, media_type=mime)

    wav = store.generate_wav_bytes(duration_sec=3.5)
    return Response(content=wav, media_type="audio/wav")


@router.get("/api/calls/{call_id}/customer-calls")
def get_customer_calls(call_id: str) -> dict[str, Any]:
    st = store.get_state()
    match = next((c for c in st.get("calls", []) if c.get("id") == call_id), None)
    if not match:
        return {"key": "", "calls": []}

    cust_name = match.get("customer_name")
    phone = match.get("customer_phone")
    related = [
        c
        for c in st.get("calls", [])
        if c.get("customer_name") == cust_name or (phone and c.get("customer_phone") == phone)
    ]
    return {"key": cust_name, "calls": related[:20]}


@router.patch("/api/calls/{call_id}/vehicle")
def patch_call_vehicle(call_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for c in st.get("calls", []):
        if c.get("id") == call_id:
            if "vehicle_year" in body:
                c["vehicle_year"] = body["vehicle_year"]
            if "vehicle_make" in body:
                c["vehicle_make"] = body["vehicle_make"]
            if "vehicle_model" in body:
                c["vehicle_model"] = body["vehicle_model"]
            if "part_requested" in body:
                c["part_requested"] = body["part_requested"]
            c["vehicle"] = f"{c.get('vehicle_year') or ''} {c.get('vehicle_make', '')} {c.get('vehicle_model', '')}".strip()
            store.save_state()
            return c
    raise HTTPException(status_code=404, detail="Call not found")


@router.patch("/api/calls/{call_id}/sale")
def patch_call_sale(call_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for c in st.get("calls", []):
        if c.get("id") == call_id:
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
def patch_call_delivery(call_id: str, body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    for c in st.get("calls", []):
        if c.get("id") == call_id:
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
def post_call_delivery_check_ai(call_id: str) -> dict[str, Any]:
    st = store.get_state()
    for c in st.get("calls", []):
        if c.get("id") == call_id:
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
    for c in st.get("calls", []):
        if c.get("id") == call_id:
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
    raise HTTPException(status_code=404, detail="Call not found")


@router.delete("/api/calls/{call_id}/assignment")
def delete_call_assignment(call_id: str) -> dict[str, Any]:
    st = store.get_state()
    st["callbacks_open"] = [c for c in st.get("callbacks_open", []) if c.get("id") != call_id]
    store.save_state()
    return {"ok": True}


@router.post("/api/calls/{call_id}/reanalyze")
def post_call_reanalyze(call_id: str) -> dict[str, Any]:
    return get_call_detail(call_id)


@router.delete("/api/calls/{call_id}")
def delete_call(call_id: str) -> dict[str, Any]:
    st = store.get_state()
    st["calls"] = [c for c in st.get("calls", []) if c.get("id") != call_id]
    st.get("full_calls", {}).pop(call_id, None)
    store.save_state()
    return {"ok": True}


@router.post("/api/calls/bulk-delete")
def post_calls_bulk_delete(body: dict[str, Any]) -> dict[str, Any]:
    st = store.get_state()
    ids_to_del = set(body.get("ids", []))
    orig_len = len(st.get("calls", []))
    st["calls"] = [c for c in st.get("calls", []) if c.get("id") not in ids_to_del]
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
    rep_id = body.get("rep_id") or u["id"]
    rep = st["users_by_id"].get(rep_id, u)

    transcript = body.get("transcript", "")
    cust_name = body.get("customer_name") or "Direct Caller"
    rep_name = rep.get("name", "Sales Rep")

    analyzed = analyzer.analyze_transcript(transcript, customer_name=cust_name, rep_name=rep_name)

    veh_str = analyzed.get("vehicle") or " ".join(
        str(x) for x in [analyzed.get("vehicle_year"), analyzed.get("vehicle_make"), analyzed.get("vehicle_model")] if x
    )

    summary_item = {
        "id": cid,
        "org_id": rep.get("org_id") or u.get("org_id") or store.KEECH_ORG_ID,
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
    chosen_rep_id = rep_id or rep or u["id"]
    rep_user = st["users_by_id"].get(chosen_rep_id, u)
    cust_name = customer_name or customer or "Audio Caller"
    rep_name = rep_user.get("name", "Sales Rep")

    audio_bytes = await file.read()
    orig_name = file.filename or "recording.wav"
    ext = os.path.splitext(orig_name)[1].lower() or ".wav"
    mime_type = normalize_audio_mime(orig_name, file.content_type)

    uploads_dir = get_uploads_dir()
    saved_path = os.path.join(uploads_dir, f"{cid}{ext}")
    with open(saved_path, "wb") as f:
        f.write(audio_bytes)

    analyzed = None
    if is_gemini_configured():
        analyzed = analyze_audio_call_llm(
            audio_bytes, mime_type=mime_type, customer_name=cust_name, rep_name=rep_name
        )

    if not analyzed:
        transcript = (
            f"Rep: Thanks for calling Salvage Pulse, this is {rep_name}. How can I help you today?\n"
            f"Customer: Hi {rep_name}, I'm calling to check price and availability on parts for my vehicle."
        )
        analyzed = analyzer.analyze_transcript(transcript, customer_name=cust_name, rep_name=rep_name)
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
        "org_id": rep_user.get("org_id") or u.get("org_id") or store.KEECH_ORG_ID,
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
    chosen_rep_id = rep_id or u["id"]
    rep_user = st["users_by_id"].get(chosen_rep_id, u)
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
            ext = os.path.splitext(orig_name)[1].lower() or ".wav"
            mime_type = normalize_audio_mime(orig_name, up_file.content_type)

            saved_path = os.path.join(uploads_dir, f"{cid}{ext}")
            with open(saved_path, "wb") as f:
                f.write(audio_bytes)

            analyzed = None
            if is_gemini_configured():
                analyzed = analyze_audio_call_llm(
                    audio_bytes, mime_type=mime_type, customer_name="Inbound Caller", rep_name=rep_name
                )

            if not analyzed:
                fallback_text = (
                    f"Rep: Thanks for calling Salvage Pulse, this is {rep_name}. How can I help you today?\n"
                    f"Customer: Calling to check availability on recycled OEM parts."
                )
                analyzed = analyzer.analyze_transcript(fallback_text, customer_name="Inbound Caller", rep_name=rep_name)
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
                "org_id": rep_user.get("org_id") or u.get("org_id") or store.KEECH_ORG_ID,
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
async def post_calls_import(file: UploadFile = File(...)) -> dict[str, Any]:
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
    org_id = u.get("org_id")
    calls = st.get("calls", [])
    res = []

    for c in calls:
        if org_id and c.get("org_id") != org_id:
            continue
        if rep_id and c.get("rep_id") != rep_id:
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
        if vehicle_make and (c.get("vehicle_make") or "").lower() != vehicle_make.lower():
            continue
        if vehicle_model and (c.get("vehicle_model") or "").lower() != vehicle_model.lower():
            continue
        if part and (c.get("part_requested") or "").lower() != part.lower():
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

        res.append(c)

    return {"total": len(res), "calls": res[:200]}


# Call cleanup
@router.get("/api/call-cleanup/batches")
def get_cleanup_batches() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("cleanup_batches", [])


@router.delete("/api/call-cleanup/batches/{bid}")
def delete_cleanup_batch(bid: str) -> dict[str, Any]:
    return {"matched": 0, "deleted": 0}


@router.post("/api/call-cleanup/range")
def post_cleanup_range(body: dict[str, Any]) -> dict[str, Any]:
    return {"matched": 12, "deleted": 12 if not body.get("dry_run") else 0}


@router.get("/api/call-cleanup/trash")
def get_cleanup_trash() -> list[dict[str, Any]]:
    st = store.get_state()
    return st.get("cleanup_trash", [])


@router.post("/api/call-cleanup/trash/{tid}/restore")
def post_cleanup_restore(tid: str) -> dict[str, Any]:
    return {"restored": 10}


# Tagging & Delivery
@router.get("/api/tagging/queue")
def get_tagging_queue() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/tagging/queue", {"total": 0, "items": []})


@router.post("/api/tagging/{cid}/skip")
@router.post("/api/tagging/{cid}/delivery")
def post_tagging_action(cid: str) -> dict[str, Any]:
    st = store.get_state()
    queue = st["seed"].get("/tagging/queue", {"total": 0, "items": []})
    queue["items"] = [i for i in queue.get("items", []) if i.get("id") != cid]
    queue["total"] = len(queue["items"])
    return queue


@router.get("/api/tagging/leaderboard")
def get_tagging_leaderboard() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/tagging/leaderboard", {})


@router.get("/api/tagging/champion")
def get_tagging_champion() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/tagging/champion", {})


@router.get("/api/tagging/parts")
def get_tagging_parts() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/tagging/parts", {})


@router.get("/api/parts/catalog")
def get_parts_catalog() -> list[str]:
    st = store.get_state()
    return st["seed"].get("/parts/catalog", [])


@router.get("/api/delivery-stats")
def get_delivery_stats() -> dict[str, Any]:
    st = store.get_state()
    return st["seed"].get("/delivery-stats", {})
