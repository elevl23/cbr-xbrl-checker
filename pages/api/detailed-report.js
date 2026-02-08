import axios from 'axios';
import { ZipReader, BlobReader, BlobWriter } from '@zip.js/zip.js';

// Текстовые расширения
const TEXT_EXTENSIONS = ['.xml', '.xsd', '.csv', '.ddl', '.json', '.yml', '.yaml', '.sql'];

const isTextFile = (filename) => {
  return TEXT_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
};

// === УЛУЧШЕННОЕ СРАВНЕНИЕ СТРОК С ПЕРЕСИНХРОНИЗАЦИЕЙ ===
const diffLines = (oldLines, newLines) => {
  const result = [];
  let i = 0, j = 0;
  const MAX_LOOKAHEAD = 30;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push({ type: 'same', value: oldLines[i] });
      i++; j++;
      continue;
    }

    let foundMatch = false;

    // Ищем вперёд: возможно, вставлены строки
    const oldLine = oldLines[i]?.trim();
    if (oldLine) {
      for (let k = 1; k <= MAX_LOOKAHEAD && j + k < newLines.length; k++) {
        if (newLines[j + k].trim() === oldLine) {
          while (j < j + k) {
            result.push({ type: 'added', value: newLines[j] });
            j++;
          }
          foundMatch = true;
          break;
        }
      }
    }

    if (foundMatch) continue;

    // Ищем вперёд: возможно, удалены строки
    const newLine = newLines[j]?.trim();
    if (newLine) {
      for (let k = 1; k <= MAX_LOOKAHEAD && i + k < oldLines.length; k++) {
        if (oldLines[i + k].trim() === newLine) {
          while (i < i + k) {
            result.push({ type: 'removed', value: oldLines[i] });
            i++;
          }
          foundMatch = true;
          break;
        }
      }
    }

    if (foundMatch) continue;

    // Стандартное поведение
    if (j < newLines.length) {
      result.push({ type: 'added', value: newLines[j] });
      j++;
    } else if (i < oldLines.length) {
      result.push({ type: 'removed', value: oldLines[i] });
      i++;
    }
  }

  return result;
};

// === ИЗВЛЕЧЕНИЕ ТЕКСТОВЫХ ФАЙЛОВ ===
const extractAllTextFiles = async (arrayBuffer, label) => {
  try {
    const blob = new Blob([arrayBuffer], { type: 'application/zip' });
    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();

    if (entries.length === 0) {
      await reader.close();
      return {};
    }

    let rootFolder = '';
    const firstSlash = entries[0].filename.indexOf('/');
    if (firstSlash > 0) {
      rootFolder = entries[0].filename.substring(0, firstSlash) + '/';
    }

    const files = {};

    for (const entry of entries) {
      if (!entry.directory && isTextFile(entry.filename)) {
        const relativePath = rootFolder ? entry.filename.replace(rootFolder, '') : entry.filename;
        try {
          const blob = await entry.getData(new BlobWriter());
          const text = await blob.text();
          files[relativePath] = text;
        } catch (err) {
          console.error(`❌ Ошибка чтения файла ${entry.filename}:`, err.message);
          files[relativePath] = null;
        }
      }
    }

    await reader.close();
    return files;
  } catch (err) {
    console.error(`❌ Ошибка извлечения из ${label}:`, err.message);
    return {};
  }
};

// === ОСНОВНОЙ ОБРАБОТЧИК ===
export default async function handler(req, res) {
  console.log('🔧 Метод:', req.method);
  console.log('🔧 Заголовки:', req.headers['content-type']);
  console.log('🔧 Тело (сырое):', JSON.stringify(req.body, null, 2));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не поддерживается. Используйте POST.' });
  }

  try {
    // Защита от пустого body
    if (!req.body) {
      console.log('❌ req.body отсутствует');
      return res.status(400).json({ error: 'Тело запроса отсутствует' });
    }

    // Dify может обернуть: { body: { old_url, new_url } }
    let payload = req.body;
    if (payload.body && typeof payload.body === 'object') {
      payload = payload.body;
    }

    const { old_url, new_url } = payload;

    if (!old_url || !new_url) {
      console.log('❌ Не хватает old_url или new_url');
      return res.status(400).json({ error: 'Не хватает old_url или new_url' });
    }

    console.log('📥 Сравнение:', { old_url, new_url });

    const download = async (url, label) => {
      try {
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': 'CBR-Checker/1.0' },
          timeout: 20000,
          maxContentLength: 15 * 1024 * 1024
        });
        console.log(`✅ ${label} скачан, размер: ${response.data.byteLength}`);
        return response.data;
      } catch (err) {
        console.error(`❌ Ошибка при скачивании ${label}:`, err.message);
        throw new Error(`Не удалось скачать ${label}`);
      }
    };

    const oldArrayBuffer = await download(old_url, 'старый ZIP');
    const newArrayBuffer = await download(new_url, 'новый ZIP');

    const oldFiles = await extractAllTextFiles(oldArrayBuffer, 'старого архива');
    const newFiles = await extractAllTextFiles(newArrayBuffer, 'нового архива');

    const changes = [];

    // Удалённые файлы
    for (const name of Object.keys(oldFiles)) {
      if (!newFiles[name]) {
        changes.push({ type: 'deleted', file: name });
      }
    }

    // Новые файлы
    for (const name of Object.keys(newFiles)) {
      if (!oldFiles[name]) {
        changes.push({ type: 'added', file: name });
      }
    }

    // Изменённые файлы
    for (const name of Object.keys(newFiles)) {
      if (oldFiles[name] && oldFiles[name] !== newFiles[name]) {
        const oldLines = oldFiles[name].split('\n');
        const newLines = newFiles[name].split('\n');
        const diff = diffLines(oldLines, newLines);
        changes.push({ type: 'modified', file: name, diff });
      }
    }

    // Генерация CSV
    const jsonToCsv = (changes) => {
      const separator = ',';
      const header = ['type', 'file', 'change_type', 'line'].join(separator);
      const rows = changes.flatMap(item => {
        if (item.type === 'modified') {
          return item.diff.map(d => {
            const changeType = d.type === 'same' ? 'без изменений' : d.type;
            return `"${item.type}","${item.file}","${changeType}","${d.value.replace(/"/g, '""')}"`;
          });
        } else {
          return [`"${item.type}","${item.file}","-","-"`];
        }
      });
      return [header, ...rows].join('\n');
    };

    const csv = jsonToCsv(changes);

    // Отправка в Gist
    const GIST_TOKEN = process.env.GITHUB_GIST_TOKEN;

    if (!GIST_TOKEN) {
      console.log('❌ GITHUB_GIST_TOKEN не настроен');
      return res.status(500).json({
        error: 'GITHUB_GIST_TOKEN не настроен',
        message: 'Обратитесь к администратору.'
      });
    }

    const gistResponse = await axios.post('https://api.github.com/gists', {
      description: 'CBR XBRL-CSV Diff Report',
      public: true,
      files: {
        'xbrl-changes.csv': { content: csv }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'User-Agent': 'cbr-xbrl-checker'
      }
    });

    const gistUrl = gistResponse.data.html_url;

    // Ответ
    return res.status(200).json({
      summary: {
        total_changes: changes.length,
        added: changes.filter(c => c.type === 'added').length,
        deleted: changes.filter(c => c.type === 'deleted').length,
        modified: changes.filter(c => c.type === 'modified').length
      },
      report_url: gistUrl,
      message: 'Готово. Полный отчёт доступен по ссылке.'
    });

  } catch (error) {
    console.error('💥 Ошибка:', error.message);
    return res.status(500).json({
      error: 'Не удалось создать отчёт',
      message: error.message
    });
  }
}
