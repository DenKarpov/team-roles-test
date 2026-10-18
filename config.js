'use strict';

// Бэкенд групп — веб-приложение Google Apps Script (код в gas/, деплой через clasp).
// На localhost — эмулятор из tests/dev-server.mjs.
const API_URL = location.hostname === 'localhost'
  ? 'http://localhost:8001'
  : 'https://script.google.com/macros/s/AKfycbyFlno7mTS6T8_VgBJF3pNbqM0PPWBAYIiL-OLNibYnnJn3d-bRvVAO-hXGz560O397JA/exec';
