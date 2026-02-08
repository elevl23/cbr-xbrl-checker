import axios from 'axios';
import { ZipReader, BlobReader, BlobWriter } from '@zip.js/zip.js';

// Текстовые расширения
const TEXT_EXTENSIONS = ['.xml', '.xsd', '.csv', '.ddl', '.json', '.yml', '.yaml', '.sql'];

const isTextFile = (filename) => {
  return TEXT_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
};

// === НОРМАЛИЗАЦИЯ СТРОКИ ===
const normalizeLine = (line) => {
  if (!line) return '';
  return line
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\ufeff/g, '') // BOM
    .replace(/\s+/g, ' ')   // множественные пробелы → один
    .trim();
};

// === АНАЛИЗ СТРОКИ (для отладки) ===
const analyzeLine = (line) => {
  if (!line) return {};
  return {
    length: line.length,
    has_crlf: line.includes('\r'),
    has_bom: line.includes('\ufeff'),
    whitespace_count: (line.match(/\s/g) || []).length,
    normalized: normalizeLine(line)
  };
};

// === УЛУЧШЕННОЕ СРАВНЕНИЕ СТРОК С ПЕРЕСИНХРОНИЗАЦИЕЙ И ИНДЕКСАМИ ===
const diffLines = (oldLines, newLines) => {
  const result = [];
  let i = 0, j = 0;
  const MAX_LOOKAHEAD = 50; // Увеличили на случай больших сдвигов

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length) {
      const oldLine = oldLines[i];
      const newLine = newLines[j];

      if (normalizeLine(oldLine) === normalizeLine(newLine)) {
        result.push({ type: 'same', value: oldLine, index: i });
        i++; j++;
        continue;
      }
    }

    let foundMatch = false;

    // Ищем вперёд: возможно, строки добавлены (вставка)
    const currentOldLine = oldLines[i]?.trim();
    if (currentOldLine) {
      for (let k = 1; k <= MAX_LOOKAHEAD && j + k < newLines.length; k++) {
        if (newLines[j + k].trim() === currentOldLine) {
          const target = j + k;
          while (j < target) {
            result.push({ type: 'added', value: newLines[j], index: j });
            j++;
          }
          foundMatch = true;
          break;
        }
      }
    }

    if (foundMatch) continue;

    // Ищем вперёд: возможно, строки удалены (удаление блока)
    const currentNewLine = newLines[j]?.trim();
    if (currentNewLine) {
      for (let k = 1; k <= MAX_LOOKAHEAD && i + k < oldLines.length; k++) {
        if (oldLines[i + k].trim() === currentNewLine) {
          const target = i + k;
          while (i < target) {
            result.push({ type: 'removed', value: oldLines[i], index: i });
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
      result.push({ type: 'added', value: newLines[j], index: j });
      j++;
    } else if (i < oldLines.length) {
      result.push({ type: 'removed', value: oldLines[i], index: i });
      i++;
    }
  }

  return result;
};

// === ИЗВЛЕЧЕНИЕ ТЕКСТОВЫХ ФАЙЛОВ ===
const extractAllTextFiles = async (arrayBuffer, label) => {
  try {
    console.log(`🔍 Начало обработки: ${label}, размер: ${arrayBuffer.byteLength}`);

    const blob = new Blob([arrayBuffer], { type: 'application/zip' });
    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();

    if (!entries || entries.length === 0) {
      await reader.close();
      return {};
    }

    const files = {};

    for (const entry of entries) {
      try {
        // --- Полная защита ---
        if (!entry) {
          console.warn('⚠️ entry === undefined');
          continue;
        }

        if (!entry.filename) {
          console.warn('⚠️ Пропущена: нет имени файла', entry);
          continue;
        }

        if (typeof entry.filename !== 'string') {
          console.warn('⚠️ Пропущена: filename не строка', entry);
          continue;
        }

        if (entry.directory) {
          console.log('🗂️ Папка — пропускаем:', entry.filename);
          continue;
        }

        if (!isTextFile(entry.filename)) {
          console.log('📄 Не текстовый — пропускаем:', entry.filename);
          continue;
        }

        let relativePath = entry.filename;

        // --- Нормализация пути ---
        try {
          relativePath = relativePath.replace(/\/\d{4}-\d{2}-\d{2}\//g, '/');
          relativePath = relativePath.replace(/^[^\/]+\/?/, '');
          relativePath = relativePath.replace(/^\/+/, '');

          if (!relativePath || typeof relativePath !== 'string') {
            throw new Error('relativePath пуст или не строка');
          }
        } catch (err) {
          console.error('❌ Ошибка нормализации пути:', entry.filename, err.message);
          continue;
        }

        // --- Извлечение данных ---
        if (typeof entry.getData !== 'function') {
          console.error('❌ getData — не функция', entry);
          files[relativePath] = null;
          continue;
        }

        const blob = await entry.getData(new BlobWriter());
        if (!blob || typeof blob.text !== 'function') {
          console.error('❌ blob — не валидный', entry.filename);
          files[relativePath] = null;
          continue;
        }

        const text = await blob.text();
        files[relativePath] = text;
        console.log('✅ Успешно извлечено:', relativePath);

      } catch (err) {
        console.error('❌ Ошибка при обработке файла:', err.message, entry);
        continue; // не останавливаем весь цикл
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
  console.log('🔧 Метод:', req.method);
  console.log('🔧 Заголовки:', req.headers['content-type']);
  console.log('🔧 Тело (сырое):', JSON.stringify(req.body, null, 2));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не поддерживается. Используйте POST.' });
  }

  try {
    if (!req.body) {
      return res.status(400).json({ error: 'Тело запроса отсутствует' });
    }

    // Dify может обернуть тело
    let payload = req.body;
    if (payload.body && typeof payload.body === 'object') {
      payload = payload.body;
    }

    const { old_url, new_url } = payload;

    if (!old_url || !new_url) {
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

    // --- Защита от undefined ---
    if (!oldFiles || !newFiles) {
      console.error('❌ oldFiles или newFiles — undefined', { oldFiles, newFiles });
      return res.status(500).json({
        error: 'Ошибка при извлечении файлов',
        message: 'Один из архивов не был распакован'
      });
    }

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
  const oldContent = oldFiles[name];
  const newContent = newFiles[name];

  if (
    typeof oldContent === 'string' &&
    typeof newContent === 'string' &&
    oldContent !== newContent
  ) {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const diff = diffLines(oldLines, newLines);

    const realChanges = diff.filter(d => d.type !== 'same');
    if (realChanges.length > 0) {
      changes.push({ type: 'modified', file: name, diff: realChanges });
    }
  }
}

    // === ГЕНЕРАЦИЯ CSV С ТЕХНИЧЕСКИМИ ПОЛЯМИ ===
    const jsonToCsv = (changes) => {
      const separator = ',';
      const header = [
        'type',
        'file',
        'change_type',
        'line',
        'old_index',
        'new_index',
        'length',
        'has_crlf',
        'has_bom',
        'whitespace_count',
        'normalized'
      ].join(separator);

      const rows = changes.flatMap(item => {
        if (item.type === 'modified') {
          return item.diff.map(d => {
            const changeType = d.type === 'added' ? 'добавлено' : 'удалено';
            const analysis = analyzeLine(d.value);

            return [
              `"${item.type}"`,
              `"${item.file}"`,
              `"${changeType}"`,
              `"${d.value.replace(/"/g, '""')}"`,
              d.type === 'removed' ? d.index : '',
              d.type === 'added' ? d.index : '',
              analysis.length,
              analysis.has_crlf ? 'да' : 'нет',
              analysis.has_bom ? 'да' : 'нет',
              analysis.whitespace_count,
              `"${analysis.normalized.replace(/"/g, '""')}"`
            ].join(separator);
          });
        } else {
          return [
            `"${item.type}"`,
            `"${item.file}"`,
            '"-"',
            '"-"',
            '""', '""', '""', '""', '""', '""', '""'
          ].join(separator);
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
        message: 'Обратитесь к администратору.'
      });
    }

    const gistResponse = await axios.post('https://api.github.com/gists', {
      description: 'CBR XBRL-CSV Diff Report (with debug info)',
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

    // === ОТВЕТ ===
    return res.status(200).json({
      summary: {
        total_changes: changes.length,
        added: changes.filter(c => c.type === 'added').length,
        deleted: changes.filter(c => c.type === 'deleted').length,
        modified: changes.filter(c => c.type === 'modified').length
      },
      report_url: gistUrl,
      message: 'Готово. Отчёт содержит технические данные для отладки.'
    });

  } catch (error) {
    console.error('💥 Ошибка при генерации отчёта:', error.message);
    return res.status(500).json({
      error: 'Не удалось создать отчёт',
      message: error.message
    });
  }
};
