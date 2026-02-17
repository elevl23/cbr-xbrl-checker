// pages/api/pdf-compare.js

const { NextResponse } = require('next/server');
const { getDocument } = require('pdfjs-dist/legacy/build/pdf.js');

async function pdfToText(url) {
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const pdf = await getDocument({ data: arrayBuffer }).promise;

    const textParts = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ');
      textParts.push(text);
    }

    return textParts.join('\n\n').trim();
  } catch (err) {
    console.error(`Ошибка при извлечении текста из PDF (${url}):`, err.message);
    throw new Error(`Не удалось обработать PDF: ${err.message}`);
  }
}

async function handler(req, res) {
  try {
    const { updates } = await req.json();

    if (!Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json(
        { error: 'Ожидается массив обновлений' },
        { status: 400 }
      );
    }

    for (const update of updates) {
      const { name, old_url, new_url } = update;

      if (!old_url || !new_url) {
        console.warn('Пропущено: отсутствует URL', update);
        continue;
      }

      try {
        console.log(`Обработка PDF: ${name}`);
        const oldText = await pdfToText(old_url);
        const newText = await pdfToText(new_url);

        const transcript = `
### СТАРАЯ ВЕРСИЯ (${name})
${oldText}

### НОВАЯ ВЕРСИЯ (${name})
${newText}
        `.trim();

        const difyRes = await fetch('https://api.dify.ai/v1/workflows/run', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.DIFY_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: { transcript },
            response_mode: 'blocking',
          }),
        });

        let difyData;
        try {
          difyData = await difyRes.json();
        } catch (parseError) {
          const text = await difyRes.text();
          console.error('Dify вернул не JSON:', text);
          continue;
        }

        if (difyRes.status !== 200 || difyData.error) {
          console.error('Ошибка Dify:', difyData);
          continue;
        }

        const summary = difyData.outputs.text;

        const gistRes = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers: {
            'Authorization': `token ${process.env.GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            description: `Автоматическое сравнение PDF — ${name}`,
            public: true,
            files: {
              [`pdf-comparison-${Date.now()}.md`]: {
                content: summary,
              },
            },
          }),
        });

        const gistJson = await gistRes.json();
        console.log('✅ Результат сохранён в Gist:', gistJson.html_url);
      } catch (err) {
        console.error(`❌ Ошибка при обработке ${name}:`, err.message);
      }
    }

    return NextResponse.json({ success: true, processed: updates.length });
  } catch (err) {
    // ❌ err — это Error, у него нет .json()
    // Но мы не вызываем err.json() — значит, ошибка не здесь
    console.error('Ошибка в /api/pdf-compare:', err.message);
    return NextResponse.json(
      { error: 'Внутренняя ошибка сервера' },
      { status: 500 }
    );
  }
}

module.exports = handler;
module.exports.default = handler;
