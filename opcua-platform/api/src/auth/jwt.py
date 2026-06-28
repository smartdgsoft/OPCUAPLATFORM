"""JWT authentication and RBAC for FastAPI."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

import asyncpg
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

from src.config.settings import settings
from src.db.database import get_pool

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")


class TokenData(BaseModel):
    user_id: str
    username: str
    role: str


class UserOut(BaseModel):
    id: str
    email: str
    username: str
    full_name: Optional[str]
    role: str
    is_active: bool


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.jwt_expire_minutes)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.jwt_secret, algorithm=settings.jwt_algorithm)


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    pool: asyncpg.Pool = Depends(get_pool),
) -> UserOut:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    row = await pool.fetchrow(
        """SELECT u.id::text, u.email, u.username, u.full_name,
                  r.name AS role, u.is_active
           FROM users u JOIN roles r ON r.id = u.role_id
           WHERE u.id = $1::uuid AND u.is_active = TRUE""",
        user_id,
    )
    if row is None:
        raise credentials_exception

    return UserOut(**dict(row))


def require_roles(*roles: str):
    """Dependency factory — restrict endpoint to given roles."""
    async def _check(user: UserOut = Depends(get_current_user)) -> UserOut:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{user.role}' not allowed. Required: {list(roles)}",
            )
        return user
    return _check
