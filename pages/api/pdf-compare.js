export default async function handler(req, res) {
  console.log('✅ Запуск: pdf-compare получил запрос');
  console.log('📥 Метод:', req.method);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // === ПРОВЕРКА ЗАГОЛОВКОВ ===
  const contentType = req.headers['content-type'];
  console.log('📌 Content-Type:', contentType);

  if (!contentType || !contentType.includes('application/json')) {
    console.log('❌ Content-Type не JSON — возможно, ошибка в отправке');
    return res.status(400).json({ error: 'Content-Type must be application/json' });
  }

  let body;
  try {
    body = await req.json();
    console.log('✅ req.json() — успешно');
  } catch (err) {
    console.error('❌ req.json() упал:', err.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('📬 Тело запроса:', JSON.stringify(body, null, 2));
  res.status(200).json({ success: true });
}
