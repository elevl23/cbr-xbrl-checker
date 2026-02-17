// scripts/process-pdf.js

const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const axios = require('axios');

const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

async function pdfToText(url) {
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const data = await pdf(Buffer.from(response.data));
    return data.text;
  } catch (err) {
    console.error('❌ Ошибка при чтении PDF:', err.message);
    throw err;
  }
}

async function processTask() {
  const TASK_FILE = './tmp/pdf-task.json';

  if (!fs.existsSync(TASK_FILE)) {
    console.log('❌ Нет задачи для обработки');
    return;
  }

  const task = JSON.parse(fs.readFileSync(TASK_FILE, 'utf8'));
  console.log(`📄 Найдено ${task.updates.length} обновлений`);

  for (const update of task.updates) {
    const { name, old_url, new_url } = update;

    try {
      console.log(`🚀 Обработка: ${name}`);
      const oldText = await pdfToText(old_url);
      const newText = await pdfToText(new_url);

      const transcript = `
### СТАРАЯ ВЕРСИЯ (${name})
${oldText.substring(0, 2000)}...

### НОВАЯ ВЕРСИЯ (${name})
${newText.substring(0, 2000)}...
      `.trim();

      const difyRes = await axios.post('https://api.dify.ai/v1/workflows/run', {
        inputs: { transcript },
        response_mode: 'blocking',
      }, {
        headers: {
          'Authorization': `Bearer ${DIFY_API_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      const summary = difyRes.data.outputs?.text;
      if (!summary) {
        console.error('❌ Нет ответа от Dify');
        continue;
      }

      const gistRes = await axios.post('https://api.github.com/gists', {
        description: `Сравнение PDF — ${name}`,
        public: true,
        files: {
          [`pdf-comparison-${Date.now()}.md`]: { content: summary },
        },
      }, {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
        },
      });

      console.log('✅ Gist создан:', gistRes.data.html_url);
    } catch (err) {
      console.error(`❌ Ошибка при обработке ${name}:`, err.message);
    }
  }

  // Удаляем задачу
  fs.unlinkSync(TASK_FILE);
  console.log('✅ Задача завершена');
}

// Запуск
processTask().catch(err => {
  console.error('❌ Ошибка выполнения:', err.message);
  process.exit(1);
});