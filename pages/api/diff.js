import { NextResponse } from 'next/server';
import axios from 'axios';
import StreamZip from 'node-stream-zip';

// Список поддерживаемых текстовых файлов
const TEXT_EXTENSIONS = ['.xml', '.json', '.csv', '.ddl', '.txt', '.sql'];

const isTextFile = (filename) => {
  return TEXT_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
};

// Построчное сравнение
const diffLines = (oldLines, newLines) => {
  const diff = [];
  let i = 0, j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length) {
      if (oldLines[i] === newLines[j]) {
        diff.push({ type: 'same', value: oldLines[i] });
        i++; j++;
      } else {
        diff.push({ type: 'removed', value: oldLines[i] });
        diff.push({ type: 'added', value: newLines[j] });
        i++; j++;
      }
    } else if (i < oldLines.length) {
      diff.push({ type: 'removed', value: oldLines[i] });
      i++;
    } else {
      diff.push({ type: 'added', value: newLines[j] });
      j++;
    }
  }

  return diff;
};

// Извлечение файлов из ZIP
const extractFiles = async (buffer, targetFile) => {
  const zip = new StreamZip.async({ buffer });
  const entries = await zip.entries();

  // Ищем нужный файл
  for (const [name, entry] of Object.entries(entries)) {
    if (name === targetFile && !entry.isDirectory) {
      const content = await zip.file(name).buffer();
      await zip.close();

      if (isTextFile(name)) {
        return content.toString('utf-8');
      } else {
        return { error: 'Файл не текстовый, сравнение недоступно' };
      }
    }
  }

  await zip.close();
  return null; // не найден
};

export async function POST(request) {
  try {
    const { old_url, new_url, file_name } = await request.json();

    if (!old_url || !new_url || !file_name) {
      return NextResponse.json(
        { error: 'Не хватает параметров: old_url, new_url, file_name' },
        { status: 400 }
      );
    }

    // Скачиваем ZIP
    const [oldRes, newRes] = await Promise.all([
      axios.get(old_url, { responseType: 'arraybuffer' }),
      axios.get(new_url, { responseType: 'arraybuffer' })
    ]);

    // Извлекаем файл
    const oldContent = await extractFiles(oldRes.data, file_name);
    const newContent = await extractFiles(newRes.data, file_name);

    if (oldContent == null && newContent == null) {
      return NextResponse.json(
        { error: 'Файл не найден ни в старом, ни в новом архиве' },
        { status: 404 }
      );
    }

    // Если файл только в новом
    if (oldContent == null) {
      return NextResponse.json({
        file: file_name,
        diff: [
          { type: 'added', value: 'Файл добавлен в новой версии' },
          { type: 'added', value: newContent || '' }
        ],
        summary: 'Файл добавлен'
      });
    }

    // Если файл только в старом
    if (newContent == null) {
      return NextResponse.json({
        file: file_name,
        diff: [
          { type: 'removed', value: 'Файл удалён' },
          { type: 'removed', value: oldContent || '' }
        ],
        summary: 'Файл удалён'
      });
    }

    // Если файл есть в обоих — сравниваем
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const diff = diffLines(oldLines, newLines);

    return NextResponse.json({
      file: file_name,
      diff,
      summary: 'Файл изменён',
      old_version: old_url,
      new_version: new_url
    });
  } catch (error) {
    console.error('Ошибка при сравнении:', error);
    return NextResponse.json(
      { error: 'Не удалось сравнить архивы', message: error.message },
      { status: 500 }
    );
  }
}
