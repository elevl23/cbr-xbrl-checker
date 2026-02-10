import axios from 'axios';

// Текстовые расширения
const TEXT_EXTENSIONS = ['.xml', '.xsd', '.csv', '.ddl', '.json', '.yml', '.yaml', '.sql'];

const isTextFile = (filename) => {
  return TEXT_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
};

// === diffLines с номерами строк ===
const diffLines = (oldLines, newLines) => {
  const result = [];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push({ 
        type: 'same', 
        value: oldLines[i],
        oldIndex: i + 1,
        newIndex: j + 1
      });
      i++; j++;
    } else if (j < newLines.length) {
      result.push({ 
        type: 'added', 
        value: newLines[j],
        newIndex: j + 1
      });
      j++;
    } else {
      result.push({ 
        type: 'removed', 
        value: oldLines[i],
        oldIndex: i + 1
      });
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
    const oldFilesMap = new Map();
    const newFilesMap = new Map();

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

    // === 🔍 ФИЛЬТР: ТОЛЬКО mem-int.xsd ===
    const TARGET_FILE = 'www.cbr.ru/xbrl/udr/dom/mem-int.xsd';

    const targetChanges = changes.filter(change => {
      if (change.type === 'modified') {
        return change.file.includes(TARGET_FILE);
      } else if (change.type === 'added' || change.type === 'deleted') {
        return change.file.includes(TARGET_FILE);
      }
      return false;
    });

    // === 📄 ГЕНЕРАЦИЯ CSV С НОМЕРАМИ СТРОК ===
    const generateCsv = (changes) => {
  const separator = ',';
  const header = [
    'type',
    'file',
    'change_type',
    'line',
    'line_length',
    'normalized_line',
    'line_number_in_old',
    'line_number_in_new'
  ].join(separator);

  // Собираем все изменения
  const allItems = [];
  const removedMap = new Map(); // normalized_line → запись
  const addedMap = new Map();   // normalized_line → запись

  for (const item of changes) {
    if (item.type === 'modified') {
      for (const d of item.diff) {
        if (d.type !== 'same') {
          const value = d.value || '';
          const trimmed = value.trim();
          if (!trimmed) continue;

          const normalizeXml = (str) => {
            const tagMatch = str.match(/<(\w+)([^>]*)>(.*?)<\/\w+>|<(\w+)([^>]*)\s*\/>/s);
            if (!tagMatch) return str.trim();

            const tag = tagMatch[1] || tagMatch[4];
            const attrsStr = (tagMatch[2] || tagMatch[5] || '').trim();
            const content = tagMatch[3] || '';

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
              ? `<${tag} ${sortedAttrs}>${content.trim()}</${tag}>`
              : `<${tag} ${sortedAttrs}/>`;
          };

          const normalized = trimmed ? normalizeXml(trimmed) : trimmed;
          const key = `${item.file}|${normalized}`;

          const record = {
            type: item.type,
            file: item.file,
            change_type: d.type === 'added' ? 'добавлено' : 'удалено',
            line: value,
            line_length: value.length,
            normalized_line: normalized,
            line_number_in_old: d.oldIndex || '',
            line_number_in_new: d.newIndex || ''
          };

          if (d.type === 'removed') {
            removedMap.set(key, record);
          } else if (d.type === 'added') {
            addedMap.set(key, record);
          }
        }
      }
    }
  }

  // Фильтруем: если есть и removed, и added с одинаковым key → это перемещение → игнорируем
  const finalItems = [];

  for (const [key, added] of addedMap) {
    if (!removedMap.has(key)) {
      finalItems.push(added);
    }
  }

  for (const [key, removed] of removedMap) {
    if (!addedMap.has(key)) {
      finalItems.push(removed);
    }
  }

  // Сортируем: сначала по файлу, потом по номеру строки
  finalItems.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return (a.line_number_in_old || a.line_number_in_new) - (b.line_number_in_old || b.line_number_in_new);
  });

  const rows = finalItems.map(item => [
    `"${item.type}"`,
    `"${item.file.replace(/"/g, '""')}"`,
    `"${item.change_type}"`,
    `"${item.line.replace(/"/g, '""')}"`,
    item.line_length,
    `"${item.normalized_line.replace(/"/g, '""')}"`,
    item.line_number_in_old,
    item.line_number_in_new
  ].join(separator));

  return [header, ...rows].join('\n');
};

    const csv = generateCsv(targetChanges);

    // === 🚀 ОТПРАВКА В GITHUB GIST ===
    const GIST_TOKEN = process.env.GITHUB_GIST_TOKEN;

    if (!GIST_TOKEN) {
      return res.status(500).json({
        error: 'GITHUB_GIST_TOKEN не настроен',
        message: 'Не удалось создать отчёт. Обратитесь к администратору.'
      });
    }

    try {
      console.log('📤 Отправляем в Gist только изменения по mem-int.xsd...');
      console.log('📝 Размер CSV:', csv.length, 'байт');

      const gistResponse = await axios.post('https://api.github.com/gists', {
        description: 'DEBUG: Только изменения в mem-int.xsd + номера строк',
        public: true,
        files: {
          'mem-int-changes.csv': {
            content: csv
          }
        }
      }, {
        headers: {
          'Authorization': `Bearer ${GIST_TOKEN}`,
          'User-Agent': 'cbr-xbrl-checker',
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      console.log('✅ Gist создан:', gistResponse.data.html_url);
      const gistUrl = gistResponse.data.html_url;

      return res.status(200).json({
        summary: {
          changes_in_mem_int_xsd: targetChanges.length
        },
        report_url: gistUrl,
        message: 'Готово. Только изменения в mem-int.xsd выгружены в Gist.'
      });

    } catch (error) {
      console.error('❌ Ошибка при отправке в Gist:', error.message);
      if (error.response) {
        console.error('GitHub ошибка:', error.response.status, error.response.data);
        return res.status(500).json({
          error: 'Ошибка Gist',
          message: `GitHub: ${error.response.status} — ${error.response.data.message || 'Server Error'}`
        });
      }
      return res.status(500).json({
        error: 'Неизвестная ошибка',
        message: error.message
      });
    }

  } catch (error) {
    console.error('💥 Ошибка при генерации детального отчёта:', error.message);
    return res.status(500).json({
      error: 'Не удалось создать отчёт',
      message: error.message
    });
  }
}
