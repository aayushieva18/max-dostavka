// Загружает данные из server/data-export.json в базу, на которую сейчас
// настроен Prisma (см. DATABASE_URL) — используется один раз, при переезде
// на новую базу в интернете, чтобы вернуть курьеров/товары/покупателей/заказы.
// Запускать на ПУСТОЙ базе (сразу после первой миграции), иначе будут
// задвоения.
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";

const prisma = new PrismaClient();

type Dump = {
  couriers: { id: number; slug: string; name: string; ownerToken: string }[];
  products: { id: number; courierId: number; name: string; availableQty: number; imageUrl: string | null }[];
  customers: {
    id: number;
    courierId: number;
    maxUserId: string;
    name: string;
    address: string;
    phone: string;
  }[];
  orders: {
    id: number;
    courierId: number;
    customerId: number;
    name: string;
    address: string;
    phone: string;
    status: string;
    lat: number;
    lon: number;
    createdAt: string;
    items: { productId: number; quantity: number }[];
  }[];
};

async function main() {
  const dump: Dump = JSON.parse(readFileSync("data-export.json", "utf-8"));

  if ((await prisma.courier.count()) === 0) {
    for (const courier of dump.couriers) {
      await prisma.courier.create({ data: courier });
    }
  }
  if ((await prisma.product.count()) === 0) {
    for (const product of dump.products) {
      await prisma.product.create({ data: product });
    }
  }
  if ((await prisma.customer.count()) === 0) {
    for (const customer of dump.customers) {
      await prisma.customer.create({ data: customer });
    }
  }
  for (const order of dump.orders) {
    await prisma.order.create({
      data: {
        id: order.id,
        courierId: order.courierId,
        customerId: order.customerId,
        name: order.name,
        address: order.address,
        phone: order.phone,
        status: order.status as never,
        lat: order.lat,
        lon: order.lon,
        createdAt: new Date(order.createdAt),
        items: {
          create: order.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
          })),
        },
      },
    });
  }

  // Все записи вставлены с их старыми id напрямую — двигаем автосчётчики
  // Postgres вперёд, иначе следующая НОВАЯ запись попробует взять уже
  // занятый номер.
  for (const table of ["Courier", "Product", "Customer", "Order", "OrderItem"]) {
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1))`
    );
  }

  console.log(
    `Загружено: ${dump.couriers.length} курьеров, ${dump.products.length} товаров, ${dump.customers.length} покупателей, ${dump.orders.length} заказов`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
