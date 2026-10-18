// Локальный бэкенд на порту 8001: node tests/dev-server.mjs
// Ведёт себя как Apps Script: ответ всегда 200, на CORS-preflight не отвечает.
// Сайт — python3 -m http.server 8000, config.js на localhost сам ходит сюда.

import http from 'node:http';
import { loadBackend } from './gas.mjs';

const { backend } = loadBackend();

http.createServer((request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const output = backend.doPost({ postData: { contents: body } });
    response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end(output.text);
  });
}).listen(8001, () => console.log('backend on http://localhost:8001'));
