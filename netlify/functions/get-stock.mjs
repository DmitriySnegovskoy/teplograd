// Файл: netlify/functions/get-stock.mjs
// Что делает: отдаёт сайту данные последней выгрузки из 1С. Доступна всем, без ключа.
// Передаются: цена, наличие, название, описание, значок и характеристики.
// Формат ответа:
//   { updatedAt: "2026-11-04T10:00:00.000Z",
//     items: { "83607": { price: 1350, inStock: true, name: "…", description: "…",
//                         icon: "pipe", specs: [["Диаметр","115 мм"]] } } }
// Поля, кроме price и inStock, присутствуют только у тех товаров, по которым их передала 1С.
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
      const rec = { price: v.price, inStock: v.inStock };
      // Эти поля отдаём только если 1С их передавала: иначе сайт оставит своё из админки
      if (typeof v.name === "string") rec.name = v.name;
      if (typeof v.description === "string") rec.description = v.description;
      if (typeof v.icon === "string") rec.icon = v.icon;
      if (Array.isArray(v.specs)) rec.specs = v.specs;
      out.items[sku] = rec;
    }
  }
  // Ответ кэшируется на 60 секунд, чтобы не нагружать функцию
  return json(out, 200, { "Cache-Control": "public, max-age=60" });
};
