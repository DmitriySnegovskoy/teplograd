// Файл: netlify/functions/sync-1c.mjs
// Что делает: принимает от 1С каталог товаров и сохраняет его в хранилище Netlify Blobs.
// Деплой сайта при этом НЕ запускается — сайт подхватит новые данные при загрузке страницы.
//
// ====================== ЧТО ПЕРЕДАЁТСЯ ИЗ 1С НА КАЖДЫЙ ТОВАР ======================
// Обязательные поля:
//   sku          артикул — строка или число, до 64 знаков. По нему товар связывается с сайтом.
//   price        цена в рублях — число, 0 или больше.
//   inStock      наличие — true или false (именно логическое значение, не строка).
//
// Необязательные поля (если переданы — перезаписывают то, что заполнено в админке сайта):
//   name         название товара, до 200 знаков.
//   description  описание для карточки товара, до 5000 знаков. Форматирование — см. ниже.
//   icon         значок, который показывается, когда у товара нет фото. Допустимые значения:
//                fit (фитинг), pump (насос), valve (кран, клапан), coll (коллектор),
//                boil (котёл), heater (водонагреватель), rad (радиатор), pipe (труба),
//                tube (труба в бухте), hose (гибкая подводка), chim (дымоход),
//                mat (нагревательный мат), therm (терморегулятор).
//                Можно передавать и по-русски: «насос», «котёл», «радиатор» и т. п.
//   specs        характеристики — таблица «название / значение» в карточке товара, до 40 строк.
//
//   Поле, которое 1С не передала, остаётся прежним — тем, что заполнено в админке сайта.
//   Чтобы стереть описание или характеристики, передайте пустую строку "" или пустой список [].
//
// ====================== ФОРМАТИРОВАНИЕ ОПИСАНИЯ (служебные символы) ======================
// Описание — обычный текст. Чтобы в карточке товара сохранились абзацы, списки и выделение,
// в тексте используются служебные символы:
//
//   \n            перенос строки внутри абзаца (в JSON это два знака: обратная косая и «n»)
//   \n\n          новый абзац (то есть пустая строка между абзацами)
//   - текст       пункт списка. Вместо «-» можно «•» или «*»
//   1. текст      пункт нумерованного списка (1. 2. 3. …)
//   ## текст      подзаголовок внутри описания
//   **текст**     жирный шрифт
//   *текст*       курсив (можно и _текст_)
//   ---           горизонтальная линия-разделитель
//
// Пример значения поля description в JSON (одной строкой):
//   "Настенный газовый котёл с закрытой камерой сгорания.\n\n## Особенности\n- КПД **92,5 %**\n- Медный теплообменник\n\nГарантия — 5 лет."
//
// Если 1С выгружает описание с настоящими переводами строк — это тоже работает.
// Если описание хранится в 1С как HTML — теги <p>, <br>, <b>, <li> будут распознаны и
// переведены в этот же простой формат, остальные теги вырезаются. HTML на сайт не попадает,
// любые теги в описании показываются как текст, поэтому вставить чужой код через выгрузку нельзя.
//
// ====================== ПРИМЕР ЗАПРОСА ======================
// POST /.netlify/functions/sync-1c
// Authorization: Bearer <SYNC_SECRET>
// Content-Type: application/json
//
// [
//   { "sku": "83607", "price": 1350, "inStock": true },
//   { "sku": "VT-21A", "price": 28900, "inStock": false,
//     "name": "Котёл газовый настенный 24 кВт",
//     "description": "Настенный газовый котёл.\n\n- КПД **92,5 %**\n- Гарантия 5 лет",
//     "icon": "boil",
//     "specs": [ { "name": "Мощность", "value": "24 кВт" }, { "name": "Камера сгорания", "value": "закрытая" } ] }
// ]
//
// Характеристики (specs) принимаются в любом из четырёх видов:
//   1) [ { "name": "Мощность", "value": "24 кВт" } ]     (можно «Наименование» / «Значение»)
//   2) [ ["Мощность", "24 кВт"] ]
//   3) { "Мощность": "24 кВт", "Вес": "30 кг" }
//   4) "Мощность: 24 кВт\nВес: 30 кг"                    (каждая строка — одна характеристика)
//
// Ответ: { ok: true, received, saved, skipped, withName, withDescription, withIcon, withSpecs }
// «skipped» — товары, у которых не было артикула, цены или наличия: они не сохранены.

import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

// Ограничения на длину — защита от случайной выгрузки «простыни» текста
const MAX = { sku: 64, name: 200, description: 5000, specName: 120, specValue: 200, specCount: 40 };

// Значки, которые умеет рисовать сайт
const ICONS = new Set([
  "fit", "pump", "valve", "coll", "boil", "heater", "rad", "pipe", "tube", "hose", "chim", "mat", "therm",
]);

// Если 1С присылает значок по-русски
const ICON_ALIAS = {
  "фитинг": "fit", "фитинги": "fit", "насос": "pump", "кран": "valve", "клапан": "valve",
  "арматура": "valve", "коллектор": "coll", "котел": "boil", "котёл": "boil",
  "водонагреватель": "heater", "бойлер": "heater", "радиатор": "rad", "труба": "pipe",
  "бухта": "tube", "подводка": "hose", "шланг": "hose", "дымоход": "chim",
  "мат": "mat", "терморегулятор": "therm", "термостат": "therm",
};

// Проверка ключа: заголовок Authorization должен быть "Bearer <SYNC_SECRET>"
function authOk(req) {
  const secret = process.env.SYNC_SECRET || "";
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") || "");
  const expected = Buffer.from("Bearer " + secret);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ---------- Подготовка текста ----------

const ENTITY = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", laquo: "«", raquo: "»",
  mdash: "—", ndash: "–", deg: "°", times: "×", middot: "·", hellip: "…", sup2: "²", sup3: "³",
};

// Превращает мнемоники вида &nbsp; и &#1090; в обычные символы
function decodeEntities(s) {
  return s
    .replace(/&#(\d{1,7});/g, (m, n) => {
      const c = Number(n);
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => {
      const c = parseInt(n, 16);
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
    })
    .replace(/&([a-z][a-z0-9]{1,9});/gi, (m, n) => {
      const v = ENTITY[n.toLowerCase()];
      return v === undefined ? m : v;
    });
}

// Если описание пришло из 1С в виде HTML — переводим его в простой текст со служебными символами
function htmlToMarkers(s) {
  return s
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*\/\s*li\s*>/gi, "")
    .replace(/<\s*\/\s*(p|div|tr|h[1-6]|ul|ol|table)\s*>/gi, "\n")
    .replace(/<\s*(p|div|tr|ul|ol|table)[^>]*>/gi, "\n")
    .replace(/<\s*h[1-6][^>]*>/gi, "\n## ")
    .replace(/<\s*(b|strong)\s*>([\s\S]*?)<\s*\/\s*(?:b|strong)\s*>/gi, "**$2**")
    .replace(/<\s*(i|em)\s*>([\s\S]*?)<\s*\/\s*(?:i|em)\s*>/gi, "*$2*")
    .replace(/<\s*hr\s*\/?\s*>/gi, "\n---\n")
    .replace(/<[^>]*>/g, "");
}

// Приводит описание к виду, который понимает карточка товара
function cleanDescription(raw) {
  let s = String(raw);
  if (/<[a-z!/][^>]*>/i.test(s)) s = htmlToMarkers(s);
  s = decodeEntities(s);
  // Переводы строк, записанные текстом (\n, \r\n, \t) — так их часто выгружает 1С
  s = s.replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\\t/g, " ");
  // Настоящие переводы строк и невидимые символы
  s = s.replace(/\r\n?/g, "\n").replace(/ /g, " ").replace(/[​-‍﻿­]/g, "");
  // Лишние пробелы в строках и лишние пустые строки
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > MAX.description ? s.slice(0, MAX.description).trim() : s;
}

// Для названий и значений характеристик: одна строка без тегов и переводов строк
function cleanLine(raw, max) {
  let s = decodeEntities(String(raw).replace(/<[^>]*>/g, " "));
  s = s.replace(/\\r\\n|\\n|\\r|\\t/g, " ").replace(/\s+/g, " ").replace(/­/g, "").trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

function cleanIcon(raw) {
  const v = String(raw).trim().toLowerCase();
  if (ICONS.has(v)) return v;
  return ICON_ALIAS[v] || null;
}

// ---------- Характеристики ----------

// Разбирает строку вида "Мощность: 24 кВт" или "Мощность = 24 кВт"
function splitSpecLine(line) {
  const m = String(line).match(/^([^:=\t]{1,200})[:=\t]\s*([\s\S]+)$/);
  return m ? [m[1], m[2]] : null;
}

function parseSpecs(raw) {
  const pairs = [];
  const push = (n, v) => {
    if (n === undefined || n === null || v === undefined || v === null) return;
    pairs.push([n, typeof v === "boolean" ? (v ? "да" : "нет") : v]);
  };

  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (!it) continue;
      if (Array.isArray(it)) push(it[0], it[1]);
      else if (typeof it === "object") {
        push(
          it.name ?? it.key ?? it.label ?? it["Наименование"] ?? it["Название"] ?? it["Имя"] ?? it["Свойство"],
          it.value ?? it.val ?? it["Значение"]
        );
      } else if (typeof it === "string") {
        const p = splitSpecLine(it);
        if (p) push(p[0], p[1]);
      }
    }
  } else if (typeof raw === "string") {
    const text = cleanDescription(raw);
    for (const line of text.split(/\n|;/)) {
      const l = line.replace(/^[-–—•*]\s*/, "").trim();
      if (!l) continue;
      const p = splitSpecLine(l);
      if (p) push(p[0], p[1]);
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) push(k, v);
  }

  const out = [];
  const seen = new Set();
  for (const [n0, v0] of pairs) {
    const n = cleanLine(n0, MAX.specName);
    const v = cleanLine(v0, MAX.specValue);
    if (!n || !v) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([n, v]);
    if (out.length >= MAX.specCount) break;
  }
  return out;
}

// ---------- Обработка запроса ----------

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!authOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Тело запроса не является корректным JSON" }, 400);
  }
  // Допускаем и массив, и {items:[...]} или {products:[...]} — как удобнее выгружать из 1С
  const list = Array.isArray(body)
    ? body
    : body && Array.isArray(body.items)
    ? body.items
    : body && Array.isArray(body.products)
    ? body.products
    : null;
  if (!list) {
    return json({ ok: false, error: "Ожидался массив товаров" }, 400);
  }

  // Проверяем каждый товар; дубли артикулов: побеждает последний
  const items = {};
  let skipped = 0;
  const stat = { withName: 0, withDescription: 0, withIcon: 0, withSpecs: 0, badIcon: 0 };

  for (const it of list) {
    const sku = it && it.sku !== undefined && it.sku !== null ? String(it.sku).trim() : "";
    const price = it ? it.price : undefined;
    if (
      !sku ||
      sku.length > MAX.sku ||
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price < 0 ||
      typeof it.inStock !== "boolean"
    ) {
      skipped++;
      continue;
    }

    const rec = { price, inStock: it.inStock };

    // Название
    if (typeof it.name === "string") {
      const name = cleanLine(it.name, MAX.name);
      if (name) {
        rec.name = name;
        stat.withName++;
      }
    }

    // Описание: "" (пустая строка) — это команда «стереть описание на сайте»
    if (typeof it.description === "string") {
      const d = cleanDescription(it.description);
      rec.description = d;
      if (d) stat.withDescription++;
    }

    // Значок вместо фото
    if (it.icon !== undefined && it.icon !== null && String(it.icon).trim() !== "") {
      const icon = cleanIcon(it.icon);
      if (icon) {
        rec.icon = icon;
        stat.withIcon++;
      } else {
        stat.badIcon++;
      }
    }

    // Характеристики: пустой список — это команда «стереть характеристики на сайте»
    if (it.specs !== undefined && it.specs !== null) {
      const specs = parseSpecs(it.specs);
      rec.specs = specs;
      if (specs.length) stat.withSpecs++;
    }

    items[sku] = rec;
  }

  const saved = Object.keys(items).length;
  if (saved === 0) {
    return json({ ok: false, error: "Нет ни одного корректного товара", received: list.length, skipped }, 400);
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
  return json({ ok: true, received: list.length, saved, skipped, ...stat });
};
