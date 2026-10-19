'use strict';

const STORAGE_KEY = 'team-roles-teacher-v2';
const POLL_MS = 5000;
const TEAM_SIZE = { min: 2, max: 6 };

const app = document.getElementById('app');

// Код учителя — единственный доступ к его группам. Браузер его помнит, на другом устройстве
// учитель вводит код сам. В адресе страницы только код группы (#КОД), он не секретный:
// ссылку на эту страницу можно пересылать коллегам — своих групп они не увидят.
let teacher = loadTeacher();
let freshTeacher = false;
let groups = null;
let view = null;
let teamSize = null;
let problem = null;
let loginProblem = null;
let busy = false;
let pollRun = 0;

const openCode = () => location.hash.slice(1).toUpperCase() || null;

function loadTeacher() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveTeacher() {
  try {
    if (teacher) localStorage.setItem(STORAGE_KEY, teacher);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Без localStorage код живёт до закрытия вкладки.
  }
}

// Так же код нормализует бэкенд: регистр, «ё» и разделители не важны.
const normalizeTeacher = value => value.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter(Boolean).join('-');

const studentLink = code => new URL(`./?g=${code}`, location.href).href;

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true, alt: 'QR-код со ссылкой на тест' });
}

const formatDate = time => new Date(time).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const notice = () => (problem ? `<p class="notice">${escapeHtml(problem)}</p>` : '');

function render() {
  pollRun++;
  view = null;
  teamSize = null;
  if (!teacher) {
    renderStart();
  } else if (openCode()) {
    renderGroup();
    poll();
  } else {
    renderGroups();
    loadGroups();
  }
  window.scrollTo(0, 0);
}

function renderStart() {
  app.innerHTML = `
    <section>
      <p class="eyebrow">Учителю</p>
      <h1>Команды</h1>
      <p class="lead">Ученики проходят тест, а&nbsp;вы одной кнопкой делите их на&nbsp;команды так, чтобы роли в&nbsp;команде дополняли друг друга.</p>

      <div class="card rules">
        <h2>Как это работает</h2>
        <ol>
          <li>Вы создаёте группу и&nbsp;показываете QR-код. Ученики сканируют его, вводят имя и&nbsp;проходят тест — 5–7&nbsp;минут.</li>
          <li>Вы видите, кто уже прошёл. Когда прошли все, выбираете, сколько человек в&nbsp;команде, и&nbsp;нажимаете «Распределить».</li>
          <li>Каждый видит свою команду у&nbsp;себя на&nbsp;экране, а&nbsp;роли в&nbsp;проекте — только вы. Кто закончит позже, сам попадёт в&nbsp;одну из&nbsp;команд.</li>
        </ol>
      </div>

      <div class="actions">
        <button type="button" class="button" data-action="create"${busy ? ' disabled' : ''}>Создать группу</button>
      </div>
      ${notice()}

      <form class="card login" id="login">
        <h2>Уже создавали группы?</h2>
        <p>Введите код учителя — сайт выдал его вместе с&nbsp;первой группой.</p>
        <label class="field">
          <span>Код учителя</span>
          <input name="teacher" type="text" placeholder="лиса-окно-гора-42" autocomplete="off" autocapitalize="off" spellcheck="false">
        </label>
        ${loginProblem ? `<p class="notice">${escapeHtml(loginProblem)}</p>` : ''}
        <div class="actions">
          <button type="submit" class="button"${busy ? ' disabled' : ''}>Открыть мои группы</button>
        </div>
      </form>
    </section>`;
}

function renderGroups() {
  app.innerHTML = `
    <section>
      <p class="eyebrow">Учителю</p>
      <h1>Ваши группы</h1>
      <div class="actions">
        <button type="button" class="button" data-action="create"${busy ? ' disabled' : ''}>Создать группу</button>
      </div>
      ${notice()}
      <div id="groups"></div>
      ${renderTeacherCode()}
    </section>`;
  renderGroupList();
}

function renderGroupList() {
  const box = document.getElementById('groups');
  if (!box) return;
  if (!groups) {
    box.innerHTML = problem ? '' : '<p class="notice">Загружаем группы…</p>';
    return;
  }
  box.innerHTML = groups.length
    ? `<ul class="card list">
        ${groups.map(group => `
          <li>
            <a class="list-row" href="#${escapeHtml(group.code)}">
              <span class="list-main"><strong>Группа ${escapeHtml(group.code)}</strong><small>${formatDate(group.created)}</small></span>
              <span class="list-meta${group.distributed ? ' is-done' : ''}">${group.distributed
                ? 'команды собраны'
                : group.members ? `прошли ${group.finished} из&nbsp;${group.members}` : 'пока никого'}</span>
            </a>
          </li>`).join('')}
      </ul>`
    : '<p class="notice">Пока нет групп. Группы хранятся 30&nbsp;дней.</p>';
}

function renderTeacherCode() {
  return `
    <div class="code-section${freshTeacher ? ' is-fresh' : ''}">
      <h2 class="subhead">Код учителя</h2>
      <div class="card code-card">
        <span class="code-value">${escapeHtml(teacher)}</span>
        <button type="button" class="link-button" data-action="copy-teacher">Скопировать</button>
      </div>
      <p class="code-note">По нему вы вернётесь к&nbsp;своим группам с&nbsp;другого устройства. Ученикам его не&nbsp;показывайте.${freshTeacher
        ? ''
        : ' <button type="button" class="link-button" data-action="logout">Выйти на&nbsp;этом устройстве</button>'}</p>
    </div>`;
}

function renderGroup() {
  const code = openCode();
  app.innerHTML = `
    <section>
      <p class="back"><a href="#">← Ваши группы</a></p>
      <h1>Группа ${escapeHtml(code)}</h1>
      ${freshTeacher ? renderFirstCode() : renderInvite(code)}
    </section>`;
  renderLive();
}

// После первой группы сначала только код учителя: страницу с QR выводят на проектор,
// код там светиться не должен.
function renderFirstCode() {
  return `
    <p class="lead">Группа создана. Прежде чем показывать QR-код ученикам, запишите код учителя.</p>
    ${renderTeacherCode()}
    <div class="actions">
      <button type="button" class="button" data-action="code-saved">Готово, показать QR-код</button>
    </div>`;
}

function renderInvite(code) {
  return `
    <p class="lead">Покажите ученикам QR-код. Они пройдут тест, а&nbsp;вы соберёте из&nbsp;них команды.</p>

    <div class="card invite">
      <div class="qr">${qrSvg(studentLink(code))}</div>
      <div class="invite-text">
        <p>Наведите камеру телефона на&nbsp;код или откройте ссылку:</p>
        <p class="invite-link">${escapeHtml(studentLink(code))}</p>
        <button type="button" class="link-button" data-action="copy">Скопировать ссылку</button>
      </div>
    </div>

    <div id="live"></div>`;
}

function renderLive() {
  const box = document.getElementById('live');
  if (!box) return;
  if (!view) {
    box.innerHTML = `<p class="notice">${escapeHtml(problem || 'Загружаем группу…')}</p>`;
    return;
  }
  const done = view.members.filter(member => member.finished).length;
  box.innerHTML = `
    <h2 class="section-title">Ученики</h2>
    <p class="section-lead">${view.members.length
      ? `Тест прошли ${done} из&nbsp;${view.members.length}`
      : 'Пока никого нет. Ученики появятся здесь, как только откроют ссылку и&nbsp;начнут тест.'}</p>
    ${view.members.length ? `
      <ul class="card people">
        ${view.members.map(member => `
          <li>
            <span>${escapeHtml(member.name)}</span>
            <span class="status${member.finished ? ' is-done' : ''}">${member.team ? `команда ${member.team}` : member.finished ? 'тест пройден' : 'проходит тест'}</span>
          </li>`).join('')}
      </ul>` : ''}

    ${done ? renderSizePicker(done) : ''}
    <div class="actions">
      <button type="button" class="button" data-action="distribute"${done && !busy ? '' : ' disabled'}>${view.distributed ? 'Пересобрать команды' : 'Распределить'}</button>
    </div>
    ${notice()}

    ${view.teams.length ? renderTeams() : ''}`;
}

// Сколько команд выйдет — так же считает teamCount в gas/Code.js: полные команды, лишние встают
// в них по одному; если лишних больше, чем команд, — ещё одна команда и деление поровну.
function teamCount(people, size) {
  const full = Math.max(1, Math.floor(people / size));
  return people - full * size > full ? full + 1 : full;
}

function describeSplit(people, size) {
  const count = teamCount(people, size);
  if (count === 1) return `Получится одна команда из&nbsp;${people} ${plural(people, 'человека', 'человек', 'человек')}`;
  const small = Math.floor(people / count);
  const bigger = people % count;
  const teams = `${count} ${plural(count, 'команда', 'команды', 'команд')}`;
  return `Получится ${teams}${bigger ? `: ${count - bigger} по&nbsp;${small} и&nbsp;${bigger} по&nbsp;${small + 1}` : ` по&nbsp;${small}`}`;
}

function renderSizePicker(done) {
  const size = teamSize ?? view.size;
  return `
    <div class="card size-picker">
      <div class="size-row">
        <span>Человек в&nbsp;команде</span>
        <div class="size-control">
          <output class="size-value">${size}</output>
          <div class="stepper" role="group" aria-label="Человек в команде">
            <button type="button" data-action="size-dec" aria-label="Меньше"${size > TEAM_SIZE.min && !busy ? '' : ' disabled'}>−</button>
            <button type="button" data-action="size-inc" aria-label="Больше"${size < TEAM_SIZE.max && !busy ? '' : ' disabled'}>+</button>
          </div>
        </div>
      </div>
      <p class="size-note">${describeSplit(done, size)}.</p>
    </div>`;
}

function renderTeams() {
  return `
    <h2 class="section-title">${view.teams.length} ${plural(view.teams.length, 'команда', 'команды', 'команд')}</h2>
    <p class="section-lead">Ученики видят у&nbsp;себя на&nbsp;экране состав своей команды, роли в&nbsp;проекте — только вы. Кто закончит тест позже, сам попадёт в&nbsp;одну из&nbsp;команд.</p>
    <div class="teams">
      ${view.teams.map(team => `
        <div class="card team">
          <h3>Команда ${team.number}</h3>
          <ul>
            ${team.members.map(member => `
              <li><span>${escapeHtml(member.name)}</span><span class="mate-role">${POSITIONS[member.role].name}</span></li>`).join('')}
          </ul>
          <p class="team-gaps">${describeGaps(team.coverage)}</p>
        </div>`).join('')}
    </div>`;
}

// coverage — по каждой роли в проекте: 1 — закрыта основной ролью, ½ — только дополнительной, 0 — никем.
function describeGaps(coverage) {
  const names = level => POSITIONS.filter((_, p) => coverage[p] === level).map(position => position.name);
  const missing = names(0);
  const secondary = names(0.5);
  if (!missing.length && !secondary.length) return 'Все роли закрыты основными ролями.';
  return [
    missing.length && `Нет: ${missing.join(', ')}.`,
    secondary.length && `Только по&nbsp;дополнительной роли: ${secondary.join(', ')}.`,
  ].filter(Boolean).join(' ');
}

async function loadGroups() {
  const current = pollRun;
  try {
    const list = await api('groups', { teacher });
    if (current !== pollRun) return;
    groups = list;
    problem = null;
  } catch (error) {
    if (current !== pollRun) return;
    problem = error.status === 404 ? 'Код учителя не найден. Выйдите и введите код заново.' : 'Нет связи с сервером. Обновите страницу.';
    renderGroups();
    return;
  }
  renderGroupList();
}

async function poll() {
  const current = pollRun;
  try {
    const next = await api('teacher', { code: openCode(), teacher });
    if (current !== pollRun) return;
    view = next;
    problem = null;
  } catch (error) {
    if (current !== pollRun) return;
    if (error.status === 403 || error.status === 404) {
      view = null;
      problem = 'Такой группы нет среди ваших: она удалена через 30 дней или создана с другим кодом учителя.';
      renderLive();
      return;
    }
    problem = 'Нет связи с сервером, пробуем ещё раз…';
  }
  renderLive();
  setTimeout(() => current === pollRun && poll(), POLL_MS);
}

async function copy(target, text, done) {
  try {
    await navigator.clipboard.writeText(text);
    target.textContent = done;
  } catch {
    target.textContent = 'Скопируйте вручную';
  }
}

app.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;

  switch (target.dataset.action) {
    case 'create':
      busy = true;
      target.disabled = true;
      try {
        const created = await api('create', teacher ? { teacher } : {});
        freshTeacher = !teacher;
        teacher = created.teacher;
        saveTeacher();
        groups = null;
        problem = null;
        location.hash = created.code;
      } catch (error) {
        problem = `Не получилось создать группу: ${error.message}`;
        render();
      } finally {
        busy = false;
      }
      break;
    case 'distribute':
      if (view.distributed && !confirm('Пересобрать команды? Составы поменяются, ученики увидят новые.')) return;
      busy = true;
      renderLive();
      try {
        view = await api('distribute', { code: openCode(), teacher, size: teamSize ?? view.size });
        teamSize = null;
        problem = null;
      } catch (error) {
        problem = error.message;
      } finally {
        busy = false;
        renderLive();
      }
      break;
    case 'size-dec':
    case 'size-inc': {
      const step = target.dataset.action === 'size-inc' ? 1 : -1;
      teamSize = Math.min(TEAM_SIZE.max, Math.max(TEAM_SIZE.min, (teamSize ?? view.size) + step));
      renderLive();
      break;
    }
    case 'copy':
      copy(target, studentLink(openCode()), 'Ссылка скопирована');
      break;
    case 'copy-teacher':
      copy(target, teacher, 'Скопировано');
      break;
    case 'code-saved':
      freshTeacher = false;
      render();
      break;
    case 'logout':
      if (!confirm('Выйти на этом устройстве? Вернуться к группам можно будет по коду учителя.')) return;
      teacher = null;
      freshTeacher = false;
      groups = null;
      saveTeacher();
      if (location.hash) location.hash = '';
      else render();
      break;
  }
});

app.addEventListener('submit', async event => {
  if (event.target.id !== 'login') return;
  event.preventDefault();
  const typed = normalizeTeacher(event.target.elements.teacher.value);
  if (!typed) return;
  busy = true;
  renderStart();
  try {
    groups = await api('groups', { teacher: typed });
    teacher = typed;
    saveTeacher();
    loginProblem = null;
  } catch (error) {
    loginProblem = error.status === 404 ? 'Такого кода учителя нет. Проверьте, нет ли опечатки.' : 'Нет связи с сервером, попробуйте ещё раз.';
  } finally {
    busy = false;
  }
  render();
});

window.addEventListener('hashchange', () => {
  problem = null;
  render();
});

render();
