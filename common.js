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

// Бэкенд — Google Apps Script (gas/Code.js): один адрес, POST с телом { action, ... }.
// Тело уходит как text/plain и без своих заголовков: на CORS-preflight Apps Script не отвечает.
// Коды ответа он тоже не отдаёт, поэтому ошибка приходит в теле.
async function api(action, params = {}) {
  const response = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ action, ...params }) });
  const result = await response.json().catch(() => null);
  if (!result) throw Object.assign(new Error(`Ошибка ${response.status}`), { status: response.status });
  if (!result.ok) throw Object.assign(new Error(result.error), { status: result.status });
  return result.data;
}
