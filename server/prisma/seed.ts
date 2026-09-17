// Наполняет ПУСТУЮ локальную базу тестовым курьером и примерами товаров,
// чтобы было на чём проверить работу приложения. Реальные курьеры заводятся
// через server/scripts/create-courier.ts, реальные товары — через экран
// курьера в самом приложении.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.courier.count();
  if (existing > 0) return;

  await prisma.courier.create({
    data: {
      slug: "test",
      name: "Тестовый курьер",
      ownerToken: "test-owner-token",
      products: {
        create: [
          { name: "Продукт А", availableQty: 10 },
          { name: "Продукт Б", availableQty: 5 },
        ],
      },
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
