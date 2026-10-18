// Тесты бэкенда: node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBackend } from './gas.mjs';

const ROLES = ['PL', 'ME', 'IMP', 'RI', 'TW', 'CO', 'SH', 'CF', 'SP'];

// Детерминированный генератор, чтобы падения воспроизводились.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Как в тесте: пять блоков, в каждом 10 баллов между ролями.
export function randomScores(random) {
  const scores = Object.fromEntries(ROLES.map(code => [code, 0]));
  for (let block = 0; block < 5; block++) {
    const pool = ROLES.slice(0, 2 + Math.floor(random() * 8));
    for (let point = 0; point < 10; point++) scores[pool[Math.floor(random() * pool.length)]]++;
  }
  return scores;
}

// Значения из vm-контекста — из другого realm, сравниваем через JSON.
const plain = value => JSON.parse(JSON.stringify(value));

const { backend } = loadBackend();

function makeMembers(n, seed) {
  const random = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const scores = randomScores(random);
    return { id: `id${i}`, name: `Ученик ${i}`, scores, levels: backend.positionLevels(scores) };
  });
}

const total = list => list.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- Алгоритм

test('равные баллы делят место', () => {
  const groups = plain(backend.roleGroups({ PL: 10, ME: 8, IMP: 8, RI: 8, TW: 6, CO: 5, SH: 3, CF: 2, SP: 0 }));
  assert.deepEqual(Object.keys(groups).filter(code => groups[code] === 0).sort(), ['IMP', 'ME', 'PL', 'RI']);
  assert.equal(groups.SP, 2);
});

test('роль в проекте берёт лучшую из своих командных ролей', () => {
  const levels = plain(backend.positionLevels({ PL: 0, ME: 0, IMP: 0, RI: 0, TW: 20, CO: 2, SH: 1, CF: 15, SP: 12 }));
  assert.deepEqual(levels[3], { level: 1, score: 20 }); // проджект — по TW, баллы не суммируются
  assert.deepEqual(levels[0], { level: 0, score: 0 });  // дизайнер — PL без баллов
});

test('каждый попадает ровно в одну команду, тройки и четвёрки', () => {
  for (let n = 1; n <= 40; n++) {
    const teams = plain(backend.buildTeams(makeMembers(n, n)));
    assert.deepEqual(teams.flat().map(m => m.id).sort(), Array.from({ length: n }, (_, i) => `id${i}`).sort(), `n=${n}`);
    assert.equal(teams.length, Math.max(1, Math.floor(n / 3)), `n=${n}`);
    if (n >= 6) {
      const sizes = teams.map(team => team.length);
      assert.ok(sizes.every(size => size === 3 || size === 4), `n=${n}`);
      assert.equal(sizes.filter(size => size === 4).length, n % 3, `n=${n}`);
    }
  }
});

test('набор по кругам закрывает больше ролей, чем случайное деление', () => {
  let drafted = 0;
  let shuffled = 0;
  for (let seed = 0; seed < 50; seed++) {
    const members = makeMembers(21, seed);
    drafted += total(backend.buildTeams(members).map(team => total(backend.coverage(team))));
    for (let i = 0; i < 21; i += 3) shuffled += total(backend.coverage(members.slice(i, i + 3)));
  }
  assert.ok(drafted > shuffled, `${drafted} > ${shuffled}`);
});

function distinctPossible(options, used = new Set()) {
  if (!options.length) return true;
  return [...options[0]].some(p => !used.has(p) && distinctPossible(options.slice(1), new Set([...used, p])));
}

test('главные роли разные, когда это возможно', () => {
  for (let seed = 0; seed < 30; seed++) {
    for (const team of backend.buildTeams(makeMembers(12, seed))) {
      const roles = plain(backend.mainRoles(team));
      const options = team.map(m => new Set(m.levels.flatMap(({ level }, p) => (level ? [p] : []))));
      assert.equal(roles.length, team.length);
      if (distinctPossible(options)) {
        assert.equal(new Set(roles).size, roles.length);
        roles.forEach((role, i) => assert.ok(options[i].has(role)));
      }
    }
  }
});

// ---------------------------------------------------------------- Действия

function joinAndSubmit(call, code, name, scores) {
  const { data } = call('join', { code, name });
  const result = call('submit', { code, id: data.id, scores });
  assert.ok(result.ok, JSON.stringify(result));
  return data.id;
}

test('урок целиком', () => {
  const { call } = loadBackend();
  const { code, teacher } = call('create').data;
  const random = rng(7);

  const ids = Array.from({ length: 10 }, (_, i) => joinAndSubmit(call, code, `Ученик ${i}`, randomScores(random)));
  const waiting = call('join', { code, name: 'Ещё проходит' }).data.id;

  let view = call('teacher', { code, teacher }).data;
  assert.equal(view.members.length, 11);
  assert.equal(view.members.filter(m => m.finished).length, 10);
  assert.equal(view.teams.length, 0);
  assert.equal(view.distributed, false);
  assert.equal(call('member', { code, id: ids[0] }).data.team, null);

  view = call('distribute', { code, teacher }).data;
  assert.equal(view.distributed, true);
  assert.deepEqual(view.teams.map(t => t.members.length).sort(), [3, 3, 4]);

  const me = call('member', { code, id: ids[0] }).data;
  assert.ok(me.team);
  assert.equal(me.team.members.filter(m => m.me).length, 1);

  // Опоздавший сразу попадает в одну из троек.
  assert.ok(call('submit', { code, id: waiting, scores: randomScores(random) }).data.team);
  view = call('teacher', { code, teacher }).data;
  assert.deepEqual(view.teams.map(t => t.members.length).sort(), [3, 4, 4]);

  // Пересборка учитывает всех.
  view = call('distribute', { code, teacher }).data;
  assert.equal(total(view.teams.map(t => t.members.length)), 11);
});

test('опоздавшие не набиваются в одну команду, если распределили рано', () => {
  const { call } = loadBackend();
  const { code, teacher } = call('create').data;
  const random = rng(9);
  joinAndSubmit(call, code, 'Пришёл Первым', randomScores(random));
  joinAndSubmit(call, code, 'Пришёл Вторым', randomScores(random));
  assert.equal(call('distribute', { code, teacher }).data.teams.length, 1);
  for (let i = 0; i < 11; i++) joinAndSubmit(call, code, `Опоздавший ${i}`, randomScores(random));
  const sizes = call('teacher', { code, teacher }).data.teams.map(t => t.members.length);
  assert.equal(total(sizes), 13);
  assert.ok(sizes.every(size => size <= 4), sizes.join('+'));
  assert.deepEqual(sizes, [4, 4, 4, 1]);
});

test('доступ и проверка данных', () => {
  const { call } = loadBackend();
  const { code } = call('create').data;
  const stranger = call('create').data.teacher;
  assert.equal(call('teacher', { code }).status, 403);
  assert.equal(call('teacher', { code, teacher: stranger }).status, 403);
  assert.equal(call('teacher', { code: 'NOPE00', teacher: stranger }).status, 404);
  assert.equal(call('distribute', { code, teacher: stranger }).status, 403);
  assert.equal(call('join', { code, name: ' ' }).status, 422);
  assert.equal(call('nope').status, 400);

  const id = call('join', { code, name: '  Петя   Иванов ' }).data.id;
  assert.equal(call('submit', { code, id, scores: Object.fromEntries(ROLES.map(r => [r, 5])) }).status, 422);
  assert.equal(call('submit', { code, id, scores: { ...randomScores(rng(1)), extra: 0 } }).status, 422);
  assert.equal(call('member', { code, id }).data.name, 'Петя Иванов');
  assert.equal(call('submit', { code, id: 'unknown', scores: randomScores(rng(2)) }).status, 404);
  assert.equal(call('member', { code: 'NOPE00', id }).error, 'Группа не найдена');
});

test('код учителя: выдаётся с первой группой, открывает все его группы и только их', () => {
  const { call, props } = loadBackend();
  const first = call('create').data;
  assert.match(first.teacher, /^[а-я]+-[а-я]+-[а-я]+-\d{2}$/);
  const second = call('create', { teacher: first.teacher }).data;
  assert.equal(second.teacher, first.teacher);
  const other = call('create').data;
  assert.notEqual(other.teacher, first.teacher);

  const mine = call('groups', { teacher: first.teacher }).data;
  assert.deepEqual(mine.map(g => g.code).sort(), [first.code, second.code].sort());
  assert.deepEqual(call('groups', { teacher: other.teacher }).data.map(g => g.code), [other.code]);

  // Регистр, «ё», пробелы вместо дефисов — тот же код.
  const typed = ` ${first.teacher.toUpperCase().replace(/-/g, ' ').replace(/е/, 'ё')} `;
  assert.equal(call('groups', { teacher: typed }).data.length, 2);
  assert.ok(call('teacher', { code: first.code, teacher: typed }).ok);

  assert.equal(call('groups', { teacher: 'кот-пес-лиса-10' }).status, 404);
  assert.equal(call('groups', {}).status, 404);
  assert.equal(call('create', { teacher: 'кот-пес-лиса-10' }).status, 404);
  // В хранилище только хеш кода.
  assert.ok([...props.keys(), ...props.values()].every(text => !text.includes(first.teacher)));
});

test('список групп со счётчиками', () => {
  const { call } = loadBackend();
  const { code, teacher } = call('create').data;
  joinAndSubmit(call, code, 'Прошёл Тест', randomScores(rng(4)));
  call('join', { code, name: 'Ещё Проходит' });
  const [group] = call('groups', { teacher }).data;
  assert.equal(group.code, code);
  assert.equal(group.members, 2);
  assert.equal(group.finished, 1);
  assert.equal(group.distributed, false);
});

test('распределение без прошедших — понятная ошибка', () => {
  const { call } = loadBackend();
  const { code, teacher } = call('create').data;
  call('join', { code, name: 'Пока проходит' });
  assert.deepEqual(call('distribute', { code, teacher }), { ok: false, status: 409, error: 'Пока никто не прошёл тест' });
});

test('старые группы удаляются при создании новой', () => {
  const { call, props } = loadBackend();
  const { code } = call('create').data;
  call('join', { code, name: 'Старый ученик' });
  const group = JSON.parse(props.get(`g:${code}`));
  props.set(`g:${code}`, JSON.stringify({ ...group, created: Date.now() - 31 * 24 * 3600 * 1000 }));
  call('create');
  assert.equal([...props.keys()].filter(k => k.includes(code)).length, 0);
});

test('класс из 40 человек помещается в лимиты хранилища', () => {
  const { call, props } = loadBackend();
  const { code, teacher } = call('create').data;
  const random = rng(3);
  for (let i = 0; i < 40; i++) joinAndSubmit(call, code, `Константин Константинопольский-${i}`.slice(0, 60), randomScores(random));
  call('distribute', { code, teacher });
  const sizes = [...props.values()].map(value => Buffer.byteLength(value));
  assert.ok(Math.max(...sizes) < 9 * 1024);
  // 500 КБ на всё — это примерно 50 таких классов одновременно.
  assert.ok(total(sizes) + total([...props.keys()].map(k => k.length)) < 10 * 1024, `${total(sizes)}`);
});
