// Файл: netlify/functions/get-stock.mjs
// Что делает: отдаёт сайту актуальные цены и наличие (без названий). Доступна всем.
import { getStore } from "@netlify/blobs";

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

export default async (req) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, { "Cache-Control": "no-store" });

  let data = null;
  try {
    data = await getStore("stock").get("catalog", { type: "json" });
  } catch {
    data = null;
  }

  const out = { updatedAt: data && data.updatedAt ? data.updatedAt : null, items: {} };
  if (data && data.items) {
    for (const [sku, v] of Object.entries(data.items)) {
      out.items[sku] = { price: v.price, inStock: v.inStock };
    }
  }
  // Ответ кэшируется на 60 секунд, чтобы не нагружать функцию
  return json(out, 200, { "Cache-Control": "public, max-age=60" });
};
