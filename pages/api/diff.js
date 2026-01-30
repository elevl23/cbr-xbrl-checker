import { NextResponse } from 'next/server';
import axios from 'axios';
import StreamZip from 'node-stream-zip';

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
const extractAllTextFiles = async (buffer, label) => {
  try {
    console.log(`🔍 Извлечение из ${label}, размер buffer:`, buffer.length);

    if (!Buffer.isBuffer(buffer)) {
      console.error(`❌ buffer не Buffer, а:`, typeof buffer);
      return null;
    }

    const zip = new StreamZip.async({ buffer });
    const entries = await zip.entries();

    console.log(`📄 Файлы в ${label}:`, Object.keys(entries));

    const files = {};
    for (const [name, entry] of Object.entries(entries)) {
      if (!entry.isDirectory && isTextFile(name)) {
        try {
          console.log(`📄 Читаем:`, name);
          const data = await zip.entryData(name);
          files[name] = data.toString('utf-8');
        } catch (err) {
          console.error(`❌ Ошибка при чтении ${name}:`, err.message);
          files[name] = null;
        }
      }
    }

    await zip.close();
    return files;
  } catch (err) {
    console.error(`❌ Ошибка при извлечении из ${label}:`, err.message);
    try {
      await zip?.close();
    } catch (closeErr) {}
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

      console.log('✅ Старый ZIP скачан, размер:', res.data?.length);
      console.log('Тип res.data:', typeof res.data);
      console.log('res.data instanceof ArrayBuffer:', res.data instanceof ArrayBuffer);

      if (!res.data) {
        throw new Error('res.data пустой — нет данных');
      }

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

      console.log('✅ Новый ZIP скачан, размер:', res.data?.length);
      console.log('Тип res.data:', typeof res.data);
      console.log('res.data instanceof ArrayBuffer:', res.data instanceof ArrayBuffer);

      if (!res.data) {
        throw new Error('res.data пустой — нет данных');
      }

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
    let oldFiles = await extractAllTextFiles(oldBuffer, 'старого архива');
    if (!oldFiles) {
      return res.status(500).json({
        error: 'Не удалось извлечь старый архив',
        details: 'Ошибка при распаковке или повреждённый ZIP'
      });
    }

    let newFiles = await extractAllTextFiles(newBuffer, 'нового архива');
    if (!newFiles) {
      return res.status(500).json({
        error: 'Не удалось извлечь новый архив',
        details: 'Ошибка при распаковке или повреждённый ZIP'
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
