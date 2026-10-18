"""Тесты бэкенда на настоящем Postgres из pgserver.

Запуск: pip install fastapi "psycopg[binary]" pgserver httpx pytest && pytest tests
"""

import os
import random
import sys
import tempfile
from collections import Counter
from pathlib import Path

import pgserver
import psycopg
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

ROLES = ['PL', 'ME', 'IMP', 'RI', 'TW', 'CO', 'SH', 'CF', 'SP']


def random_scores(rng):
    """Как в тесте: пять блоков, в каждом 10 баллов между ролями."""
    scores = dict.fromkeys(ROLES, 0)
    for _ in range(5):
        for _ in range(10):
            scores[rng.choice(ROLES[:rng.randint(2, 9)])] += 1
    return scores


@pytest.fixture(scope='session')
def server():
    srv = pgserver.get_server(os.environ.get('PGSERVER_DIR', tempfile.mkdtemp()), cleanup_mode='stop')
    yield srv


@pytest.fixture()
def client(server):
    with psycopg.connect(server.get_uri(), autocommit=True) as conn:
        conn.execute('drop database if exists teams_test')
        conn.execute('create database teams_test')
    os.environ['DATABASE_URL'] = server.get_uri('teams_test')
    import api.index as backend
    backend.database_url.cache_clear()
    backend._schema_ready = False
    from fastapi.testclient import TestClient
    return TestClient(backend.app)


# ---------------------------------------------------------------- Алгоритм

from api.index import build_teams, coverage, main_roles, position_levels, role_groups  # noqa: E402


def make_members(n, seed):
    rng = random.Random(seed)
    members = []
    for i in range(n):
        scores = random_scores(rng)
        members.append({'id': f'id{i}', 'name': f'Ученик {i}', 'scores': scores, 'levels': position_levels(scores)})
    return members


def test_equal_scores_share_place():
    groups = role_groups({'PL': 10, 'ME': 8, 'IMP': 8, 'RI': 8, 'TW': 6, 'CO': 5, 'SH': 3, 'CF': 2, 'SP': 0})
    assert [code for code, g in groups.items() if g == 0] == ['PL', 'ME', 'IMP', 'RI']
    assert groups['SP'] == 2


def test_level_takes_best_of_team_roles():
    scores = {'PL': 0, 'ME': 0, 'IMP': 0, 'RI': 0, 'TW': 20, 'CO': 2, 'SH': 1, 'CF': 15, 'SP': 12}
    levels = position_levels(scores)
    assert levels[3] == (1, 20)   # проджект — по TW, балл не суммируется
    assert levels[0] == (0, 0)    # дизайнер — PL без баллов


@pytest.mark.parametrize('n', range(1, 41))
def test_everyone_gets_exactly_one_team(n):
    teams = build_teams(make_members(n, seed=n))
    ids = [m['id'] for team in teams for m in team]
    assert sorted(ids) == sorted(f'id{i}' for i in range(n))
    assert len(teams) == max(1, n // 3)
    if n >= 6:
        sizes = Counter(len(team) for team in teams)
        assert set(sizes) <= {3, 4} and sizes[4] == n % 3


def test_draft_beats_random_split():
    """Набор по кругам закрывает больше ролей, чем случайное деление на тройки."""
    rng = random.Random(1)
    drafted = shuffled = 0
    for seed in range(50):
        members = make_members(21, seed)
        drafted += sum(sum(coverage(team)) for team in build_teams(members))
        rng.shuffle(members)
        shuffled += sum(sum(coverage(members[i:i + 3])) for i in range(0, 21, 3))
    assert drafted > shuffled


def test_main_roles_are_distinct_when_possible():
    for seed in range(30):
        for team in build_teams(make_members(12, seed)):
            roles = main_roles(team)
            options = [{p for p, (level, _) in enumerate(m['levels']) if level} for m in team]
            assert len(roles) == len(team)
            if distinct_possible(options):
                assert len(set(roles)) == len(roles)
                assert all(role in own for role, own in zip(roles, options))


def distinct_possible(options, used=frozenset()):
    if not options:
        return True
    return any(distinct_possible(options[1:], used | {p}) for p in options[0] - used)


# ---------------------------------------------------------------- API

def join_and_submit(client, code, name, scores):
    member = client.post(f'/api/groups/{code}/members', json={'name': name}).json()
    response = client.put(f'/api/groups/{code}/members/{member["id"]}', json={'scores': scores})
    assert response.status_code == 200, response.text
    return member['id']


def test_full_lesson(client):
    group = client.post('/api/groups').json()
    code, key = group['code'], group['key']
    teacher = {'X-Teacher-Key': key}
    rng = random.Random(7)

    ids = [join_and_submit(client, code, f'Ученик {i}', random_scores(rng)) for i in range(10)]
    waiting = client.post(f'/api/groups/{code}/members', json={'name': 'Ещё проходит'}).json()['id']

    view = client.get(f'/api/groups/{code}', headers=teacher).json()
    assert len(view['members']) == 11 and sum(m['finished'] for m in view['members']) == 10
    assert view['teams'] == [] and not view['distributed']
    assert client.get(f'/api/groups/{code}/members/{ids[0]}').json()['team'] is None

    view = client.post(f'/api/groups/{code}/distribute', headers=teacher).json()
    assert view['distributed']
    assert sorted(len(t['members']) for t in view['teams']) == [3, 3, 4]

    me = client.get(f'/api/groups/{code}/members/{ids[0]}').json()
    assert me['team'] and sum(m['me'] for m in me['team']['members']) == 1

    # Опоздавший сразу попадает в одну из троек.
    response = client.put(f'/api/groups/{code}/members/{waiting}', json={'scores': random_scores(rng)})
    assert response.json()['team'] is not None
    view = client.get(f'/api/groups/{code}', headers=teacher).json()
    assert sorted(len(t['members']) for t in view['teams']) == [3, 4, 4]

    # Пересборка учитывает всех.
    view = client.post(f'/api/groups/{code}/distribute', headers=teacher).json()
    assert sum(len(t['members']) for t in view['teams']) == 11


def test_access_and_validation(client):
    code = client.post('/api/groups').json()['code']
    assert client.get(f'/api/groups/{code}').status_code == 403
    assert client.get(f'/api/groups/{code}', headers={'X-Teacher-Key': 'wrong'}).status_code == 403
    assert client.get('/api/groups/NOPE00', headers={'X-Teacher-Key': 'x'}).status_code == 404
    assert client.post(f'/api/groups/{code}/members', json={'name': ' '}).status_code == 422

    member = client.post(f'/api/groups/{code}/members', json={'name': '  Петя   Иванов '}).json()['id']
    bad = dict.fromkeys(ROLES, 5)
    assert client.put(f'/api/groups/{code}/members/{member}', json={'scores': bad}).status_code == 422
    assert client.get(f'/api/groups/{code}/members/{member}').json()['name'] == 'Петя Иванов'
    assert client.put(f'/api/groups/{code}/members/unknown', json={'scores': random_scores(random.Random())}).status_code == 404
