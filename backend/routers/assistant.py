"""Wheelie chat endpoints, scoped to the signed-in platform session."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

import assistant_service
from security import SlidingWindowLimiter, enforce_rate_limit, require_authenticated

router = APIRouter(tags=["assistant"], dependencies=[Depends(require_authenticated)])

_CHAT_LIMITER = SlidingWindowLimiter(limit=30, window_seconds=60)


@router.get("/api/assistant/context")
def assistant_context(request: Request) -> dict[str, Any]:
    user = require_authenticated(request)
    return assistant_service.context_for_user(user)


@router.post("/api/assistant/chat")
def assistant_chat(body: dict[str, Any], request: Request) -> dict[str, Any]:
    user = require_authenticated(request)
    enforce_rate_limit(_CHAT_LIMITER, str(user.get("id") or "unknown"))

    raw = body.get("messages")
    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=400, detail="Send a message first.")

    messages: list[dict[str, str]] = []
    for item in raw[-20:]:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="Invalid message.")
        role = item.get("role")
        content = item.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str):
            raise HTTPException(status_code=400, detail="Invalid message.")
        content = content.strip()
        if not content:
            continue
        if len(content) > 4000:
            raise HTTPException(status_code=400, detail="Messages are limited to 4,000 characters.")
        messages.append({"role": role, "content": content})

    if not messages or messages[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="The last message must be from the user.")

    reply = assistant_service.ask_wheelie(user, messages)
    return {
        "reply": reply,
        "suggestions": assistant_service.suggestions_for(user, messages[-1]["content"]),
    }
