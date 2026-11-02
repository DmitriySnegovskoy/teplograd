// Принимает текст заявки с сайта и пересылает в Telegram.
// Токен бота и id чата берутся из переменных окружения Netlify: TG_TOKEN и TG_CHAT.
// Они НЕ хранятся в коде и не видны посетителям сайта.
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const token = process.env.TG_TOKEN;
  const chat = process.env.TG_CHAT;
  if (!token || !chat) {
    return { statusCode: 500, body: "Telegram is not configured" };
  }

  let text;
  try {
    text = JSON.parse(event.body || "{}").text;
  } catch (e) {
    return { statusCode: 400, body: "Bad JSON" };
  }
  if (typeof text !== "string" || !text.trim() || text.length > 3500) {
    return { statusCode: 400, body: "Bad text" };
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    if (!r.ok) {
      return { statusCode: 502, body: "Telegram error" };
    }
    return { statusCode: 200, body: "ok" };
  } catch (e) {
    return { statusCode: 502, body: "Network error" };
  }
};
