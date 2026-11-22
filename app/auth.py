from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

from fastapi import HTTPException, Request, Response, status

from app.config import settings

FAMILY_COOKIE = "lernbuddy_family"
PARENT_COOKIE = "lernbuddy_parent"


def _sign_payload(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    b64 = base64.urlsafe_b64encode(raw).decode("ascii")
    sig = hmac.new(settings.session_secret.encode("utf-8"), b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{b64}.{sig}"


def _verify_token(token: str | None, expected_scope: str) -> dict[str, Any] | None:
    if not token or "." not in token:
        return None
    b64, sig = token.rsplit(".", 1)
    expected_sig = hmac.new(
        settings.session_secret.encode("utf-8"), b64.encode("ascii"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(sig, expected_sig):
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(b64.encode("ascii")).decode("utf-8"))
    except Exception:
        return None
    if payload.get("scope") != expected_scope:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


def verify_family_password(password: str) -> bool:
    return hmac.compare_digest(password.strip(), settings.family_password)


def verify_parent_pin(pin: str) -> bool:
    return hmac.compare_digest(pin.strip(), settings.parent_pin)


def set_family_cookie(response: Response, remember: bool = True) -> None:
    max_age = settings.session_days * 86400 if remember else 86400
    token = _sign_payload({"scope": "family", "exp": int(time.time()) + max_age})
    response.set_cookie(
        key=FAMILY_COOKIE,
        value=token,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def clear_family_cookie(response: Response) -> None:
    response.delete_cookie(FAMILY_COOKIE, path="/")
    response.delete_cookie(PARENT_COOKIE, path="/")


def set_parent_cookie(response: Response) -> None:
    max_age = settings.parent_session_minutes * 60
    token = _sign_payload({"scope": "parent", "exp": int(time.time()) + max_age})
    response.set_cookie(
        key=PARENT_COOKIE,
        value=token,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def clear_parent_cookie(response: Response) -> None:
    response.delete_cookie(PARENT_COOKIE, path="/")


def is_family_authenticated(request: Request) -> bool:
    return _verify_token(request.cookies.get(FAMILY_COOKIE), "family") is not None


def is_parent_authenticated(request: Request) -> bool:
    return (
        is_family_authenticated(request)
        and _verify_token(request.cookies.get(PARENT_COOKIE), "parent") is not None
    )


def require_family(request: Request) -> None:
    if not is_family_authenticated(request):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bitte zuerst mit dem Familien-Passwort anmelden.",
        )


def require_parent(request: Request) -> None:
    require_family(request)
    if not is_parent_authenticated(request):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Eltern-PIN erforderlich.",
        )
