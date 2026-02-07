import axios from 'axios';

// Текстовые расширения
const TEXT_EXTENSIONS = ['.xml', '.xsd', '.csv', '.ddl', '.json', '.yml', '.yaml', '.sql'];

const isTextFile = (filename) => {
  return TEXT_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
};

// === УЛУЧШЕННОЕ СРАВНЕНИЕ СТРОК С ПЕРЕСИНХРОНИЗАЦИЕЙ ===
const diffLines = (oldLines, newLines) => {
  const result = [];
  let i = 0, j = 0;

  const MAX_LOOKAHEAD = 30; // Максимум на сколько строк вперёд искать совпадение

  while (i < oldLines.length || j < newLines.length) {
    // Если строки совпадают — просто идём дальше
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push({ type: 'same', value: oldLines[i] });
      i++;
      j++;
      continue;
    }

    let foundMatch = false;

    // === Проверка: возможно, вставлено несколько строк (ищем вперёд в newLines) ===
    const currentOldLine = oldLines[i]?.trim();
    if (currentOldLine) {
      for (let k = 1; k <= MAX_LOOKAHEAD && j + k < newLines.length; k++) {
        if (newLines[j + k].trim() === currentOldLine) {
          // Нашли совпадение — значит, строки с j до j+k были добавлены
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

    // === Проверка: возможно, удалено несколько строк (ищем вперёд в oldLines) ===
    const currentNewLine = newLines[j]?.trim();
    if (currentNewLine) {
      for (let k = 1; k <= MAX_LOOKAHEAD && i + k < oldLines.length; k++) {
        if (oldLines[i + k].trim() === currentNewLine) {
          // Нашли — значит, строки с i до i+k были удалены
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

    // === Стандартное поведение, если ничего не найдено ===
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

// === ИЗВЛЕЧЕНИЕ ТЕКСТОВЫХ ФАЙЛОВ ИЗ ZIP ===
const extractAllTextFiles = async (arrayBuffer, label) => {
  try {
    const { ZipReader, BlobReader, BlobWriter } = await import('@zip.js/zip.js');
    const blob = new Blob([arrayBuffer], { type: 'application/zip' });
    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();

    if (entries.length === 0) {
      await reader.close();
      return {};
    }

    const files = {};

    for (const entry of entries) {
      if (!entry.directory && isTextFile(entry.filename)) {
        // Удаляем ВСЕ вхождения папок вида "2024-01-01", "2025-02-02" и т.п.
        let relativePath = entry.filename.replace(/\/\d{4}-\d{2}-\d{2}\//g, '/');

        // Удаляем первую папку (например, "final_6_1_0_5/", "v2/", "release_2025/" и т.п.)
        relativePath = relativePath.replace(/^[^\/]+\/?/, '');

        // Убираем начальные слэши, если остались
        relativePath = relativePath.replace(/^\/+/, '');

        try {
          const blob = await entry.getData(new BlobWriter());
          const text = await blob.text();
          files[relativePath] = text;
        } catch (err) {
          files[relativePath] = null;
        }
      }
    }

    await reader.close();
    return files;
  } catch (err) {
    console.error(`❌ Ошибка при извлечении из ${label}:`, err.message);
    return {};
  }
};

// === ОСНОВНОЙ ОБРАБОТЧИК ===
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  try {
    const { old_url, new_url } = req.body;

    if (!old_url || !new_url) {
      return res.status(400).json({ error: 'Не хватает old_url или new_url' });
    }

    console.log('📥 Генерация детального отчёта:', { old_url, new_url });

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

    // === ГЕНЕРАЦИЯ CSV ===
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

    // === ОТПРАВКА В GITHUB GIST ===
    const GIST_TOKEN = process.env.GITHUB_GIST_TOKEN;

    if (!GIST_TOKEN) {
      return res.status(500).json({
        error: 'GITHUB_GIST_TOKEN не настроен',
        message: 'Не удалось создать отчёт. Обратитесь к администратору.'
      });
    }

    const gistResponse = await axios.post('https://api.github.com/gists', {
      description: 'CBR XBRL-CSV Diff Report',
      public: true,
      files: {
        'xbrl-changes.csv': {
          content: csv
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'User-Agent': 'cbr-xbrl-checker'
      }
    });

    const gistUrl = gistResponse.data.html_url;

    // === ОТВЕТ ===
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
    console.error('💥 Ошибка при генерации детального отчёта:', error.message);
    return res.status(500).json({
      error: 'Не удалось создать отчёт',
      message: error.message
    });
  }
}
