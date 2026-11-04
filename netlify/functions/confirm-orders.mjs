// Файл: netlify/functions/confirm-orders.mjs
// Что делает: 1С сообщает, какие заказы обработаны (done) и какие нет (failed).
// По failed приходит сообщение в Telegram. Нужен ключ SYNC_SECRET.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function authOk(req) {
  const secret = process.env.SYNC_SECRET || "";
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") || "");
  const expected = Buffer.from("Bearer " + secret);
  return got.length === expected.length && timingSafeEqual(got, expected);
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
  if (!authOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Некорректный JSON" }, 400);
  }
  if (!body || typeof body !== "object") return json({ ok: false, error: "Некорректное тело" }, 400);
  const done = body.done === undefined ? [] : body.done;
  const failed = body.failed === undefined ? [] : body.failed;
  if (!Array.isArray(done) || !Array.isArray(failed) || done.length > 200 || failed.length > 200) {
    return json({ ok: false, error: "Ожидались списки done и failed (не больше 200 в каждом)" }, 400);
  }

  const store = getStore("orders");
  let doneCount = 0;
  let failedCount = 0;
  let unknown = 0;

  for (const id of done.map(String)) {
    const rec = await store.get(`new/${id}`, { type: "json" });
    if (!rec) {
      unknown++; // уже подтверждён раньше или не существует
      continue;
    }
    await store.setJSON(`done/${id}`, { ...rec, status: "done", confirmedAt: new Date().toISOString() });
    await store.delete(`new/${id}`);
    doneCount++;
  }

  for (const f of failed) {
    const id = String((f && f.orderId) ?? "");
    const reason = String((f && f.reason) ?? "причина не указана").slice(0, 300);
    const rec = id ? await store.get(`new/${id}`, { type: "json" }) : null;
    if (!rec) {
      unknown++;
      continue;
    }
    await store.setJSON(`error/${id}`, { ...rec, status: "error", reason, confirmedAt: new Date().toISOString() });
    await store.delete(`new/${id}`);
    failedCount++;
    await sendTelegram(`⚠️ Заказ <b>${escapeHtml(id)}</b> НЕ создан в 1С: ${escapeHtml(reason)}. Внести вручную.`);
  }

  return json({ ok: true, done: doneCount, failed: failedCount, unknown });
};
