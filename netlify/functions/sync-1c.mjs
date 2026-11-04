// Файл: netlify/functions/sync-1c.mjs
// Что делает: принимает от 1С каталог (артикул, цена, наличие) и сохраняет его
// в хранилище Netlify Blobs. Деплой сайта при этом НЕ запускается.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

// Проверка ключа: заголовок Authorization должен быть "Bearer <SYNC_SECRET>"
function authOk(req) {
  const secret = process.env.SYNC_SECRET || "";
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") || "");
  const expected = Buffer.from("Bearer " + secret);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!authOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Тело запроса не является корректным JSON" }, 400);
  }
  if (!Array.isArray(body)) {
    return json({ ok: false, error: "Ожидался массив товаров" }, 400);
  }

  // Проверяем каждый товар; дубли артикулов: побеждает последний
  const items = {};
  let skipped = 0;
  for (const it of body) {
    const sku = it && it.sku !== undefined && it.sku !== null ? String(it.sku).trim() : "";
    const price = it ? it.price : undefined;
    if (!sku || typeof price !== "number" || !Number.isFinite(price) || price < 0 || typeof it.inStock !== "boolean") {
      skipped++;
      continue;
    }
    const rec = { price, inStock: it.inStock };
    if (typeof it.name === "string" && it.name.trim()) rec.name = it.name.trim();
    items[sku] = rec;
  }

  const saved = Object.keys(items).length;
  if (saved === 0) {
    return json({ ok: false, error: "Нет ни одного корректного товара", received: body.length, skipped }, 400);
  }

  const store = getStore("stock");

  // Защита: если товаров стало меньше половины от прежнего количества, данные не принимаем
  let prev = null;
  try {
    prev = await store.get("catalog", { type: "json" });
  } catch {
    prev = null;
  }
  const prevCount = prev && prev.items ? Object.keys(prev.items).length : 0;
  if (prevCount > 20 && saved < prevCount * 0.5) {
    return json(
      { ok: false, error: `Список слишком мал: было ${prevCount}, пришло ${saved}. Данные не приняты.` },
      409
    );
  }

  await store.setJSON("catalog", { updatedAt: new Date().toISOString(), items });
  return json({ ok: true, received: body.length, saved, skipped });
};
