export default async function handler(req, res) {
  console.log('✅ Запуск: pdf-compare получил запрос');
  console.log('📥 Метод:', req.method);

  if (req.method !== 'POST') {
    console.log('❌ Метод не POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // === ПОПЫТКА ПРОЧИТАТЬ ТЕЛО ===
  let body;
  try {
    // Попробуем прочитать как JSON
    body = await req.json();
    console.log('✅ req.json() сработал');
  } catch (err) {
    console.error('❌ req.json() упал:', err.message);

    // Попробуем прочитать как строку
    try {
      const raw = await getRawBody(req);
      console.log('📄 Тело как строка:', raw);

      // Попробуем распарсить
      body = JSON.parse(raw);
      console.log('✅ JSON.parse() сработал');
    } catch (parseErr) {
      console.error('❌ Не удалось распарсить JSON:', parseErr.message);
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  console.log('📬 Тело запроса:', JSON.stringify(body, null, 2));
  res.status(200).json({ success: true });
}

// === ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ: getRawBody ===
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', err => {
      reject(err);
    });
  });
}
