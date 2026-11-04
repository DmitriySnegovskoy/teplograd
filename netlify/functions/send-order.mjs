// Файл: netlify/functions/send-order.mjs
// Что делает: принимает заказ из формы сайта, проверяет его, кладёт в очередь
// (откуда его заберёт 1С) и сразу присылает сообщение в Telegram.
import { getStore } from "@netlify/blobs";
import { randomInt } from "node:crypto";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Приводит телефон к виду +7XXXXXXXXXX (или +цифры для иностранных номеров); null, если не похоже на телефон
function normalizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && (d[0] === "7" || d[0] === "8")) return "+7" + d.slice(1);
  if (d.length === 10) return "+7" + d;
  if (d.length >= 11 && d.length <= 15) return "+" + d;
  return null;
}

// Номер заказа вида TG-20261103-A7K2 (дата по UTC)
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeOrderId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let r = "";
  for (let i = 0; i < 4; i++) r += ALPHABET[randomInt(ALPHABET.length)];
  return `TG-${d}-${r}`;
}

async function sendTelegram(text) {
  const token = process.env.TG_TOKEN;
  const chatId = process.env.TG_CHAT;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let b;
  try {
    b = await req.json();
  } catch {
    return json({ ok: false, error: "Некорректные данные формы" }, 400);
  }
  if (!b || typeof b !== "object") return json({ ok: false, error: "Некорректные данные формы" }, 400);

  // Скрытое поле-ловушка: если заполнено, это бот. Молча отвечаем «успех» и ничего не сохраняем.
  if (b.website) return json({ ok: true });

  // ---- Проверка данных ----
  const name = String(b.customerName || "").trim();
  if (name.length < 2 || name.length > 100) {
    return json({ ok: false, error: "Укажите имя (от 2 до 100 символов)" }, 400);
  }
  const phone = normalizePhone(b.phone);
  if (!phone) return json({ ok: false, error: "Укажите корректный номер телефона" }, 400);
  const comment = String(b.comment || "").trim();
  if (comment.length > 500) return json({ ok: false, error: "Комментарий слишком длинный (до 500 символов)" }, 400);

  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 50) {
    return json({ ok: false, error: "В заказе должно быть от 1 до 50 позиций" }, 400);
  }
  const qtyBySku = new Map();
  const nameBySku = new Map(); // название от сайта: только для сообщения в Telegram, в 1С не передаётся
  for (const it of b.items) {
    const sku = String((it && it.sku) ?? "").trim();
    const qty = it ? it.quantity : undefined;
    if (!sku || sku.length > 64 || !Number.isInteger(qty) || qty < 1 || qty > 999) {
      return json({ ok: false, error: "Некорректная позиция в заказе" }, 400);
    }
    qtyBySku.set(sku, (qtyBySku.get(sku) || 0) + qty);
    if (it && typeof it.name === "string" && it.name.trim()) nameBySku.set(sku, it.name.trim().slice(0, 200));
  }

  // ---- Сверка артикулов с выгрузкой из 1С ----
  // Товары «под заказ» (inStock = false) заказывать МОЖНО. Артикул, которого нет в выгрузке 1С,
  // не отклоняем (менеджер разберётся), а помечаем в сообщении Telegram.
  let catalog = null;
  try {
    catalog = await getStore("stock").get("catalog", { type: "json" });
  } catch {
    catalog = null;
  }
  const known = catalog && catalog.items ? catalog.items : null;
  const items = [];
  for (const [sku, quantity] of qtyBySku) {
    if (quantity > 999) return json({ ok: false, error: "Слишком большое количество" }, 400);
    const rec = known ? known[sku] : null;
    items.push({
      sku,
      quantity,
      name: nameBySku.get(sku) || (rec && rec.name) || "",
      unknown: !!known && !rec,
    });
  }

  const orderId = makeOrderId();
  const order = {
    orderId,
    createdAt: new Date().toISOString(),
    customerName: name,
    phone,
    comment,
    items: items.map(({ sku, quantity }) => ({ sku, quantity })),
  };

  // ---- Шаг 1: кладём заказ в очередь для 1С ----
  let saved = false;
  try {
    await getStore("orders").setJSON(`new/${orderId}`, { order, status: "new" });
    saved = true;
  } catch (e) {
    console.error("Не удалось сохранить заказ в очередь", orderId);
  }

  // ---- Шаг 2: сообщение в Telegram ----
  const lines = items.map(
    (i) =>
      `• ${escapeHtml(i.sku)}${i.name ? " — " + escapeHtml(i.name) : ""} × ${i.quantity}` +
      (i.unknown ? " ⚠️ нет в выгрузке 1С" : "")
  );
  const text = [
    `🛒 <b>Новый заказ ${orderId}</b>`,
    `Имя: ${escapeHtml(name)}`,
    `Телефон: ${escapeHtml(phone)}`,
    comment ? `Комментарий: ${escapeHtml(comment)}` : null,
    "Товары:",
    ...lines,
    saved
      ? "Статус: ждёт забора из 1С"
      : "⚠️ В ОЧЕРЕДЬ НЕ СОХРАНЁН — внести в 1С вручную",
  ]
    .filter(Boolean)
    .join("\n");
  const telegramOk = await sendTelegram(text);

  if (!saved && !telegramOk) {
    return json({ ok: false, error: "Не удалось принять заказ, позвоните нам" }, 502);
  }
  return json({ ok: true, orderId });
};
