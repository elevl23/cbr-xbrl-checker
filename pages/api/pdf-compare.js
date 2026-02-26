export default async function handler(req, res) {
  console.log('✅ Запуск: pdf-compare получил запрос');
  console.log('📥 Метод:', req.method);

  if (req.method !== 'POST') {
    console.log('❌ Метод не POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = await req.json();
    console.log('📬 Тело запроса:', JSON.stringify(body, null, 2));
  } catch (err) {
    console.error('❌ Ошибка парсинга JSON:', err.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('✅ JSON успешно распаршен');
  res.status(200).json({ success: true });
}
