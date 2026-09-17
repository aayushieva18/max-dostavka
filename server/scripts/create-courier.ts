// Заводит нового курьера: свой slug (для ссылки покупателям) и свой
// случайный пароль (для входа на свой экран). Запускать так:
//   npx tsx scripts/create-courier.ts <slug> "<Название>" [стоимость-доставки]
// Например (бесплатная доставка):
//   npx tsx scripts/create-courier.ts svetlana "Доставка от Светланы"
// Или (платная, 200 рублей):
//   npx tsx scripts/create-courier.ts svetlana "Доставка от Светланы" 200
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const prisma = new PrismaClient();

async function main() {
  const [slug, name, feeArg] = process.argv.slice(2);
  if (!slug || !name) {
    console.error(
      'Использование: npx tsx scripts/create-courier.ts <slug> "<Название>" [стоимость-доставки]'
    );
    process.exit(1);
  }

  const ownerToken = randomBytes(9).toString("base64url");
  const deliveryFee = feeArg ? Math.max(0, Math.round(Number(feeArg)) || 0) : 0;

  const courier = await prisma.courier.create({
    data: { slug, name, ownerToken, deliveryFee },
  });

  console.log("Курьер создан:", courier.name);
  console.log("Ссылка для покупателей:", `?courier=${courier.slug}`);
  console.log("Пароль для входа (ownerToken):", courier.ownerToken);
  console.log(
    "Стоимость доставки:",
    courier.deliveryFee === 0 ? "бесплатно" : `${courier.deliveryFee} руб.`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
