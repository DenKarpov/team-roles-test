'use strict';

const TOTAL = 10;
const STORAGE_KEY = 'team-roles-v1';

const GROUPS = [
  { title: 'Основные',            note: 'Так вы ведёте себя в команде чаще всего.' },
  { title: 'Дополнительные',      note: 'Можете взять на себя, но они выражены слабее.' },
  { title: 'Наименее выраженные', note: 'Не слабые места: такое поведение просто менее естественно и требует больше усилий.' },
];

const app = document.getElementById('app');
const stepLabel = document.getElementById('step');
const progress = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');

let state = load() || newState();

function newState() {
  return {
    screen: 'intro',
    block: 0,
    order: BLOCKS.map(block => shuffle(block.map((_, i) => i))),
    points: BLOCKS.map(block => block.map(() => 0)),
  };
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const fits = saved && [saved.order, saved.points].every(
      list => Array.isArray(list) && list.length === BLOCKS.length && list.every(block => block.length === BLOCKS[0].length)
    );
    return fits ? saved : null;
  } catch {
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Без localStorage тест работает, просто не переживает перезагрузку.
  }
}

const sum = list => list.reduce((a, b) => a + b, 0);

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const formatPoints = n => `${n} ${plural(n, 'балл', 'балла', 'баллов')}`;

function joinRu(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} и ${items.at(-1)}`;
}

function scoreRoles() {
  const scores = Object.fromEntries(Object.keys(ROLES).map(code => [code, 0]));
  BLOCKS.forEach((block, b) => block.forEach(([code], i) => { scores[code] += state.points[b][i]; }));
  return scores;
}

// Места как в спорте: равные баллы делят одно место (1, 2, 2, 4).
// Группа берётся по месту: 1–3 основные, 4–6 дополнительные, дальше наименее выраженные.
// Роль, которой не дали ни балла, всегда в наименее выраженных.
function rankRoles(scores) {
  const codes = Object.keys(ROLES).sort((a, b) => scores[b] - scores[a]);
  let place = 0;
  return codes.map((code, i) => {
    if (i === 0 || scores[code] !== scores[codes[i - 1]]) place = i + 1;
    const group = scores[code] === 0 ? 2 : place <= 3 ? 0 : place <= 6 ? 1 : 2;
    return { code, score: scores[code], place, group };
  });
}

// Должности подбираются по основным ролям; у проджекта их три, у разработчика две.
function pickPositions(ranked) {
  const picked = [];
  ranked.filter(role => role.group === 0).forEach(({ code }) => {
    const position = POSITIONS.find(p => p.roles.includes(code));
    const entry = picked.find(p => p.position === position);
    if (entry) entry.via.push(code);
    else picked.push({ position, via: [code] });
  });
  return picked;
}

function render() {
  const inBlock = state.screen === 'block';
  document.body.dataset.screen = state.screen;
  stepLabel.textContent = inBlock ? `Блок ${state.block + 1} из ${BLOCKS.length}` : '';
  progress.hidden = !inBlock;
  progressFill.style.width = `${((state.block + 1) / BLOCKS.length) * 100}%`;

  if (inBlock) renderBlock();
  else if (state.screen === 'result') renderResult();
  else renderIntro();
}

function renderIntro() {
  const started = state.points.some(block => sum(block) > 0);
  app.innerHTML = `
    <section>
      <p class="eyebrow">Проектная деятельность</p>
      <h1>Командные роли</h1>
      <p class="lead">Тест по модели Белбина. Показывает, какие роли в&nbsp;команде вам ближе всего и&nbsp;какую работу в&nbsp;проекте стоит взять на&nbsp;себя.</p>

      <dl class="facts">
        <div><dt>5</dt><dd>блоков</dd></div>
        <div><dt>45</dt><dd>утверждений</dd></div>
        <div><dt>5–7</dt><dd>минут</dd></div>
      </dl>

      <div class="card rules">
        <h2>Как отвечать</h2>
        <ol>
          <li>В каждом блоке выберите утверждения, которые описывают ваше обычное поведение в&nbsp;команде. Одно или несколько.</li>
          <li>Распределите между ними 10&nbsp;баллов, каждому выбранному — минимум 1.</li>
          <li>Чем точнее утверждение про вас, тем больше баллов. Например: 4&nbsp;+&nbsp;3&nbsp;+&nbsp;2&nbsp;+&nbsp;1.</li>
        </ol>
      </div>

      <div class="actions">
        <button type="button" class="button" data-action="start">${started ? 'Продолжить' : 'Начать'}</button>
        ${started ? '<button type="button" class="button button-plain" data-action="restart">Начать заново</button>' : ''}
      </div>
    </section>`;
}

function renderBlock() {
  const b = state.block;
  const isLast = b === BLOCKS.length - 1;
  app.innerHTML = `
    <section>
      <h1>Блок ${b + 1}</h1>
      <p class="lead">Распределите 10&nbsp;баллов между утверждениями, которые лучше всего описывают вас в&nbsp;команде.</p>
      <ul class="card statements">
        ${state.order[b].map(i => `
          <li class="statement" data-index="${i}">
            <p class="statement-text">${BLOCKS[b][i][1]}</p>
            <div class="statement-control">
              <output class="statement-value"></output>
              <div class="stepper" role="group" aria-label="Баллы">
                <button type="button" data-action="dec" aria-label="Убрать балл">−</button>
                <button type="button" data-action="inc" aria-label="Добавить балл">+</button>
              </div>
            </div>
          </li>`).join('')}
      </ul>
    </section>

    <div class="bottombar">
      <div class="bottombar-inner">
        <div class="meter">
          <span class="meter-label" id="meter-label" aria-live="polite"></span>
          <span class="meter-cells" aria-hidden="true">${'<i></i>'.repeat(TOTAL)}</span>
        </div>
        <div class="nav">
          <button type="button" class="button button-plain" data-action="back">Назад</button>
          <button type="button" class="button" data-action="next" id="next">${isLast ? 'Результат' : 'Далее'}</button>
        </div>
      </div>
    </div>`;
  updateBlock();
}

function updateBlock() {
  const values = state.points[state.block];
  const left = TOTAL - sum(values);

  app.querySelectorAll('.statement').forEach(row => {
    const value = values[row.dataset.index];
    row.classList.toggle('is-selected', value > 0);
    row.querySelector('.statement-value').textContent = value;
    row.querySelector('[data-action="dec"]').disabled = value === 0;
    row.querySelector('[data-action="inc"]').disabled = left === 0;
  });

  app.querySelectorAll('.meter-cells i').forEach((cell, i) => cell.classList.toggle('is-filled', i < TOTAL - left));
  document.getElementById('meter-label').textContent =
    left === TOTAL ? 'Распределите 10 баллов' : left === 0 ? 'Все баллы распределены' : `Осталось ${formatPoints(left)}`;
  document.getElementById('next').disabled = left !== 0;
}

function renderResult() {
  const ranked = rankRoles(scoreRoles());
  const max = Math.max(...ranked.map(role => role.score));
  const lead = ranked.filter(role => role.group === 0).map(role => ROLES[role.code].name.toLowerCase());

  app.innerHTML = `
    <section>
      <p class="eyebrow">Результат</p>
      <h1>Ваш профиль</h1>
      <p class="lead">${lead.length > 1 ? 'Ведущие роли' : 'Ведущая роль'} — ${joinRu(lead)}.</p>

      <div class="card profile">
        ${GROUPS.map((group, g) => {
          const roles = ranked.filter(role => role.group === g);
          if (!roles.length) return '';
          return `
            <div class="group">
              <h2 class="group-title">${group.title}</h2>
              <p class="group-note">${group.note}</p>
              ${roles.map(role => `
                <div class="bar-row${g === 0 ? ' is-lead' : ''}">
                  <span class="bar-place">${role.place}</span>
                  <div class="bar-name">
                    <strong>${ROLES[role.code].name}</strong><span class="code">${role.code}</span>
                    <small>${ROLES[role.code].about}</small>
                  </div>
                  <div class="bar-track"><div class="bar" style="width: ${max ? (role.score / max) * 100 : 0}%"></div></div>
                  <span class="bar-value">${role.score}</span>
                </div>`).join('')}
            </div>`;
        }).join('')}
      </div>
      <p class="footnote">Баллы — сумма по пяти блокам, всего 50. Равные баллы делят одно место.</p>

      <h2 class="section-title">Роли в проекте</h2>
      <p class="section-lead">Подобраны по основным ролям.</p>
      <ul class="card positions">
        ${pickPositions(ranked).map(({ position, via }) => `
          <li>
            <div>
              <strong>${position.name}</strong>
              <small>${position.about}</small>
            </div>
            <span class="via">${via.map(code => ROLES[code].name).join(', ')}</span>
          </li>`).join('')}
      </ul>

      <div class="actions">
        <button type="button" class="button" data-action="restart">Пройти заново</button>
      </div>
    </section>`;
}

function go(screen, block = state.block) {
  state.screen = screen;
  state.block = block;
  save();
  render();
  window.scrollTo(0, 0);
}

app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;

  switch (target.dataset.action) {
    case 'inc':
    case 'dec': {
      const values = state.points[state.block];
      const index = target.closest('.statement').dataset.index;
      const next = values[index] + (target.dataset.action === 'inc' ? 1 : -1);
      if (next < 0 || sum(values) - values[index] + next > TOTAL) return;
      values[index] = next;
      save();
      updateBlock();
      break;
    }
    case 'start':
      go('block');
      break;
    case 'restart':
      state = newState();
      go('block', 0);
      break;
    case 'back':
      if (state.block === 0) go('intro');
      else go('block', state.block - 1);
      break;
    case 'next':
      if (state.block === BLOCKS.length - 1) go('result');
      else go('block', state.block + 1);
      break;
  }
});

render();
