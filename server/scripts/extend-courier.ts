// Продлевает доступ курьеру, который заплатил за следующий период.
// Если срок ещё не истёк — продление считается от текущей даты окончания
// (не сгорает остаток оплаченных дней), если уже истёк — от сегодняшнего дня.
// Запускать так:
//   npx tsx scripts/extend-courier.ts <slug> [дней]
// Например (на 30 дней, по умолчанию):
//   npx tsx scripts/extend-courier.ts svetlana
// Или на другой срок:
//   npx tsx scripts/extend-courier.ts svetlana 14
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const [slug, daysArg] = process.argv.slice(2);
  if (!slug) {
    console.error("Использование: npx tsx scripts/extend-courier.ts <slug> [дней]");
    process.exit(1);
  }
  const days = daysArg ? Math.max(1, Math.round(Number(daysArg)) || 30) : 30;

  const courier = await prisma.courier.findUnique({ where: { slug } });
  if (!courier) {
    console.error("Курьер с таким slug не найден:", slug);
    process.exit(1);
  }

  const now = new Date();
  const base = courier.expiresAt && courier.expiresAt > now ? courier.expiresAt : now;
  const expiresAt = new Date(base);
  expiresAt.setDate(expiresAt.getDate() + days);

  await prisma.courier.update({ where: { slug }, data: { expiresAt } });

  console.log("Курьер:", courier.name);
  console.log("Доступ продлён до:", expiresAt.toLocaleDateString("ru-RU"));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
