from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
import analyzer
from auth_utils import get_current_user
from security import (
    assert_same_org,
    effective_org,
    is_manager,
    is_staff,
    require_authenticated,
    resolve_write_org,
)
from gemini_service import (
    generate_roleplay_scenario_draft_llm,
    is_gemini_configured,
    stream_roleplay_reply_llm,
)
import store

router = APIRouter(tags=["roleplay"], dependencies=[Depends(require_authenticated)])


def _session_org(st: dict[str, Any], sess: dict[str, Any]) -> str:
    owner = st.get("users_by_id", {}).get(sess.get("user_id") or "", {})
    return owner.get("org_id") or ""


def _session_access(st: dict[str, Any], user: dict[str, Any], sess: dict[str, Any], *, write: bool = False) -> None:
    assert_same_org(user, _session_org(st, sess))
    if is_staff(user) or sess.get("user_id") == user.get("id"):
        return
    if is_manager(user) and not write:
        return
    raise HTTPException(status_code=403, detail="Access denied")


def _scenario_visible(sc: dict[str, Any], org_id: str | None) -> bool:
    if not org_id:
        return True
    return not sc.get("org_id") or sc.get("org_id") == org_id


def _require_manager(user: dict[str, Any]) -> None:
    if not is_manager(user):
        raise HTTPException(status_code=403, detail="Manager access required")


SCENARIO_OPENERS = {
    "df412cc9-fc87-4999-936b-33af076b2a9b": "Hey there, this is Dale over at Precision Fleet. I've got two of our Transit vans down and I need four OEM alternators as soon as possible. What do you have on the shelf?",
    "skeptical_transmission": "Morning. I've got a customer's 2018 Silverado in my bay with transmission issues. Do you have a tested 6L80 in stock, and what's the story on it?",
    "price_shopper_ecoboost": "Hey, I'm looking for a 3.5 EcoBoost for a 2017 F-150. I got a quote from another yard down the road, but I wanted to see what you guys have in stock.",
    "core_return_upset": "Hi, I'm calling about our core return on that engine we bought three weeks ago. We paid a $250 deposit and nobody ever came to pick up the old unit. When is that refund going to hit?",
    "bumper_price_objection": "Hey, I need a front bumper cover for a 2020 CR-V. Do you have a clean OEM one, and what are you guys asking for it?",
    "engine_competitor_mechanic": "Yeah, I'm pricing out an engine for a customer's 2016 Altima 2.5. The yard on the other side of town quoted me $850, can you guys beat that?",
    "front_end_crosssell": "Hey, I'm working on a 2021 Camry that took a front hit. Do you have a clean OEM hood in Celestial Silver?",
}


def compute_roleplay_scoreboard(st: dict[str, Any], org_id: Optional[str] = None) -> dict[str, Any]:
    scenarios = [
        {"id": sc["id"], "title": sc["title"], "price_objection": bool(sc.get("price_objection"))}
        for sc in st.get("roleplay_scenarios", [])
    ]
    reps_map = {}
    for u in st.get("users_by_id", {}).values():
        if org_id and u.get("org_id") != org_id:
            continue
        if u.get("role") in ("rep", "sales_rep", "owner", "sales_manager"):
            reps_map[u["id"]] = {"rep_id": u["id"], "rep_name": u["name"], "scores": {}}

    for sess in st.get("roleplay_sessions", []):
        if sess.get("status") == "graded" and sess.get("grade"):
            uid = sess.get("user_id")
            sc_id = sess.get("scenario_id")
            score = sess.get("overall_score") or sess["grade"].get("overall_score")
            if uid and sc_id and score is not None:
                if uid in reps_map:
                    curr = reps_map[uid]["scores"].get(sc_id, 0)
                    if score > curr:
                        reps_map[uid]["scores"][sc_id] = score

    return {"scenarios": scenarios, "rows": list(reps_map.values())}


@router.get("/api/roleplay/scenarios")
def get_roleplay_scenarios(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    return [sc for sc in st.get("roleplay_scenarios", []) if _scenario_visible(sc, org_id)]


@router.post("/api/roleplay/scenarios")
def post_roleplay_scenario(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = resolve_write_org(u, body.get("org_id"))
    sc = {
        "id": str(uuid.uuid4()),
        "org_id": org_id,
        "title": str(body.get("title") or "New Scenario")[:160],
        "difficulty": str(body.get("difficulty") or "Medium")[:32],
        "persona": str(body.get("persona") or "Auto Shop Owner")[:500],
        "objective": str(body.get("objective") or "Confirm fitment and close.")[:1000],
        "opening_hint": str(body.get("opening_hint") or "")[:1000],
        "customer_brief": str(body.get("customer_brief") or "")[:2000],
        "custom": True,
        "price_objection": bool(body.get("price_objection", False)),
    }
    st.setdefault("roleplay_scenarios", []).insert(0, sc)
    store.save_state()
    return sc


@router.put("/api/roleplay/scenarios/{sc_id}")
def put_roleplay_scenario(sc_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    for sc in st.get("roleplay_scenarios", []):
        if sc.get("id") == sc_id:
            if sc.get("org_id"):
                assert_same_org(u, sc.get("org_id"))
            elif org_id and org_id != store.KEECH_ORG_ID:
                raise HTTPException(status_code=403, detail="Built-in scenarios are read-only")
            allowed = {
                "title", "difficulty", "persona", "objective", "opening_hint",
                "customer_brief", "price_objection",
            }
            for key, value in body.items():
                if key in allowed:
                    sc[key] = value
            store.save_state()
            return sc
    raise HTTPException(status_code=404, detail="Scenario not found")


@router.delete("/api/roleplay/scenarios/{sc_id}")
def delete_roleplay_scenario(sc_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = effective_org(u)
    target = next((s for s in st.get("roleplay_scenarios", []) if s.get("id") == sc_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Scenario not found")
    if target.get("org_id"):
        assert_same_org(u, target.get("org_id"))
    elif org_id and org_id != store.KEECH_ORG_ID:
        raise HTTPException(status_code=403, detail="Built-in scenarios cannot be deleted")
    st["roleplay_scenarios"] = [s for s in st.get("roleplay_scenarios", []) if s.get("id") != sc_id]
    store.save_state()
    return {"ok": True}


@router.post("/api/roleplay/scenarios/draft")
def post_roleplay_scenario_draft(body: dict[str, Any], request: Request) -> dict[str, Any]:
    u = get_current_user(request)
    _require_manager(u)
    idea = str(body.get("idea") or "price negotiation")[:300]
    if is_gemini_configured():
        try:
            draft = generate_roleplay_scenario_draft_llm(idea)
            if draft and isinstance(draft, dict) and draft.get("title"):
                return draft
        except Exception:
            pass

    return {
        "title": f"Negotiating on {idea.capitalize()}",
        "difficulty": "Medium",
        "persona": f"Customer inquiring about {idea} who wants a fast deal and reassurance.",
        "objective": "Build trust, confirm interchange accuracy, address pricing politely, and secure the deposit.",
        "opening_hint": "Ask for the VIN or Hollander part number right after the greeting.",
        "customer_brief": "You're checking prices with two other yards, but prefer getting it delivered tomorrow if the price is fair.",
        "price_objection": "price" in idea.lower() or "cost" in idea.lower(),
    }


@router.get("/api/roleplay/sessions")
def get_roleplay_sessions(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    if not org_id:
        return st.get("roleplay_sessions", [])
    if is_manager(u):
        org_user_ids = {uid for uid, usr in st["users_by_id"].items() if usr.get("org_id") == org_id}
        return [s for s in st.get("roleplay_sessions", []) if s.get("user_id") in org_user_ids]
    return [s for s in st.get("roleplay_sessions", []) if s.get("user_id") == u.get("id")]


@router.post("/api/roleplay/sessions")
def post_roleplay_session(body: dict[str, Any], request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = resolve_write_org(u, body.get("org_id"))
    sc_id = body.get("scenario_id")
    sc = next((s for s in st.get("roleplay_scenarios", []) if s.get("id") == sc_id), None)
    if sc_id and (not sc or not _scenario_visible(sc, org_id)):
        raise HTTPException(status_code=404, detail="Scenario not found")
    sc_title = sc.get("title", "Practice Scenario") if sc else "Practice Scenario"

    sess_id = str(uuid.uuid4())
    opener = ""
    if sc_id in SCENARIO_OPENERS:
        opener = SCENARIO_OPENERS[sc_id]
    elif sc and sc.get("opening_hint"):
        opener = f"Hi, I'm calling about parts for my vehicle. {sc.get('opening_hint')}"
    elif sc and sc.get("customer_brief"):
        opener = f"Hello, I'm calling to check availability on {sc.get('title', 'parts')}. Do you have anything tested in stock?"
    else:
        opener = "Hi, I'm looking for a clean OEM assembly for my vehicle. Can you check what you have in stock?"

    new_sess = {
        "id": sess_id,
        "user_id": u["id"],
        "user_name": u["name"],
        "scenario_id": sc_id or "",
        "scenario_title": sc_title,
        "scenario": sc or {},
        "messages": [
            {"role": "customer", "text": opener}
        ],
        "status": "active",
        "grade": None,
        "created_at": store.now_iso(),
    }
    st.setdefault("roleplay_sessions", []).insert(0, new_sess)
    store.save_state()
    return new_sess


@router.get("/api/roleplay/sessions/{sess_id}")
def get_roleplay_session_detail(sess_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    s = next((x for x in st.get("roleplay_sessions", []) if x.get("id") == sess_id), None)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    _session_access(st, u, s)
    return s


@router.post("/api/roleplay/sessions/{sess_id}/message")
async def post_roleplay_message(sess_id: str, body: dict[str, Any], request: Request) -> StreamingResponse:
    st = store.get_state()
    u = get_current_user(request)
    sess = next((x for x in st.get("roleplay_sessions", []) if x.get("id") == sess_id), None)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    _session_access(st, u, sess, write=True)

    rep_text = str(body.get("text") or "")[:8000]
    if not rep_text.strip():
        raise HTTPException(status_code=400, detail="Enter a reply before sending")
    sess.setdefault("messages", []).append({"role": "rep", "text": rep_text})

    scenario = sess.get("scenario")
    if not scenario and sess.get("scenario_id"):
        scenario = next((s for s in st.get("roleplay_scenarios", []) if s.get("id") == sess.get("scenario_id")), {})
    if not scenario:
        scenario = {}

    async def event_generator():
        accumulated = []
        if is_gemini_configured():
            try:
                prev_messages = sess["messages"][:-1]
                async for chunk in stream_roleplay_reply_llm(scenario, prev_messages, rep_text):
                    accumulated.append(chunk)
                    yield f"data: {json.dumps({'delta': chunk})}\n\n"
            except Exception as e:
                pass

        if not accumulated:
            ai_reply = analyzer.generate_roleplay_reply(scenario, sess["messages"], rep_text)
            words = ai_reply.split(" ")
            for i, word in enumerate(words):
                chunk = word if i == 0 else " " + word
                accumulated.append(chunk)
                yield f"data: {json.dumps({'delta': chunk})}\n\n"
                await asyncio.sleep(0.04)

        full_reply = "".join(accumulated).strip()
        sess["messages"].append({"role": "customer", "text": full_reply})
        store.save_state()

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/api/roleplay/sessions/{sess_id}/grade")
def post_roleplay_grade(sess_id: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    sess = next((x for x in st.get("roleplay_sessions", []) if x.get("id") == sess_id), None)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    _session_access(st, u, sess, write=True)

    scenario = sess.get("scenario")
    if not scenario and sess.get("scenario_id"):
        scenario = next((s for s in st.get("roleplay_scenarios", []) if s.get("id") == sess.get("scenario_id")), {})
    if not scenario:
        scenario = {}
    messages = sess.get("messages", [])

    grade = analyzer.grade_roleplay_session(scenario, messages)

    sess["status"] = "graded"
    sess["grade"] = grade
    sess["overall_score"] = grade.get("overall_score", 80)
    sess["completed_at"] = store.now_iso()
    store.save_state()
    return sess


@router.get("/api/roleplay/scoreboard")
def get_roleplay_scoreboard(request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    return compute_roleplay_scoreboard(st, org_id=effective_org(u))


@router.get("/api/roleplay/assignments")
def get_roleplay_assignments(request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    org_id = effective_org(u)
    items = st.get("roleplay_assignments", [])
    if org_id:
        return [a for a in items if a.get("org_id") == org_id]
    return items


@router.post("/api/roleplay/assignments")
def post_roleplay_assignments(body: dict[str, Any], request: Request) -> list[dict[str, Any]]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    org_id = resolve_write_org(u, body.get("org_id"))
    sc_id = str(body.get("scenario_id") or "")
    sc = next((s for s in st.get("roleplay_scenarios", []) if s.get("id") == sc_id), None)
    if not sc or not _scenario_visible(sc, org_id):
        raise HTTPException(status_code=404, detail="Scenario not found")
    sc_title = sc.get("title", "Scenario")

    try:
        pass_score = int(body.get("pass_score", 80))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Pass score must be a number")
    if pass_score < 0 or pass_score > 100:
        raise HTTPException(status_code=400, detail="Pass score must be between 0 and 100")

    created = []
    for rid in body.get("rep_ids", []):
        ruser = st["users_by_id"].get(str(rid))
        if not ruser:
            raise HTTPException(status_code=400, detail="Unknown team member")
        assert_same_org(u, ruser.get("org_id"))
        asgn = {
            "id": str(uuid.uuid4()),
            "org_id": org_id,
            "scenario_id": sc_id,
            "scenario_title": sc_title,
            "rep_id": ruser["id"],
            "rep_name": ruser.get("name", "Rep"),
            "due_date": str(body.get("due_date") or store.today_str())[:32],
            "pass_score": pass_score,
            "assigned_by": u.get("name", "Manager"),
            "created_at": store.now_iso(),
            "best_score": None,
            "attempts": 0,
            "status": "open",
            "completed_at": None,
        }
        st.setdefault("roleplay_assignments", []).append(asgn)
        created.append(asgn)

    store.save_state()
    return created


@router.delete("/api/roleplay/assignments/{aid}")
def delete_roleplay_assignment(aid: str, request: Request) -> dict[str, Any]:
    st = store.get_state()
    u = get_current_user(request)
    _require_manager(u)
    target = next((a for a in st.get("roleplay_assignments", []) if a.get("id") == aid), None)
    if not target:
        raise HTTPException(status_code=404, detail="Assignment not found")
    assert_same_org(u, target.get("org_id"))
    st["roleplay_assignments"] = [a for a in st.get("roleplay_assignments", []) if a.get("id") != aid]
    store.save_state()
    return {"ok": True}
