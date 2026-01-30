import { NextResponse } from 'next/server';
import axios from 'axios';
import StreamZip from 'node-stream-zip';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  try {
    const { old_url, new_url, file_name } = req.body;

    if (!old_url || !new_url || !file_name) {
      return res.status(400).json({ error: 'Не хватает параметров' });
    }

    console.log('📥 Запрос на сравнение:', { old_url, new_url, file_name });

    // === Скачивание старого ZIP ===
    let oldBuffer;
    try {
      const oldRes = await axios.get(old_url, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept': 'application/zip',
          'Referer': 'https://www.cbr.ru/',
          'Origin': 'https://www.cbr.ru'
        },
        timeout: 30000, // 30 секунд
        maxContentLength: 10 * 1024 * 1024 // 10 МБ
      });

      console.log('✅ Старый ZIP скачан:', oldRes.data.length, 'байт');
      oldBuffer = Buffer.from(oldRes.data);
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
      const newRes = await axios.get(new_url, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept': 'application/zip',
          'Referer': 'https://www.cbr.ru/',
          'Origin': 'https://www.cbr.ru'
        },
        timeout: 30000, // 30 секунд
        maxContentLength: 10 * 1024 * 1024
      });

      console.log('✅ Новый ZIP скачан:', newRes.data.length, 'байт');
      newBuffer = Buffer.from(newRes.data);
    } catch (err) {
      console.error('❌ Ошибка при скачивании нового ZIP:', err.message);
      return res.status(500).json({
        error: 'Не удалось скачать новый ZIP',
        url: new_url,
        message: err.message
      });
    }

    // === Извлечение файла ===
    const extractEntry = async (buffer, fileName) => {
      try {
        const zip = new StreamZip.async({ buffer });
        const entries = await zip.entries();
        if (!entries[fileName]) {
          await zip.close();
          return null;
        }
        const data = await zip.entryData(fileName);
        await zip.close();
        return data.toString('utf-8');
      } catch (err) {
        console.error('❌ Ошибка при извлечении:', err.message);
        try {
          await zip.close();
        } catch (closeErr) {}
        return null;
      }
    };

    const oldContent = await extractEntry(oldBuffer, file_name);
    const newContent = await extractEntry(newBuffer, file_name);

    if (oldContent === null && newContent === null) {
      return res.status(404).json({ error: 'Файл не найден ни в одном архиве' });
    }

    if (oldContent === null) {
      return res.status(200).json({
        file: file_name,
        change: 'added',
        content: newContent,
        summary: 'Файл добавлен'
      });
    }

    if (newContent === null) {
      return res.status(200).json({
        file: file_name,
        change: 'removed',
        content: oldContent,
        summary: 'Файл удалён'
      });
    }

    if (oldContent === newContent) {
      return res.status(200).json({
        file: file_name,
        change: 'no_change',
        summary: 'Файл не изменился'
      });
    }

    // === Построчное сравнение ===
    const diff = (oldLines, newLines) => {
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

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const changes = diff(oldLines, newLines);

    res.status(200).json({
      file: file_name,
      change: 'modified',
      diff: changes,
      summary: 'Файл изменён',
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
