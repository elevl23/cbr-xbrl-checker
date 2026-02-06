import axios from 'axios';
import { ZipReader, BlobReader, BlobWriter } from '@zip.js/zip.js';

// Текстовые расширения
const TEXT_EXTENSIONS = ['.xml', '.xsd', '.csv', '.ddl', '.json', '.yml', '.yaml', '.sql'];

const isTextFile = (filename) => {
  return TEXT_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
};

// Нормализация XSD-элементов
const normalizeXsdElement = (line) => {
  const match = line.match(/<xsd:element\s+(.*?)\s*\/>/);
  if (!match) return line;

  const attrsStr = match[1];
  const attrs = {};

  attrsStr.replace(/(\w+:[\w-]+|[\w-]+)\s*=\s*"([^"]*)"/g, (_, key, value) => {
    attrs[key] = value;
  });

  const sortedKeys = Object.keys(attrs).sort();
  const sortedAttrs = sortedKeys.map(key => `${key}="${attrs[key]}"`).join(' ');

  return `<xsd:element ${sortedAttrs}/>`;
};

const diffLines = (oldLines, newLines) => {
  const result = [];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length) {
      const oldLine = oldLines[i].trim();
      const newLine = newLines[j].trim();

      const normOld = oldLine.includes('<xsd:element') ? normalizeXsdElement(oldLine) : oldLine;
      const normNew = newLine.includes('<xsd:element') ? normalizeXsdElement(newLine) : newLine;

      if (normOld === normNew) {
        result.push({ type: 'same', value: oldLines[i] });
        i++; j++;
        continue;
      }
    }

    if (j < newLines.length) {
      result.push({ type: 'added', value: newLines[j] });
      j++;
    } else {
      result.push({ type: 'removed', value: oldLines[i] });
      i++;
    }
  }
  return result;
};

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
        const normalizedPath = entry.filename.replace(/\/\d{4}-\d{2}-\d{2}\//g, '/');
        const relativePath = rootFolder ? normalizedPath.replace(rootFolder, '') : normalizedPath;

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
          timeout: 30000,
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

    for (const name of Object.keys(oldFiles)) {
      if (!newFiles[name]) {
        changes.push({ type: 'deleted', file: name });
      }
    }

    for (const name of Object.keys(newFiles)) {
      if (!oldFiles[name]) {
        changes.push({ type: 'added', file: name });
      }
    }

    for (const name of Object.keys(newFiles)) {
      if (oldFiles[name] && oldFiles[name] !== newFiles[name]) {
        const oldLines = oldFiles[name].split('\n');
        const newLines = newFiles[name].split('\n');
        const diff = diffLines(oldLines, newLines);
        changes.push({ type: 'modified', file: name, diff });
      }
    }

    const summary = {
      total_changes: changes.length,
      added: changes.filter(c => c.type === 'added').length,
      deleted: changes.filter(c => c.type === 'deleted').length,
      modified: changes.filter(c => c.type === 'modified').length
    };

    // === ГЕНЕРАЦИЯ CSV — БЕЗ СТРОК "БЕЗ ИЗМЕНЕНИЙ" ===
    const jsonToCsv = (changes) => {
      const separator = ',';
      const header = ['type', 'file', 'change_type', 'line'].join(separator);
      const rows = changes.flatMap(item => {
        if (item.type === 'modified') {
          return item.diff
            .filter(d => d.type !== 'same')
            .map(d => {
              const changeType = d.type === 'added' ? 'добавлено' : 'удалено';
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
      summary,
      report_url: gistUrl,
      message: 'Готово. Только реальные изменения.'
    });

  } catch (error) {
    console.error('💥 Ошибка при генерации детального отчёта:', error.message);
    return res.status(500).json({
      error: 'Не удалось создать отчёт',
      message: error.message
    });
  }
}
