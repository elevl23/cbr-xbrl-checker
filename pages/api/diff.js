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
      return res.status(400).json({
        error: 'Не хватает параметров',
        received: { old_url, new_url, file_name }
      });
    }

    console.log('Запрос на сравнение:', { old_url, new_url, file_name });

    // Функция для безопасного скачивания
    const downloadZip = async (url) => {
      try {
        const response = await axios.get(url, {
          method: 'GET',
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept': 'application/zip',
            'Referer': 'https://www.cbr.ru/',
            'Origin': 'https://www.cbr.ru'
          },
          timeout: 10000, // 10 сек
          maxContentLength: 50 * 1024 * 1024, // 50 МБ
          validateStatus: (status) => status === 200
        });

        if (!response.data || response.data.length === 0) {
          throw new Error('Пустой ответ');
        }

        console.log('Успешно скачан:', url, 'размер:', response.data.length);
        return response.data;
      } catch (err) {
        console.error('Ошибка при скачивании:', url);
        if (err.response) {
          console.error('Status:', err.response.status);
          console.error('Data:', err.response.data.toString().slice(0, 200));
        } else if (err.request) {
          console.error('No response received');
        } else {
          console.error('Error:', err.message);
        }
        throw err;
      }
    };

    let oldBuffer, newBuffer;

    try {
      oldBuffer = await downloadZip(old_url);
    } catch (err) {
      return res.status(500).json({
        error: 'Не удалось скачать старый ZIP',
        url: old_url,
        message: err.message
      });
    }

    try {
      newBuffer = await downloadZip(new_url);
    } catch (err) {
      return res.status(500).json({
        error: 'Не удалось скачать новый ZIP',
        url: new_url,
        message: err.message
      });
    }

    if (!oldBuffer || !newBuffer) {
      return res.status(500).json({
        error: 'Один из архивов пуст'
      });
    }

    // Извлечение файла
    const extractEntry = async (buffer, fileName) => {
      const zip = new StreamZip.async({ buffer });
      try {
        const entries = await zip.entries();
        if (!entries[fileName]) {
          await zip.close();
          return null;
        }
        const data = await zip.entryData(fileName);
        await zip.close();
        return data.toString('utf-8');
      } catch (err) {
        console.error('Ошибка при извлечении:', err.message);
        try {
          await zip.close();
        } catch (closeErr) {}
        return null;
      }
    };

    const oldContent = await extractEntry(oldBuffer, file_name);
    const newContent = await extractEntry(newBuffer, file_name);

    if (oldContent === null && newContent === null) {
      return res.status(404).json({
        error: 'Файл не найден ни в одном архиве'
      });
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

    // Построчное сравнение
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
    console.error('Критическая ошибка:', error.message);
    res.status(500).json({
      error: 'Не удалось сравнить архивы',
      message: error.message,
      stack: error.stack
    });
  }
}
