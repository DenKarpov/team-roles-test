'use strict';

// Общее для теста и страницы учителя.

const sum = list => list.reduce((a, b) => a + b, 0);

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Имена приходят от учеников, в разметку они попадают только через эту функцию.
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

async function api(path, { method = 'GET', body, key } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['X-Teacher-Key'] = key;
  const response = await fetch(API_URL + path, { method, headers, body: body && JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : `Ошибка ${response.status}`;
    throw Object.assign(new Error(detail), { status: response.status });
  }
  return data;
}
