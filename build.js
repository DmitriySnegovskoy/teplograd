// Запускается Netlify при каждой публикации сайта.
// Собирает все файлы из папки products/ в один products.json, который читает сайт.
// Если папки products/ нет или она пустая, products.json остаётся как есть.
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "products");
if (!fs.existsSync(dir)) {
  console.log("Папки products нет, оставляю products.json без изменений");
  process.exit(0);
}

const list = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  try {
    list.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  } catch (e) {
    console.warn("Пропускаю повреждённый файл " + f + ": " + e.message);
  }
}
if (!list.length) {
  console.log("В папке products нет товаров, оставляю products.json без изменений");
  process.exit(0);
}

const num = (v) => (typeof v === "number" ? v : 1e9);
list.sort((a, b) => num(a.order) - num(b.order) || String(a.name).localeCompare(String(b.name), "ru"));
fs.writeFileSync(path.join(__dirname, "products.json"), JSON.stringify({ products: list }, null, 1));
console.log("Собрано товаров: " + list.length);
