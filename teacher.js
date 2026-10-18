'use strict';

const STORAGE_KEY = 'team-roles-teacher-v2';
const POLL_MS = 5000;

const app = document.getElementById('app');

// Код учителя — единственный доступ к его группам. Браузер его помнит, на другом устройстве
// учитель вводит код сам. В адресе страницы только код группы (#КОД), он не секретный:
// ссылку на эту страницу можно пересылать коллегам — своих групп они не увидят.
let teacher = loadTeacher();
let freshTeacher = false;
let groups = null;
let view = null;
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
      <p class="lead">Ученики проходят тест, а&nbsp;вы одной кнопкой делите их на&nbsp;команды по&nbsp;трое так, чтобы роли в&nbsp;команде дополняли друг друга.</p>

      <div class="card rules">
        <h2>Как это работает</h2>
        <ol>
          <li>Вы создаёте группу и&nbsp;показываете QR-код. Ученики сканируют его, вводят имя и&nbsp;проходят тест — 5–7&nbsp;минут.</li>
          <li>Вы видите, кто уже прошёл. Когда прошли все, нажимаете «Распределить».</li>
          <li>Каждый видит свою команду у&nbsp;себя на&nbsp;экране. Кто закончит позже, сам попадёт в&nbsp;одну из&nbsp;команд.</li>
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
    ? `<ul class="card people group-list">
        ${groups.map(group => `
          <li>
            <a href="#${escapeHtml(group.code)}">
              <span><strong>Группа ${escapeHtml(group.code)}</strong><small>${formatDate(group.created)}</small></span>
              <span class="status${group.distributed ? ' is-done' : ''}">${group.distributed
                ? 'команды собраны'
                : group.members ? `прошли ${group.finished} из&nbsp;${group.members}` : 'пока никого'}</span>
            </a>
          </li>`).join('')}
      </ul>`
    : '<p class="notice">Пока нет групп. Группы хранятся 30&nbsp;дней.</p>';
}

function renderTeacherCode() {
  return `
    <div class="card teacher-code${freshTeacher ? ' is-fresh' : ''}">
      <p class="team-label">${freshTeacher ? 'Запишите код учителя' : 'Ваш код учителя'}</p>
      <p class="code-value">${escapeHtml(teacher)}</p>
      <p class="code-note">По нему вы вернётесь к своим группам с&nbsp;другого устройства. Ученикам его не показывайте.</p>
      <div class="code-actions">
        <button type="button" class="button button-plain" data-action="copy-teacher">Скопировать код</button>
        <button type="button" class="button button-plain" data-action="logout">Выйти на&nbsp;этом устройстве</button>
      </div>
    </div>`;
}

function renderGroup() {
  const code = openCode();
  app.innerHTML = `
    <section>
      <p class="back"><a href="#">← Ваши группы</a></p>
      <p class="eyebrow">Учителю</p>
      <h1>Группа ${escapeHtml(code)}</h1>
      <p class="lead">Покажите ученикам QR-код. Они пройдут тест, а&nbsp;вы соберёте из&nbsp;них команды.</p>

      ${freshTeacher ? renderTeacherCode() : ''}

      <div class="card invite">
        <div class="qr">${qrSvg(studentLink(code))}</div>
        <div class="invite-text">
          <p>Наведите камеру телефона на&nbsp;код или откройте ссылку:</p>
          <p class="invite-link">${escapeHtml(studentLink(code))}</p>
          <button type="button" class="button button-plain" data-action="copy">Скопировать ссылку</button>
        </div>
      </div>

      <div id="live"></div>
    </section>`;
  renderLive();
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

    <div class="actions">
      <button type="button" class="button" data-action="distribute"${done && !busy ? '' : ' disabled'}>${view.distributed ? 'Пересобрать команды' : 'Распределить'}</button>
    </div>
    ${notice()}

    ${view.teams.length ? renderTeams() : ''}`;
}

function renderTeams() {
  return `
    <h2 class="section-title">${view.teams.length} ${plural(view.teams.length, 'команда', 'команды', 'команд')}</h2>
    <p class="section-lead">Ученики видят свою команду у&nbsp;себя на&nbsp;экране. Кто закончит тест позже, сам попадёт в&nbsp;одну из&nbsp;команд.</p>
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
        view = await api('distribute', { code: openCode(), teacher });
        problem = null;
      } catch (error) {
        problem = error.message;
      } finally {
        busy = false;
        renderLive();
      }
      break;
    case 'copy':
      copy(target, studentLink(openCode()), 'Ссылка скопирована');
      break;
    case 'copy-teacher':
      copy(target, teacher, 'Код скопирован');
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
