// pages/api/pdf-compare.js

const { NextResponse } = require('next/server');
const fs = require('fs');
const path = require('path');

// Путь к файлу задачи (в /tmp — временная папка Vercel)
const TASK_FILE = '/tmp/pdf-task.json';

module.exports = async function (req, res) {
  try {
    const { updates } = await req.json();

    // ✅ Сохраняем задачу в /tmp (на время выполнения)
    fs.writeFileSync(TASK_FILE, JSON.stringify({
      updates,
      createdAt: new Date().toISOString()
    }));

    console.log('✅ Задача сохранена:', updates.length, 'PDF');

    // ✅ Отвечаем быстро
    return NextResponse.json({ success: true, queued: true });
  } catch (err) {
    console.error('❌ Ошибка при постановке задачи:', err.message);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
};

module.exports.default = module.exports;
