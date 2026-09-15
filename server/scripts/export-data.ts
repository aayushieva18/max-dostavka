// Выгружает все данные (товары, покупателей, заказы) в один JSON-файл —
// нужно перед переездом с локальной SQLite на настоящую базу в интернете,
// чтобы ничего не потерять. Ничего не удаляет и не меняет.
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "fs";

const prisma = new PrismaClient();

async function main() {
  const [products, customers, orders] = await Promise.all([
    prisma.product.findMany(),
    prisma.customer.findMany(),
    prisma.order.findMany({ include: { items: true } }),
  ]);

  const dump = { products, customers, orders };
  writeFileSync("data-export.json", JSON.stringify(dump, null, 2), "utf-8");

  console.log(
    `Сохранено: ${products.length} товаров, ${customers.length} покупателей, ${orders.length} заказов → server/data-export.json`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
