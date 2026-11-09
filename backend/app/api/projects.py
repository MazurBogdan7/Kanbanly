from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Path, Query, Request, Response
from sqlalchemy import func, select

from app.api.deps import (
    AppMailer,
    AppSettings,
    Current,
    Db,
    IfMatch,
    bump,
    check_version,
    client_ip,
    set_etag,
)
from app.core.db import utcnow
from app.core.ids import uuid7
from app.models import Board, BoardColumn, Card, Project, ProjectInvite, ProjectMember, User
from app.repositories import access
from app.schemas.api import (
    BoardSummary,
    InviteCreate,
    InviteOut,
    InvitePreview,
    MemberOut,
    MemberUpdate,
    Page,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
)
from app.schemas.auth import Ok
from app.schemas.template import DEFAULT_TOKENS
from app.services import members
from app.services.audit import audit

router = APIRouter(tags=["projects"])

PREVIEW_TOKENS = ("bg", "surface", "surface-2", "accent", "text", "border")


async def summaries(db: Db, project_ids: list[UUID]) -> dict[UUID, list[BoardSummary]]:
    if not project_ids:
        return {}
    boards = (
        (
            await db.execute(
                select(Board)
                .where(Board.project_id.in_(project_ids), Board.deleted_at.is_(None))
                .order_by(Board.id)
            )
        )
        .scalars()
        .all()
    )
    board_ids = [board.id for board in boards]
    columns: dict[UUID, int] = {}
    cards: dict[UUID, int] = {}
    if board_ids:
        columns = dict(
            (
                await db.execute(
                    select(BoardColumn.board_id, func.count())
                    .where(BoardColumn.board_id.in_(board_ids))
                    .group_by(BoardColumn.board_id)
                )
            ).all()
        )
        cards = dict(
            (
                await db.execute(
                    select(Card.board_id, func.count())
                    .where(Card.board_id.in_(board_ids), Card.deleted_at.is_(None))
                    .group_by(Card.board_id)
                )
            ).all()
        )
    result: dict[UUID, list[BoardSummary]] = {}
    for board in boards:
        tokens = {**DEFAULT_TOKENS, **(board.settings or {}).get("theme", {}).get("tokens", {})}
        result.setdefault(board.project_id, []).append(
            BoardSummary(
                id=board.id,
                project_id=board.project_id,
                name=board.name,
                is_favorite=board.is_favorite,
                column_count=columns.get(board.id, 0),
                card_count=cards.get(board.id, 0),
                colors={token: tokens[token] for token in PREVIEW_TOKENS},
                last_opened_at=board.last_opened_at,
                updated_at=board.updated_at,
            )
        )
    return result


def _out(project: Project, role: str, boards: list[BoardSummary] | None = None) -> ProjectOut:
    return ProjectOut(
        id=project.id,
        name=project.name,
        description=project.description,
        role=role,
        version=project.version,
        created_at=project.created_at,
        updated_at=project.updated_at,
        boards=boards or [],
    )


@router.get("/projects")
async def list_projects(
    current: Current,
    db: Db,
    cursor: UUID | None = None,
    limit: int = Query(default=100, ge=1, le=200),
) -> Page[ProjectOut]:
    statement = access.visible_projects(current.id).order_by(Project.id).limit(limit + 1)
    if cursor is not None:
        statement = statement.where(Project.id > cursor)
    rows = (await db.execute(statement)).all()
    page = rows[:limit]
    boards = await summaries(db, [row[0].id for row in page])
    return Page(
        items=[_out(project, role, boards.get(project.id)) for project, role in page],
        next_cursor=str(page[-1][0].id) if len(rows) > limit else None,
    )


@router.post("/projects", status_code=201)
async def create_project(payload: ProjectCreate, current: Current, db: Db) -> ProjectOut:
    project = Project(
        id=uuid7(), owner_id=current.id, name=payload.name, description=payload.description, version=1
    )
    db.add(project)
    await db.flush()
    db.add(ProjectMember(project_id=project.id, user_id=current.id, role="owner"))
    return _out(project, "owner")


@router.get("/projects/{project_id}")
async def get_project(project_id: UUID, current: Current, db: Db, response: Response) -> ProjectOut:
    found = await access.get_project(db, current.id, project_id)
    set_etag(response, found.project)
    boards = await summaries(db, [project_id])
    return _out(found.project, found.role, boards.get(project_id))


@router.patch("/projects/{project_id}")
async def update_project(
    project_id: UUID,
    payload: ProjectUpdate,
    current: Current,
    db: Db,
    response: Response,
    if_match: IfMatch = None,
) -> ProjectOut:
    found = await access.get_project(db, current.id, project_id, "editor")
    check_version(found.project, if_match)
    if payload.name is not None:
        found.project.name = payload.name
    if payload.description is not None:
        found.project.description = payload.description
    bump(found.project, response)
    return _out(found.project, found.role)


@router.delete("/projects/{project_id}")
async def delete_project(project_id: UUID, current: Current, db: Db) -> Ok:
    found = await access.get_project(db, current.id, project_id, "owner")
    found.project.deleted_at = utcnow()
    audit(db, current.id, "project.deleted", target_type="project", target_id=project_id)
    return Ok()


@router.post("/projects/{project_id}/restore")
async def restore_project(project_id: UUID, current: Current, db: Db) -> ProjectOut:
    found = await access.get_project(db, current.id, project_id, "owner", deleted=True)
    found.project.deleted_at = None
    return _out(found.project, found.role)


def _member_out(member: ProjectMember, user: User, current_id: UUID) -> MemberOut:
    return MemberOut(
        user_id=user.id,
        display_name=user.display_name,
        email=user.email,
        role=member.role,
        is_you=user.id == current_id,
    )


@router.get("/projects/{project_id}/members")
async def list_members(project_id: UUID, current: Current, db: Db) -> list[MemberOut]:
    await access.get_project(db, current.id, project_id)
    rows = await members.list_members(db, project_id)
    return [_member_out(member, user, current.id) for member, user in rows]


@router.patch("/projects/{project_id}/members/{user_id}")
async def update_member(
    project_id: UUID, user_id: UUID, payload: MemberUpdate, current: Current, db: Db
) -> MemberOut:
    await access.get_project(db, current.id, project_id, "owner")
    member = await members.change_role(db, project_id, user_id, payload.role)
    user = await db.get(User, user_id)
    assert user is not None
    audit(
        db, current.id, "project.member_role", target_type="project", target_id=project_id, role=payload.role
    )
    return _member_out(member, user, current.id)


@router.delete("/projects/{project_id}/members/{user_id}")
async def remove_member(project_id: UUID, user_id: UUID, current: Current, db: Db) -> Ok:
    found = await access.get_project(db, current.id, project_id)
    await members.remove_member(db, project_id, user_id, found.role, current.id)
    audit(db, current.id, "project.member_removed", target_type="project", target_id=project_id)
    return Ok()


def _invite_out(invite: ProjectInvite, link: str | None = None) -> InviteOut:
    return InviteOut(
        id=invite.id,
        email=invite.email,
        role=invite.role,
        expires_at=invite.expires_at,
        created_at=invite.created_at,
        link=link,
    )


@router.get("/projects/{project_id}/invites")
async def list_invites(project_id: UUID, current: Current, db: Db) -> list[InviteOut]:
    await access.get_project(db, current.id, project_id, "owner")
    return [_invite_out(invite) for invite in await members.pending_invites(db, project_id)]


@router.post("/projects/{project_id}/invites", status_code=201)
async def create_invite(
    project_id: UUID,
    payload: InviteCreate,
    current: Current,
    db: Db,
    settings: AppSettings,
    mailer: AppMailer,
) -> InviteOut:
    found = await access.get_project(db, current.id, project_id, "owner")
    invite, token = await members.create_invite(
        db, settings, mailer, found.project, current.user, payload.email, payload.role
    )
    audit(db, current.id, "project.invite_created", target_type="project", target_id=project_id)
    # Ссылка показывается один раз: в базе хранится только хэш токена.
    return _invite_out(invite, members.invite_link(settings, token))


@router.delete("/projects/{project_id}/invites/{invite_id}")
async def revoke_invite(project_id: UUID, invite_id: UUID, current: Current, db: Db) -> Ok:
    await access.get_project(db, current.id, project_id, "owner")
    await members.revoke_invite(db, project_id, invite_id)
    return Ok()


@router.get("/invites/{token}")
async def preview_invite(
    token: Annotated[str, Path(max_length=128)], current: Current, db: Db
) -> InvitePreview:
    invite, project = await members.find_invite(db, current.user, token)
    inviter = await db.get(User, invite.invited_by) if invite.invited_by else None
    return InvitePreview(
        project_id=project.id,
        project_name=project.name,
        role=invite.role,
        inviter=inviter.display_name if inviter else "",
    )


@router.post("/invites/{token}/accept")
async def accept_invite(
    token: Annotated[str, Path(max_length=128)], request: Request, current: Current, db: Db
) -> ProjectOut:
    project = await members.accept_invite(db, current.user, token)
    audit(
        db,
        current.id,
        "project.invite_accepted",
        ip=client_ip(request),
        target_type="project",
        target_id=project.id,
    )
    role = (await access.get_project(db, current.id, project.id)).role
    return _out(project, role)
