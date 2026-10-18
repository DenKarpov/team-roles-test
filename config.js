'use strict';

// Бэкенд групп (FastAPI на Vercel, код в api/). Локально — uvicorn на 8001.
const API_URL = location.hostname === 'localhost' ? 'http://localhost:8001' : 'https://team-roles-test.vercel.app';
