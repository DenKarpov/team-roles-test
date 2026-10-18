// Запускает gas/Code.js в Node с заглушками сервисов Apps Script — для тестов и локального сервера.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadBackend() {
  const props = new Map();
  const context = vm.createContext({
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => Object.fromEntries(props),
        setProperty: (key, value) => { props.set(key, String(value)); },
        setProperties: values => Object.entries(values).forEach(([key, value]) => props.set(key, String(value))),
        deleteProperty: key => { props.delete(key); },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: randomUUID,
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      // Как в Apps Script: массив байтов со знаком, −128…127.
      computeDigest: (algorithm, value, charset) =>
        [...createHash(algorithm).update(value, charset).digest()].map(b => (b > 127 ? b - 256 : b)),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ text, setMimeType() { return this; } }),
    },
  });
  vm.runInContext(readFileSync(new URL('../gas/Code.js', import.meta.url), 'utf8'), context);

  // Ответ — как его получит браузер: { ok, data } или { ok: false, status, error }.
  const call = (action, params = {}) =>
    JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ action, ...params }) } }).text);
  return { backend: context, props, call };
}
