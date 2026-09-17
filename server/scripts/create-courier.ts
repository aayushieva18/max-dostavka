// Заводит нового курьера: свой slug (для ссылки покупателям) и свой
// случайный пароль (для входа на свой экран). Запускать так:
//   npx tsx scripts/create-courier.ts <slug> "<Название>"
// Например:
//   npx tsx scripts/create-courier.ts svetlana "Доставка от Светланы"
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";

const prisma = new PrismaClient();

async function main() {
  const [slug, name] = process.argv.slice(2);
  if (!slug || !name) {
    console.error('Использование: npx tsx scripts/create-courier.ts <slug> "<Название>"');
    process.exit(1);
  }

  const ownerToken = randomBytes(9).toString("base64url");

  const courier = await prisma.courier.create({
    data: { slug, name, ownerToken },
  });

  console.log("Курьер создан:", courier.name);
  console.log("Ссылка для покупателей:", `?courier=${courier.slug}`);
  console.log("Пароль для входа (ownerToken):", courier.ownerToken);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
