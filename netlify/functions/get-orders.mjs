// Файл: netlify/functions/get-orders.mjs
// Что делает: отдаёт 1С новые (ещё не подтверждённые) заказы. Нужен ключ SYNC_SECRET.
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

function authOk(req) {
  const secret = process.env.SYNC_SECRET || "";
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") || "");
  const expected = Buffer.from("Bearer " + secret);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export default async (req) => {
  if (req.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!authOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  const store = getStore("orders");
  const { blobs } = await store.list({ prefix: "new/" });

  const orders = [];
  for (const b of blobs.slice(0, 200)) {
    const rec = await store.get(b.key, { type: "json" });
    if (rec && rec.order && rec.status === "new") orders.push(rec.order);
  }
  // Старые заказы первыми, не больше 50 за раз
  orders.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return json({ orders: orders.slice(0, 50) });
};
