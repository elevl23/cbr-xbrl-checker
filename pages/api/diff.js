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
        error: 'Не хватает параметров: old_url, new_url, file_name'
      });
    }

    // Скачиваем ZIP
    const [oldRes, newRes] = await Promise.all([
      axios.get(old_url, { responseType: 'arraybuffer' }),
      axios.get(new_url, { responseType: 'arraybuffer' })
    ]);

    // Извлечение файла из ZIP
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
        await zip.close();
        return null;
      }
    };

    const oldContent = await extractEntry(oldRes.data, file_name);
    const newContent = await extractEntry(newRes.data, file_name);

    // Логика сравнения
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
    
