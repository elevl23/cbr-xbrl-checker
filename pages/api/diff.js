import { NextResponse } from 'next/server';
import axios from 'axios';
import { ZipReader, BlobReader, BlobWriter } from '@zip.js/zip.js';

// Список текстовых файлов для сравнения
const TEXT_EXTENSIONS = [
  '.xml', '.json', '.csv', '.ddl', '.txt',
  '.sql', '.yml', '.yaml', '.xsd'
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
const extractAllTextFiles = async (arrayBuffer, label) => {
  try {
    console.log(`🔍 Извлечение из ${label}...`);

    const blob = new Blob([arrayBuffer], { type: 'application/zip' });
    const reader = new ZipReader(new BlobReader(blob));

    const entries = await reader.getEntries();
    console.log(`📄 Найдено файлов в ${label}: ${entries.length}`);

    // 🔧 Определяем имя корневой папки
    let rootFolder = '';
    if (entries.length > 0) {
      const firstPath = entries[0].filename;
      const firstSlash = firstPath.indexOf('/');
      if (firstSlash > 0) {
        rootFolder = firstPath.substring(0, firstSlash) + '/';
      }
    }

    console.log('📁 Корневая папка:', rootFolder || 'отсутствует');

    const files = {};

    for (const entry of entries) {
      if (!entry.directory && isTextFile(entry.filename)) {
        try {
          // 🔧 Убираем имя корневой папки
          const relativePath = rootFolder ? entry.filename.replace(rootFolder, '') : entry.filename;

          console.log(`📄 Читаем: ${relativePath}`);
          const blob = await entry.getData(new BlobWriter());
          const text = await blob.text();
          files[relativePath] = text;
        } catch (err) {
          console.error(`❌ Ошибка при чтении ${entry.filename}:`, err.message);
          files[entry.filename] = null;
        }
      }
    }

    await reader.close();
    return files;
  } catch (err) {
    console.error(`❌ Ошибка при извлечении из ${label}:`, err.message);
    return null;
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

    console.log('📥 Запрос на сравнение:', { old_url, new_url });

    // === Скачивание старого ZIP ===
    let oldArrayBuffer;
    try {
      const response = await axios.get(old_url, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'CBR-Checker/1.0',
          'Accept': 'application/zip'
        },
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024
      });
      console.log('✅ Старый ZIP скачан, размер:', response.data.byteLength);
      oldArrayBuffer = response.data;
    } catch (err) {
      console.error('❌ Ошибка при скачивании старого ZIP:', err.message);
      return res.status(500).json({
        error: 'Не удалось скачать старый ZIP',
        url: old_url,
        message: err.message
      });
    }

    // === Скачивание нового ZIP ===
    let newArrayBuffer;
    try {
      const response = await axios.get(new_url, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'CBR-Checker/1.0',
          'Accept': 'application/zip'
        },
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024
      });
      console.log('✅ Новый ZIP скачан, размер:', response.data.byteLength);
      newArrayBuffer = response.data;
    } catch (err) {
      console.error('❌ Ошибка при скачивании нового ZIP:', err.message);
      return res.status(500).json({
        error: 'Не удалось скачать новый ZIP',
        url: new_url,
        message: err.message
      });
    }

    // === Извлечение файлов ===
    let oldFiles = await extractAllTextFiles(oldArrayBuffer, 'старого архива');
    if (!oldFiles) {
      return res.status(500).json({
        error: 'Не удалось извлечь старый архив'
      });
    }

    let newFiles = await extractAllTextFiles(newArrayBuffer, 'нового архива');
    if (!newFiles) {
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
