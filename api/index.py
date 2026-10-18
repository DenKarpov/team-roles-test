"""Бэкенд групп: ученики присылают результаты теста, учитель делит их на команды.

Алгоритм команд описан в 07-алгоритм-команд.md: тройки, набор по кругам, остаток — четвёртыми.
"""

import os
import secrets
from functools import cache

import psycopg
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel, field_validator

ROLE_CODES = ['PL', 'ME', 'IMP', 'RI', 'TW', 'CO', 'SH', 'CF', 'SP']

# Командные роли каждой роли в проекте. Порядок — как в POSITIONS из data.js,
# клиент показывает роль в проекте по её номеру.
POSITION_ROLES = [['PL'], ['ME'], ['RI'], ['TW', 'CO', 'SH'], ['IMP', 'SP'], ['CF']]

TOTAL_POINTS = 50
KEEP_DAYS = 30
CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])


# ---------------------------------------------------------------- Алгоритм

def role_groups(scores):
    """0 — основные (места 1–3), 1 — дополнительные (4–6), 2 — остальные.

    Места как в спорте: равные баллы делят одно место. Роль без баллов всегда в последней группе.
    Так же считает тест в app.js.
    """
    codes = sorted(ROLE_CODES, key=lambda code: -scores[code])
    groups, place = {}, 0
    for i, code in enumerate(codes):
        if i == 0 or scores[code] != scores[codes[i - 1]]:
            place = i + 1
        groups[code] = 2 if scores[code] == 0 else 0 if place <= 3 else 1 if place <= 6 else 2
    return groups


def position_levels(scores):
    """По каждой роли в проекте: (уровень, балл).

    Уровень 1 — роль из основных командных ролей, ½ — из дополнительных, 0 — нет.
    Балл — максимум по командным ролям, а не сумма, иначе проджект с тремя ролями всегда впереди.
    """
    groups = role_groups(scores)
    levels = []
    for roles in POSITION_ROLES:
        best = min(groups[code] for code in roles)
        levels.append((1 if best == 0 else 0.5 if best == 1 else 0, max(scores[code] for code in roles)))
    return levels


def coverage(team):
    return [max((m['levels'][p][0] for m in team), default=0) for p in range(len(POSITION_ROLES))]


def gain(covered, member):
    return sum(max(0, level - covered[p]) for p, (level, _) in enumerate(member['levels']))


def pick_order(team, member):
    """Кого команда берёт на своём ходу: кто закроет больше ролей, которых в ней нет.

    При равенстве — у кого меньше основных ролей (его труднее пристроить), потом — у кого выше
    баллы по ролям, которые он закроет.
    """
    covered = coverage(team)
    first_order = sum(1 for level, _ in member['levels'] if level == 1)
    gained_score = sum(score for p, (level, score) in enumerate(member['levels']) if level > covered[p])
    return -gain(covered, member), first_order, -gained_score, member['name'].lower(), member['id']


def late_team(teams, member):
    """Куда поставить человека сверх троек: в самую маленькую команду, где он закроет больше ролей."""
    smallest = min(len(team) for team in teams)
    candidates = [i for i, team in enumerate(teams) if len(team) == smallest]
    return min(candidates, key=lambda i: (-gain(coverage(teams[i]), member), sum(coverage(teams[i])), i))


def build_teams(members):
    """Тройки набором по кругам: в каждом круге команды выбирают по одному в обратном порядке."""
    teams = [[] for _ in range(max(1, len(members) // 3))]
    free = list(members)
    for round_ in range(3):
        order = range(len(teams)) if round_ % 2 == 0 else reversed(range(len(teams)))
        for t in order:
            if not free:
                break
            pick = min(free, key=lambda m: pick_order(teams[t], m))
            teams[t].append(pick)
            free.remove(pick)
    for member in free:
        teams[late_team(teams, member)].append(member)
    return teams


def main_roles(team):
    """Главная роль каждого в команде — у всех разная, по возможности из основных.

    Перебор: участников 3–5, ролей 6. Сначала важно, чтобы роли были разные у как можно большего
    числа людей, потом — чтобы из основных, потом — баллы. Кому разной роли не хватило, достаётся его лучшая.
    """
    best = (-1, [])

    def walk(i, used, picked, value):
        nonlocal best
        if i == len(team):
            if value > best[0]:
                best = (value, list(picked))
            return
        for p, (level, score) in enumerate(team[i]['levels']):
            if level and p not in used:
                walk(i + 1, used | {p}, picked + [p], value + 10_000 + level * 1000 + score)
        walk(i + 1, used, picked + [None], value)

    walk(0, frozenset(), [], 0)
    return [p if p is not None else max(range(len(POSITION_ROLES)), key=lambda q: member['levels'][q])
            for p, member in zip(best[1], team)]


# ---------------------------------------------------------------- База

@cache
def database_url():
    return os.environ.get('DATABASE_URL') or os.environ['POSTGRES_URL']


_schema_ready = False


def connect():
    global _schema_ready
    # Без подготовленных запросов: Neon отдаёт соединения через пулер.
    conn = psycopg.connect(database_url(), row_factory=dict_row, prepare_threshold=None)
    if not _schema_ready:
        with conn.transaction():
            # Холодный старт может случиться в нескольких экземплярах сразу — схему создаёт один.
            conn.execute('select pg_advisory_xact_lock(7261)')
            conn.execute("""
                create table if not exists groups (
                    code text primary key,
                    teacher_key text not null,
                    distributed boolean not null default false,
                    created_at timestamptz not null default now()
                );
                create table if not exists members (
                    id text primary key,
                    group_code text not null references groups (code) on delete cascade,
                    name text not null,
                    scores jsonb,
                    team int,
                    joined_at timestamptz not null default now()
                );
                create index if not exists members_group_code on members (group_code);
            """)
        _schema_ready = True
    return conn


def load_group(conn, code, lock=False):
    group = conn.execute(f"select * from groups where code = %s{' for update' if lock else ''}", [code]).fetchone()
    if not group:
        raise HTTPException(404, 'Группа не найдена')
    return group


def check_teacher(group, key):
    if not key or not secrets.compare_digest(group['teacher_key'], key):
        raise HTTPException(403, 'Нет доступа к группе')


def finished_members(conn, code):
    rows = conn.execute(
        'select id, name, scores, team from members where group_code = %s and scores is not null order by joined_at, id',
        [code],
    ).fetchall()
    return [{**row, 'levels': position_levels(row['scores'])} for row in rows]


def current_teams(members):
    """Команды из базы: список составов по номерам 1…N."""
    count = max((m['team'] for m in members if m['team']), default=0)
    teams = [[] for _ in range(count)]
    for member in members:
        if member['team']:
            teams[member['team'] - 1].append(member)
    return teams


def describe_teams(members):
    result = []
    for number, team in enumerate(current_teams(members), start=1):
        roles = main_roles(team)
        result.append({
            'number': number,
            'members': [{'id': m['id'], 'name': m['name'], 'role': role} for m, role in zip(team, roles)],
            'coverage': coverage(team),
        })
    return result


# ---------------------------------------------------------------- Ручки

class JoinRequest(BaseModel):
    name: str

    @field_validator('name')
    @classmethod
    def clean_name(cls, value):
        value = ' '.join(value.split())
        if not 2 <= len(value) <= 60:
            raise ValueError('Имя — от 2 до 60 символов')
        return value


class ResultRequest(BaseModel):
    scores: dict[str, int]

    @field_validator('scores')
    @classmethod
    def check_scores(cls, value):
        if set(value) != set(ROLE_CODES) or any(v < 0 for v in value.values()) or sum(value.values()) != TOTAL_POINTS:
            raise ValueError(f'Нужны баллы по 9 ролям, всего {TOTAL_POINTS}')
        return value


@app.post('/api/groups')
def create_group():
    with connect() as conn:
        # Старые группы чистим здесь же, отдельный крон для этого не нужен.
        conn.execute(f"delete from groups where created_at < now() - interval '{KEEP_DAYS} days'")
        while True:
            code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(6))
            key = secrets.token_urlsafe(18)
            if conn.execute('insert into groups (code, teacher_key) values (%s, %s) on conflict do nothing',
                            [code, key]).rowcount:
                return {'code': code, 'key': key}


@app.get('/api/groups/{code}')
def teacher_view(code: str, x_teacher_key: str | None = Header(None)):
    with connect() as conn:
        group = load_group(conn, code)
        check_teacher(group, x_teacher_key)
        members = conn.execute(
            'select id, name, scores is not null as finished, team from members where group_code = %s order by joined_at, id',
            [code],
        ).fetchall()
        return {
            'code': code,
            'distributed': group['distributed'],
            'members': members,
            'teams': describe_teams(finished_members(conn, code)),
        }


@app.post('/api/groups/{code}/distribute')
def distribute(code: str, x_teacher_key: str | None = Header(None)):
    with connect() as conn:
        group = load_group(conn, code, lock=True)
        check_teacher(group, x_teacher_key)
        members = finished_members(conn, code)
        if not members:
            raise HTTPException(409, 'Пока никто не прошёл тест')
        conn.execute('update members set team = null where group_code = %s', [code])
        for number, team in enumerate(build_teams(members), start=1):
            conn.execute('update members set team = %s where id = any(%s)', [number, [m['id'] for m in team]])
        conn.execute('update groups set distributed = true where code = %s', [code])
    return teacher_view(code, x_teacher_key)


@app.post('/api/groups/{code}/members')
def join(code: str, request: JoinRequest):
    with connect() as conn:
        load_group(conn, code)
        member_id = secrets.token_urlsafe(12)
        conn.execute('insert into members (id, group_code, name) values (%s, %s, %s)', [member_id, code, request.name])
        return {'id': member_id}


@app.put('/api/groups/{code}/members/{member_id}')
def submit(code: str, member_id: str, request: ResultRequest):
    with connect() as conn:
        group = load_group(conn, code, lock=True)
        updated = conn.execute('update members set scores = %s where id = %s and group_code = %s returning team',
                               [Jsonb(request.scores), member_id, code]).fetchone()
        if not updated:
            raise HTTPException(404, 'Участник не найден')
        # Кто закончил после распределения, сразу встаёт в команду, где ему больше всего не хватает ролей.
        if group['distributed'] and not updated['team']:
            members = finished_members(conn, code)
            teams = current_teams([m for m in members if m['id'] != member_id])
            if teams:
                me = next(m for m in members if m['id'] == member_id)
                conn.execute('update members set team = %s where id = %s', [late_team(teams, me) + 1, member_id])
    return member_view(code, member_id)


@app.get('/api/groups/{code}/members/{member_id}')
def member_view(code: str, member_id: str):
    with connect() as conn:
        group = load_group(conn, code)
        me = conn.execute('select name, scores is not null as finished, team from members where id = %s and group_code = %s',
                          [member_id, code]).fetchone()
        if not me:
            raise HTTPException(404, 'Участник не найден')
        team = None
        if me['team']:
            described = describe_teams(finished_members(conn, code))[me['team'] - 1]
            team = {'number': described['number'], 'members': [
                {'name': m['name'], 'role': m['role'], 'me': m['id'] == member_id} for m in described['members']
            ]}
        return {'name': me['name'], 'finished': me['finished'], 'distributed': group['distributed'], 'team': team}
