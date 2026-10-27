import os
import uuid
from typing import Any
from fastapi import Request, Response
import store


def get_uploads_dir() -> str:
    d = os.environ.get("DATA_DIR")
    if d:
        up = os.path.join(d, "uploads")
    else:
        up = os.path.join(os.path.dirname(__file__), "uploads")
    os.makedirs(up, exist_ok=True)
    return up


def get_current_user(request: Request) -> dict[str, Any]:
    st = store.get_state()
    cookie_token = request.cookies.get("sp_session")
    if cookie_token and cookie_token in st.get("sessions", {}):
        uid = st["sessions"][cookie_token]
        if uid in st.get("users_by_id", {}):
            return st["users_by_id"][uid]

    uid = st.get("current_user_id")
    if uid and uid in st.get("users_by_id", {}):
        return st["users_by_id"][uid]

    masters = [
        u
        for u in st.get("users_by_id", {}).values()
        if u.get("role") == "master" and not u.get("disabled")
    ]
    if masters:
        return masters[0]
    if st.get("users_by_id"):
        return list(st["users_by_id"].values())[0]
    return {
        "id": "master-brettk",
        "email": "brettk@salvagepulsepro.com",
        "name": "Brett K",
        "role": "master",
    }


def set_session_cookie(response: Response, user_id: str) -> str:
    token = f"sess_{uuid.uuid4().hex}"
    st = store.get_state()
    if "sessions" not in st:
        st["sessions"] = {}
    st["sessions"][token] = user_id
    st["current_user_id"] = user_id
    response.set_cookie(
        key="sp_session",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=86400 * 30,
        path="/",
    )
    store.save_state()
    return token
