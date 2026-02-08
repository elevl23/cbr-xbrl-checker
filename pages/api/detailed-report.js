import axios from 'axios';

// Текстовые расширения
const TEXT_EXTENSIONS = ['.xml', '.xsd', '.csv', '.ddl', '.json', '.yml', '.yaml', '.sql'];

const isTextFile = (filename) => {
  return TEXT_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
};

const diffLines = (oldLines, newLines) => {
  const result = [];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push({ type: 'same', value: oldLines[i] });
      i++; j++;
    } else if (j < newLines.length) {
      result.push({ type: 'added', value: newLines[j] });
      j++;
    } else {
      result.push({ type: 'removed', value: oldLines[i] });
      i++;
    }
  }
  return result;
};

// Нормализация пути: заменяем даты в формате YYYY-MM-DD на {date}
const normalizePath = (filename) => {
  return filename.replace(/\/(\d{4}-\d{2}-\d{2})\//g, '/{date}/');
};

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
          timeout: 60000,
          maxContentLength: 30 * 1024 * 1024
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

    console.log('🔍 Начинаем извлечение файлов из старого архива...');
    const oldFiles = await extractAllTextFiles(oldArrayBuffer, 'старого архива');
    console.log('✅ Старые файлы извлечены:', Object.keys(oldFiles).length);

    console.log('🔍 Начинаем извлечение файлов из нового архива...');
    const newFiles = await extractAllTextFiles(newArrayBuffer, 'нового архива');
    console.log('✅ Новые файлы извлечены:', Object.keys(newFiles).length);

    // === Нормализация и сравнение файлов ===
    const oldFilesMap = new Map(); // normPath → { origName, content }
    const newFilesMap = new Map(); // normPath → { origName, content }

    for (const name of Object.keys(oldFiles)) {
      const norm = normalizePath(name);
      oldFilesMap.set(norm, { origName: name, content: oldFiles[name] });
    }

    for (const name of Object.keys(newFiles)) {
      const norm = normalizePath(name);
      newFilesMap.set(norm, { origName: name, content: newFiles[name] });
    }

    const changes = [];

    // 1. Проверяем удалённые и изменённые
    for (const [normName, oldEntry] of oldFilesMap) {
      const newEntry = newFilesMap.get(normName);
      if (!newEntry) {
        changes.push({ type: 'deleted', file: oldEntry.origName });
      } else if (newEntry.content !== oldEntry.content) {
        const oldLines = oldEntry.content.split('\n');
        const newLines = newEntry.content.split('\n');
        const diff = diffLines(oldLines, newLines);
        changes.push({ type: 'modified', file: newEntry.origName, diff });
      }
    }

    // 2. Проверяем добавленные
    for (const [normName, newEntry] of newFilesMap) {
      if (!oldFilesMap.has(normName)) {
        changes.push({ type: 'added', file: newEntry.origName });
      }
    }

    // === ГЕНЕРАЦИЯ CSV ===
    const jsonToCsv = (changes) => {
  const separator = ',';
  const header = [
    'type',
    'file',
    'change_type',
    'line',
    'line_length',
    'line_normalized',
    'line_number_in_diff',
    'context_before',
    'context_after'
  ].join(separator);

  const rows = changes.flatMap(item => {
    if (item.type === 'modified') {
      return item.diff
        .filter(d => d.type !== 'same')
        .map((d, idx, arr) => {
          const value = d.value || '';
          const trimmed = value.trim();

          // Нормализация: убираем лишние пробелы, сортируем атрибуты (для XML)
          const normalizeXml = (str) => {
            const cleaned = str.trim();
            const tagMatch = cleaned.match(/<(\w+)([^>]*)>(.*?)<\/\w+>|<(\w+)([^>]*)\s*\/>/s);
            if (!tagMatch) return cleaned;

            const tag = tagMatch[1] || tagMatch[4];
            const attrsStr = (tagMatch[2] || tagMatch[5] || '').trim();
            const content = tagMatch[3] || '';

            // Извлекаем и сортируем атрибуты
            const sortedAttrs = attrsStr
              .replace(/\s+/g, ' ')
              .split(' ')
              .filter(attr => attr.includes('='))
              .map(attr => {
                const [key, ...valParts] = attr.split('=');
                const val = valParts.join('=');
                return `${key.trim()}=${val.trim()}`;
              })
              .sort()
              .join(' ');

            return content
              ? `<${tag} ${sortedAttrs}>${content.trim()}</${tag}>`.trim()
              : `<${tag} ${sortedAttrs}/>`;
          };

          const normalized = trimmed ? normalizeXml(trimmed) : trimmed;

          // Контекст
          const prevLine = idx > 0 ? (arr[idx - 1].value || '').trim() : '';
          const nextLine = idx < arr.length - 1 ? (arr[idx + 1].value || '').trim() : '';

          const changeType = d.type === 'added' ? 'добавлено' : 'удалено';

          return [
            `"${item.type}"`,
            `"${item.file.replace(/"/g, '""')}"`,
            `"${changeType}"`,
            `"${value.replace(/"/g, '""')}"`,
            value.length,
            `"${normalized.replace(/"/g, '""')}"`,
            idx + 1,
            `"${prevLine.replace(/"/g, '""')}"`,
            `"${nextLine.replace(/"/g, '""')}"`
          ].join(separator);
        });
    } else {
      return [
        `"${item.type}"`,
        `"${item.file.replace(/"/g, '""')}"`,
        '"-"',
        '"-"',
        '""',
        '""',
        '""',
        '""',
        '""'
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
