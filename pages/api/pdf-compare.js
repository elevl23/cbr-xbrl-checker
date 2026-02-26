export default function handler(req, res) {
  console.log('✅ Запуск: pdf-compare получил запрос');
  console.log('📥 Метод:', req.method);

  if (req.method !== 'POST') {
    console.log('❌ Метод не POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('✅ Метод POST — OK');

  // Только логируем, ничего не делаем
  res.status(200).json({ success: true });
}
