# View Counter

Вставляєте посилання на пости — отримуєте кількість переглядів кожного і загальну суму.

## Що підтримується

| Платформа | Як рахується |
|---|---|
| YouTube (відео, Shorts, live) | Офіційний YouTube Data API, якщо задано `YOUTUBE_API_KEY`, інакше — з публічної сторінки |
| Telegram (публічні канали) | З публічного віджета поста (`t.me/канал/номер`). Великі числа Telegram округлює (`1.2K`), тому позначаються «≈» |
| TikTok | З публічної сторінки відео (може блокуватись TikTok) |
| Instagram, Facebook, X | Поки ні — перегляди не публічні, потрібне підключення акаунта власника / платний API |

## Запуск

Потрібен Node.js 18+. Залежностей немає.

```bash
cd view-counter
npm start
# відкрийте http://localhost:3000
```

Необов'язково — ключ YouTube Data API (точніше й стабільніше, ніж читання сторінки):

```bash
YOUTUBE_API_KEY=ваш_ключ npm start
```

## API

```bash
curl -X POST http://localhost:3000/api/views \
  -H 'Content-Type: application/json' \
  -d '{"urls": ["https://youtu.be/dQw4w9WgXcQ", "https://t.me/durov/300"]}'
```

Відповідь: `{ "totalViews": 123, "results": [{ "url", "ok", "platform", "title", "views", "error" }] }`

## Тести

```bash
npm test
```
