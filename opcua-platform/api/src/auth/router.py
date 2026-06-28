"""Authentication endpoints."""
from __future__ import annotations

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr
from datetime import datetime, timezone

from src.auth.jwt import (
    UserOut, create_access_token, get_current_user,
    hash_password, require_roles, verify_password,
)
from src.db.database import get_pool

router = APIRouter()


class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserOut


class CreateUserRequest(BaseModel):
    email: EmailStr
    username: str
    password: str
    full_name: str | None = None
    role_id: int = 4  # VIEWER default


@router.post("/token", response_model=Token)
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    pool: asyncpg.Pool = Depends(get_pool),
):
    row = await pool.fetchrow(
        """SELECT u.id::text, u.email, u.username, u.full_name,
                  u.hashed_password, r.name AS role, u.is_active
           FROM users u JOIN roles r ON r.id = u.role_id
           WHERE u.username = $1""",
        form_data.username,
    )
    if not row or not row["is_active"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if not verify_password(form_data.password, row["hashed_password"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    # Update last login
    await pool.execute(
        "UPDATE users SET last_login = $1 WHERE id = $2::uuid",
        datetime.now(timezone.utc), row["id"],
    )

    token = create_access_token({"sub": row["id"], "username": row["username"], "role": row["role"]})
    user = UserOut(
        id=row["id"], email=row["email"], username=row["username"],
        full_name=row["full_name"], role=row["role"], is_active=row["is_active"],
    )
    return Token(access_token=token, token_type="bearer", user=user)


@router.get("/me", response_model=UserOut)
async def me(user: UserOut = Depends(get_current_user)):
    return user


@router.post("/users", response_model=UserOut)
async def create_user(
    req: CreateUserRequest,
    pool: asyncpg.Pool = Depends(get_pool),
    _: UserOut = Depends(require_roles("ADMIN")),
):
    hashed = hash_password(req.password)
    row = await pool.fetchrow(
        """INSERT INTO users (email, username, hashed_password, full_name, role_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id::text, email, username, full_name, is_active""",
        req.email, req.username, hashed, req.full_name, req.role_id,
    )
    role_row = await pool.fetchrow("SELECT name FROM roles WHERE id = $1", req.role_id)
    return UserOut(**dict(row), role=role_row["name"])
