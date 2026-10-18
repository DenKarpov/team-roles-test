// Бэкенд групп на Google Apps Script: ученики присылают результаты теста, учитель делит их на команды.
// Алгоритм команд описан в 07-алгоритм-команд.md: тройки, набор по кругам, остаток — четвёртыми.
//
// Протокол: один адрес, POST с JSON в теле ({ action, ... }), ответ { ok: true, data } или
// { ok: false, status, error }. Apps Script не умеет отдавать коды ответа и не отвечает на
// CORS-preflight, поэтому клиент шлёт text/plain без своих заголовков, а ошибку ищет в теле.
//
// Хранилище — свойства скрипта: t:ХЕШ — учитель, g:КОД — группа, m:КОД:ID — участник.
// Ограничения: 9 КБ на значение, 500 КБ всего; группы старше 30 дней удаляются при создании новых.
//
// Регистрации нет. При первой группе сайт выдаёт учителю код («лиса-окно-гора-42»): он и есть
// доступ ко всем его группам с любого устройства. Хранится только хеш кода.

const ROLE_CODES = ['PL', 'ME', 'IMP', 'RI', 'TW', 'CO', 'SH', 'CF', 'SP'];

// Командные роли каждой роли в проекте. Порядок — как в POSITIONS из data.js,
// клиент показывает роль в проекте по её номеру.
const POSITION_ROLES = [['PL'], ['ME'], ['RI'], ['TW', 'CO', 'SH'], ['IMP', 'SP'], ['CF']];

const TOTAL_POINTS = 50;
const KEEP_DAYS = 30;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---------------------------------------------------------------- Алгоритм

// 0 — основные (места 1–3), 1 — дополнительные (4–6), 2 — остальные.
// Места как в спорте: равные баллы делят одно место. Роль без баллов всегда в последней группе.
// Так же считает тест в app.js.
function roleGroups(scores) {
  const codes = ROLE_CODES.slice().sort((a, b) => scores[b] - scores[a]);
  const groups = {};
  let place = 0;
  codes.forEach((code, i) => {
    if (i === 0 || scores[code] !== scores[codes[i - 1]]) place = i + 1;
    groups[code] = scores[code] === 0 ? 2 : place <= 3 ? 0 : place <= 6 ? 1 : 2;
  });
  return groups;
}

// По каждой роли в проекте: { level, score }. Уровень 1 — роль из основных командных ролей,
// ½ — из дополнительных, 0 — нет. Балл — максимум по командным ролям, а не сумма,
// иначе проджект с тремя ролями всегда впереди.
function positionLevels(scores) {
  const groups = roleGroups(scores);
  return POSITION_ROLES.map(roles => {
    const best = Math.min(...roles.map(code => groups[code]));
    return { level: best === 0 ? 1 : best === 1 ? 0.5 : 0, score: Math.max(...roles.map(code => scores[code])) };
  });
}

function coverage(team) {
  return POSITION_ROLES.map((_, p) => Math.max(0, ...team.map(m => m.levels[p].level)));
}

function gain(covered, member) {
  return member.levels.reduce((total, { level }, p) => total + Math.max(0, level - covered[p]), 0);
}

// Кого команда берёт на своём ходу: кто закроет больше ролей, которых в ней нет.
// При равенстве — у кого меньше основных ролей (его труднее пристроить), потом — у кого выше
// баллы по ролям, которые он закроет, потом — по имени, чтобы результат не зависел от случая.
function pickKey(team, member) {
  const covered = coverage(team);
  return [
    -gain(covered, member),
    member.levels.filter(({ level }) => level === 1).length,
    -member.levels.reduce((total, { level, score }, p) => total + (level > covered[p] ? score : 0), 0),
    member.name.toLowerCase(),
    member.id,
  ];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function minBy(items, key) {
  return items.reduce((best, item) => (compareKeys(key(item), key(best)) < 0 ? item : best));
}

// Куда поставить человека сверх троек: в самую маленькую команду, где он закроет больше ролей.
function lateTeam(teams, member) {
  const smallest = Math.min(...teams.map(team => team.length));
  const candidates = teams.map((_, i) => i).filter(i => teams[i].length === smallest);
  return minBy(candidates, i => {
    const covered = coverage(teams[i]);
    return [-gain(covered, member), covered.reduce((a, b) => a + b, 0), i];
  });
}

// Тройки набором по кругам: в каждом круге команды выбирают по одному в обратном порядке.
function buildTeams(members) {
  const teams = Array.from({ length: Math.max(1, Math.floor(members.length / 3)) }, () => []);
  const free = members.slice();
  for (let round = 0; round < 3; round++) {
    const order = teams.map((_, i) => i);
    if (round % 2) order.reverse();
    for (const t of order) {
      if (!free.length) break;
      const pick = minBy(free, member => pickKey(teams[t], member));
      teams[t].push(pick);
      free.splice(free.indexOf(pick), 1);
    }
  }
  free.forEach(member => teams[lateTeam(teams, member)].push(member));
  return teams;
}

// Главная роль каждого в команде — у всех разная, по возможности из основных.
// Перебор: участников 3–5, ролей 6. Сначала важно, чтобы роли были разные у как можно большего
// числа людей, потом — чтобы из основных, потом — баллы. Кому разной роли не хватило, достаётся его лучшая.
function mainRoles(team) {
  let best = { value: -1, roles: [] };
  (function walk(i, used, picked, value) {
    if (i === team.length) {
      if (value > best.value) best = { value, roles: picked };
      return;
    }
    team[i].levels.forEach(({ level, score }, p) => {
      if (level && !used.includes(p)) walk(i + 1, used.concat(p), picked.concat(p), value + 10000 + level * 1000 + score);
    });
    walk(i + 1, used, picked.concat(null), value);
  })(0, [], [], 0);
  return best.roles.map((p, i) => {
    if (p !== null) return p;
    const levels = team[i].levels;
    return levels.reduce((top, _, q) => (compareKeys([levels[q].level, levels[q].score], [levels[top].level, levels[top].score]) > 0 ? q : top), 0);
  });
}

// ---------------------------------------------------------------- Хранилище

function store() {
  return PropertiesService.getScriptProperties();
}

function readAll() {
  return store().getProperties();
}

function loadGroup(all, code) {
  const raw = all['g:' + code];
  if (!raw) throw httpError(404, 'Группа не найдена');
  return JSON.parse(raw);
}

function loadMembers(all, code) {
  const prefix = 'm:' + code + ':';
  return Object.keys(all)
    .filter(key => key.indexOf(prefix) === 0)
    .map(key => Object.assign(JSON.parse(all[key]), { id: key.slice(prefix.length) }))
    .sort((a, b) => a.joined - b.joined || (a.id < b.id ? -1 : 1));
}

function saveMember(code, member) {
  const { id, levels, ...data } = member;
  store().setProperty('m:' + code + ':' + id, JSON.stringify(data));
}

function finished(members) {
  return members.filter(m => m.scores).map(m => Object.assign({}, m, { levels: positionLevels(m.scores) }));
}

// Команды из хранилища: список составов по номерам 1…N.
function currentTeams(members) {
  const teams = Array.from({ length: Math.max(0, ...members.map(m => m.team || 0)) }, () => []);
  members.forEach(m => { if (m.team) teams[m.team - 1].push(m); });
  return teams;
}

function describeTeams(members) {
  return currentTeams(members).map((team, i) => {
    const roles = mainRoles(team);
    return {
      number: i + 1,
      members: team.map((m, j) => ({ id: m.id, name: m.name, role: roles[j] })),
      coverage: coverage(team),
    };
  });
}

function withLock(action) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return action();
  } finally {
    lock.releaseLock();
  }
}

// Код группы короткий, его видят все. Секреты — код учителя и id учеников — из UUID:
// Math.random предсказуем, по выданным id можно было бы восстановить его состояние.
function groupCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

const secretId = () => Utilities.getUuid().replace(/-/g, '');

// 128 слов — делитель 256, поэтому байт UUID выбирает слово равновероятно.
const WORDS = [
  'кот', 'пес', 'лиса', 'волк', 'заяц', 'сова', 'рыба', 'кит', 'слон', 'лев', 'тигр', 'жук', 'утка', 'гусь', 'конь', 'бобр',
  'лось', 'енот', 'панда', 'белка', 'ворон', 'сокол', 'чайка', 'акула', 'краб', 'олень', 'зебра', 'жираф', 'пингвин', 'дельфин', 'кролик', 'хомяк',
  'море', 'река', 'озеро', 'гора', 'лес', 'поле', 'луг', 'сад', 'парк', 'дождь', 'снег', 'ветер', 'гроза', 'туча', 'облако', 'радуга',
  'солнце', 'луна', 'звезда', 'комета', 'остров', 'берег', 'волна', 'песок', 'камень', 'скала', 'пещера', 'ручей', 'туман', 'иней', 'роса', 'заря',
  'мост', 'дом', 'окно', 'дверь', 'стол', 'стул', 'лампа', 'книга', 'ручка', 'мяч', 'кубик', 'замок', 'башня', 'парус', 'лодка', 'якорь',
  'маяк', 'ракета', 'поезд', 'трамвай', 'шар', 'флаг', 'ключ', 'часы', 'компас', 'карта', 'глобус', 'кисть', 'краска', 'доска', 'пенал', 'рюкзак',
  'дуб', 'липа', 'ель', 'сосна', 'ива', 'кедр', 'роза', 'мак', 'лилия', 'ромашка', 'груша', 'слива', 'вишня', 'яблоко', 'арбуз', 'дыня',
  'лимон', 'банан', 'орех', 'гриб', 'ягода', 'малина', 'сыр', 'хлеб', 'суп', 'чай', 'пирог', 'торт', 'блин', 'каша', 'морковь', 'огурец',
];

// Три слова и число: около 200 млн вариантов — подбором через сайт не перебрать,
// а записать и продиктовать легко.
function teacherCode() {
  const hex = Utilities.getUuid().replace(/-/g, '');
  const byte = i => parseInt(hex.substr(i * 2, 2), 16);
  return [WORDS[byte(0) % WORDS.length], WORDS[byte(1) % WORDS.length], WORDS[byte(2) % WORDS.length], 10 + (byte(3) % 90)].join('-');
}

// Код учителя прощает регистр, «ё» и разделители: «Лиса Окно гора 42» — тот же код.
function normalizeTeacher(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter(Boolean).join('-');
}

function teacherHash(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, normalizeTeacher(value), Utilities.Charset.UTF_8);
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function findTeacher(all, value) {
  const hash = teacherHash(value);
  if (!normalizeTeacher(value) || !all['t:' + hash]) throw httpError(404, 'Код учителя не найден');
  return hash;
}

// ---------------------------------------------------------------- Действия

function checkOwner(group, teacher) {
  if (!normalizeTeacher(teacher) || teacherHash(teacher) !== group.owner) throw httpError(403, 'Нет доступа к группе');
}

// Старые группы чистим при создании новых, отдельный триггер для этого не нужен.
function deleteExpired(all) {
  const expired = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  Object.keys(all).forEach(key => {
    if (key.indexOf('g:') === 0 && JSON.parse(all[key]).created < expired) {
      const code = key.slice(2);
      Object.keys(all)
        .filter(k => k === key || k.indexOf('m:' + code + ':') === 0)
        .forEach(k => store().deleteProperty(k));
    }
  });
}

function cleanName(value) {
  const name = String(value || '').split(/\s+/).filter(Boolean).join(' ');
  if (name.length < 2 || name.length > 60) throw httpError(422, 'Имя — от 2 до 60 символов');
  return name;
}

function checkScores(scores) {
  const valid = scores && typeof scores === 'object'
    && Object.keys(scores).length === ROLE_CODES.length
    && ROLE_CODES.every(code => Number.isInteger(scores[code]) && scores[code] >= 0)
    && ROLE_CODES.reduce((total, code) => total + scores[code], 0) === TOTAL_POINTS;
  if (!valid) throw httpError(422, 'Нужны баллы по 9 ролям, всего ' + TOTAL_POINTS);
  return ROLE_CODES.reduce((clean, code) => Object.assign(clean, { [code]: scores[code] }), {});
}

const ACTIONS = {
  // Без кода учителя — первая группа: выдаём новый код.
  create({ teacher }) {
    return withLock(() => {
      const all = readAll();
      deleteExpired(all);
      let owner;
      if (teacher) {
        owner = findTeacher(all, teacher);
      } else {
        teacher = teacherCode();
        owner = teacherHash(teacher);
        store().setProperty('t:' + owner, JSON.stringify({ created: Date.now() }));
      }
      let code;
      do code = groupCode(); while (all['g:' + code]);
      store().setProperty('g:' + code, JSON.stringify({ owner, distributed: false, created: Date.now() }));
      return { code, teacher: normalizeTeacher(teacher) };
    });
  },

  groups({ teacher }) {
    const all = readAll();
    const owner = findTeacher(all, teacher);
    return Object.keys(all)
      .filter(key => key.indexOf('g:') === 0)
      .map(key => Object.assign(JSON.parse(all[key]), { code: key.slice(2) }))
      .filter(group => group.owner === owner)
      .sort((a, b) => b.created - a.created)
      .map(group => {
        const members = loadMembers(all, group.code);
        return {
          code: group.code,
          created: group.created,
          distributed: group.distributed,
          members: members.length,
          finished: members.filter(m => m.scores).length,
        };
      });
  },

  teacher({ code, teacher }) {
    const all = readAll();
    const group = loadGroup(all, code);
    checkOwner(group, teacher);
    const members = loadMembers(all, code);
    return {
      code,
      distributed: group.distributed,
      members: members.map(m => ({ id: m.id, name: m.name, finished: !!m.scores, team: m.team || null })),
      teams: describeTeams(finished(members)),
    };
  },

  distribute({ code, teacher }) {
    return withLock(() => {
      const all = readAll();
      const group = loadGroup(all, code);
      checkOwner(group, teacher);
      const members = loadMembers(all, code);
      const done = finished(members);
      if (!done.length) throw httpError(409, 'Пока никто не прошёл тест');
      const teamOf = {};
      buildTeams(done).forEach((team, i) => team.forEach(m => { teamOf[m.id] = i + 1; }));
      const updates = { ['g:' + code]: JSON.stringify(Object.assign(group, { distributed: true })) };
      members.forEach(m => {
        const { id, ...data } = m;
        updates['m:' + code + ':' + id] = JSON.stringify(Object.assign(data, { team: teamOf[id] || null }));
      });
      store().setProperties(updates);
      return ACTIONS.teacher({ code, teacher });
    });
  },

  join({ code, name }) {
    const all = readAll();
    loadGroup(all, code);
    const id = secretId();
    saveMember(code, { id, name: cleanName(name), scores: null, team: null, joined: Date.now() });
    return { id };
  },

  submit({ code, id, scores }) {
    const clean = checkScores(scores);
    withLock(() => {
      const all = readAll();
      const group = loadGroup(all, code);
      const members = loadMembers(all, code);
      const me = members.find(m => m.id === id);
      if (!me) throw httpError(404, 'Участник не найден');
      me.scores = clean;
      // Кто закончил после распределения, сразу встаёт в команду, где ему больше всего не хватает ролей.
      if (group.distributed && !me.team) {
        const teams = currentTeams(finished(members.filter(m => m.id !== id)));
        if (teams.length) me.team = lateTeam(teams, Object.assign({}, me, { levels: positionLevels(clean) })) + 1;
      }
      saveMember(code, me);
    });
    return ACTIONS.member({ code, id });
  },

  member({ code, id }) {
    const all = readAll();
    const group = loadGroup(all, code);
    const members = loadMembers(all, code);
    const me = members.find(m => m.id === id);
    if (!me) throw httpError(404, 'Участник не найден');
    let team = null;
    if (me.team) {
      const described = describeTeams(finished(members))[me.team - 1];
      team = { number: described.number, members: described.members.map(m => ({ name: m.name, role: m.role, me: m.id === id })) };
    }
    return { name: me.name, finished: !!me.scores, distributed: group.distributed, team };
  },
};

// ---------------------------------------------------------------- Вход

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function handle(body) {
  try {
    const request = JSON.parse(body || '{}');
    const action = ACTIONS[request.action];
    if (!action) throw httpError(400, 'Неизвестное действие');
    return { ok: true, data: action(request) };
  } catch (error) {
    if (!error.status) console.error(error);
    return { ok: false, status: error.status || 500, error: error.status ? error.message : 'Ошибка сервера' };
  }
}

function doPost(e) {
  const result = handle(e && e.postData && e.postData.contents);
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data: 'Командные роли: бэкенд групп' }))
    .setMimeType(ContentService.MimeType.JSON);
}
