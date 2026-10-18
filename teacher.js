'use strict';

const STORAGE_KEY = 'team-roles-teacher-v1';
const POLL_MS = 4000;

const app = document.getElementById('app');

// Группа учителя: код и ключ. Ключ лежит и в адресе страницы (#КОД.ключ), поэтому
// страницу можно открыть на другом устройстве — например, на компьютере с проектором.
let group = fromHash() || loadGroup();
let view = null;
let problem = null;
let busy = false;
let pollRun = 0;

function fromHash() {
  const [code, key] = location.hash.slice(1).split('.');
  return code && key ? { code: code.toUpperCase(), key } : null;
}

function loadGroup() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveGroup() {
  try {
    if (group) localStorage.setItem(STORAGE_KEY, JSON.stringify(group));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Без localStorage группа держится в адресе страницы.
  }
  history.replaceState(null, '', group ? `#${group.code}.${group.key}` : location.pathname);
}

const studentLink = () => new URL(`./?g=${group.code}`, location.href).href;

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true, alt: 'QR-код со ссылкой на тест' });
}

function render() {
  if (!group) {
    renderStart();
    return;
  }
  app.innerHTML = `
    <section>
      <p class="eyebrow">Учителю</p>
      <h1>Группа ${escapeHtml(group.code)}</h1>
      <p class="lead">Покажите ученикам QR-код. Они пройдут тест, а&nbsp;вы соберёте из&nbsp;них команды.</p>

      <div class="card invite">
        <div class="qr">${qrSvg(studentLink())}</div>
        <div class="invite-text">
          <p>Наведите камеру телефона на&nbsp;код или откройте ссылку:</p>
          <p class="invite-link">${escapeHtml(studentLink())}</p>
          <button type="button" class="button button-plain" data-action="copy">Скопировать ссылку</button>
        </div>
      </div>

      <div id="live"></div>

      <div class="actions">
        <button type="button" class="button button-plain" data-action="new">Новая группа</button>
      </div>
    </section>`;
  renderLive();
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
      ${problem ? `<p class="notice">${escapeHtml(problem)}</p>` : ''}
    </section>`;
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
    ${problem ? `<p class="notice">${escapeHtml(problem)}</p>` : ''}

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

async function poll() {
  const current = ++pollRun;
  try {
    const next = await api(`/api/groups/${group.code}`, { key: group.key });
    if (current !== pollRun) return;
    view = next;
    problem = null;
  } catch (error) {
    if (current !== pollRun) return;
    if (error.status === 403 || error.status === 404) {
      view = null;
      problem = 'Группа не найдена: ссылка неверная или группа старше 30 дней. Создайте новую.';
      renderLive();
      return;
    }
    problem = 'Нет связи с сервером, пробуем ещё раз…';
  }
  renderLive();
  setTimeout(() => current === pollRun && group && poll(), POLL_MS);
}

app.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;

  switch (target.dataset.action) {
    case 'create':
      busy = true;
      renderStart();
      try {
        group = await api('/api/groups', { method: 'POST' });
        problem = null;
        saveGroup();
        view = null;
        render();
        poll();
      } catch (error) {
        problem = `Не получилось создать группу: ${error.message}`;
      } finally {
        busy = false;
        if (!group) renderStart();
      }
      break;
    case 'distribute':
      if (view.distributed && !confirm('Пересобрать команды? Составы поменяются, ученики увидят новые.')) return;
      busy = true;
      renderLive();
      try {
        view = await api(`/api/groups/${group.code}/distribute`, { method: 'POST', key: group.key });
        problem = null;
      } catch (error) {
        problem = error.message;
      } finally {
        busy = false;
        renderLive();
      }
      break;
    case 'copy':
      try {
        await navigator.clipboard.writeText(studentLink());
        target.textContent = 'Ссылка скопирована';
      } catch {
        target.textContent = 'Скопируйте ссылку вручную';
      }
      break;
    case 'new':
      if (!confirm('Начать новую группу? К этой можно будет вернуться только по адресу этой страницы.')) return;
      pollRun++;
      group = null;
      view = null;
      problem = null;
      saveGroup();
      render();
      break;
  }
});

saveGroup();
render();
if (group) poll();
