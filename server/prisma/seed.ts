// Наполняет базу примерами товаров при первом запуске, чтобы было на чём
// проверить работу приложения. Реальные товары хозяйка потом заводит сама
// (через экран курьера — там появится форма добавления товара на следующем шаге).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.product.count();
  if (existing > 0) return;

  await prisma.product.createMany({
    data: [
      { name: "Продукт А", availableQty: 10 },
      { name: "Продукт Б", availableQty: 5 },
    ],
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
