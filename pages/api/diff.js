import { NextResponse } from 'next/server';
import axios from 'axios';
import StreamZip from 'node-stream-zip';

// Список текстовых файлов для сравнения
const TEXT_EXTENSIONS = [
  '.xml', '.json', '.csv', '.ddl', '.txt',
  '.sql', '.yml', '.yaml', '.xsd'  // ✅ .xsd добавлен
];

const isTextFile = (filename) => {
  return TEXT_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
};

// Построчное сравнение
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

// Извлечение всех текстовых файлов
const extractAllTextFiles = async (buffer) => {
  const zip = new StreamZip.async({ buffer });
  const entries = await zip.entries();
  const files = {};

  for (const [name, entry] of Object.entries(entries)) {
    if (!entry.isDirectory && isTextFile(name)) {
      try {
        const data = await zip.entryData(name);
        files[name] = data.toString('utf-8');
      } catch (err) {
        console.error('Ошибка при чтении файла:', name, err.message);
        files[name] = null;
      }
    }
  }

  await zip.close();
  return files;
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

    console.log('📥 Запрос на сравнение:', { old_url, new_url });

    // === Скачивание старого ZIP ===
    let oldBuffer;
    try {
      const res = await axios.get(old_url, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'CBR-Checker/1.0',
          'Accept': 'application/zip'
        },
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024
      });
      console.log('✅ Старый ZIP скачан:', res.data.length, 'байт');
      oldBuffer = Buffer.from(res.data);
    } catch (err) {
      console.error('❌ Ошибка при скачивании старого ZIP:', err.message);
      return res.status(500).json({
        error: 'Не удалось скачать старый ZIP',
        url: old_url,
        message: err.message
      });
    }

    // === Скачивание нового ZIP ===
    let newBuffer;
    try {
      const res = await axios.get(new_url, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'CBR-Checker/1.0',
          'Accept': 'application/zip'
        },
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024
      });
      console.log('✅ Новый ZIP скачан:', res.data.length, 'байт');
      newBuffer = Buffer.from(res.data);
    } catch (err) {
      console.error('❌ Ошибка при скачивании нового ZIP:', err.message);
      return res.status(500).json({
        error: 'Не удалось скачать новый ZIP',
        url: new_url,
        message: err.message
      });
    }

    // === Извлечение файлов ===
    let oldFiles, newFiles;
    try {
      oldFiles = await extractAllTextFiles(oldBuffer);
      console.log('📄 Извлечено из старого архива:', Object.keys(oldFiles));
    } catch (err) {
      console.error('❌ Ошибка при извлечении старого архива:', err.message);
      return res.status(500).json({
        error: 'Не удалось извлечь старый архив'
      });
    }

    try {
      newFiles = await extractAllTextFiles(newBuffer);
      console.log('📄 Извлечено из нового архива:', Object.keys(newFiles));
    } catch (err) {
      console.error('❌ Ошибка при извлечении нового архива:', err.message);
      return res.status(500).json({
        error: 'Не удалось извлечь новый архив'
      });
    }

    // === Сравнение ===
    const changes = [];

    // Удалённые файлы
    for (const name of Object.keys(oldFiles)) {
      if (!newFiles[name]) {
        changes.push({
          type: 'deleted',
          file: name,
          summary: 'Файл удалён'
        });
      }
    }

    // Новые файлы
    for (const name of Object.keys(newFiles)) {
      if (!oldFiles[name]) {
        changes.push({
          type: 'added',
          file: name,
          summary: 'Файл добавлен'
        });
      }
    }

    // Изменённые файлы
    for (const name of Object.keys(newFiles)) {
      if (oldFiles[name] && oldFiles[name] !== newFiles[name]) {
        const oldLines = oldFiles[name].split('\n');
        const newLines = newFiles[name].split('\n');
        const diff = diffLines(oldLines, newLines);

        changes.push({
          type: 'modified',
          file: name,
          diff,
          summary: 'Файл изменён'
        });
      }
    }

    // === Ответ ===
    res.status(200).json({
      changes,
      summary: `Найдено изменений: ${changes.length}`,
      old_version: old_url,
      new_version: new_url
    });
  } catch (error) {
    console.error('💥 Критическая ошибка:', error.message);
    res.status(500).json({
      error: 'Не удалось сравнить архивы',
      message: error.message,
      stack: error.stack
    });
  }
}
