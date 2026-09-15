import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// --- Товары и остатки -------------------------------------------------

// Список товаров, доступных к заказу прямо сейчас (availableQty > 0).
app.get("/api/products", async (_req, res) => {
  const products = await prisma.product.findMany({ orderBy: { id: "asc" } });
  res.json(products);
});

// Хозяйка заводит новый товар (название + сколько есть в наличии сейчас).
app.post("/api/products", async (req, res) => {
  const { name, availableQty } = req.body as { name: string; availableQty: number };
  if (!name.trim()) {
    res.status(400).json({ error: "Название товара не может быть пустым" });
    return;
  }
  const product = await prisma.product.create({
    data: { name: name.trim(), availableQty: availableQty ?? 0 },
  });
  io.emit("products:updated");
  res.json(product);
});

// Хозяйка переименовывает существующий товар.
app.post("/api/products/:id/rename", async (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body as { name: string };
  if (!name.trim()) {
    res.status(400).json({ error: "Название товара не может быть пустым" });
    return;
  }
  const product = await prisma.product.update({
    where: { id },
    data: { name: name.trim() },
  });
  io.emit("products:updated");
  res.json(product);
});

// Хозяйка загружает остаток перед выездом. Полностью задаёт доступное
// количество (не прибавляет, а именно "вот сколько есть сейчас").
app.post("/api/products/:id/stock", async (req, res) => {
  const id = Number(req.params.id);
  const { availableQty } = req.body as { availableQty: number };
  const product = await prisma.product.update({
    where: { id },
    data: { availableQty },
  });
  io.emit("products:updated");
  res.json(product);
});

// --- Покупатель: данные для повторного заказа --------------------------

// Возвращает сохранённые имя/адрес/телефон покупателя по его id в MAX,
// если он уже когда-то заказывал. Иначе — пусто, покупатель вводит сам.
app.get("/api/customers/:maxUserId", async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { maxUserId: req.params.maxUserId },
  });
  res.json(customer);
});

// --- Заказы -------------------------------------------------------------

// Оформление заказа. Проверяет остатки на каждый товар и отклоняет
// заказ целиком, если чего-то уже не хватает (чтобы не разъезжались
// "частично оформленные" заказы).
app.post("/api/orders", async (req, res) => {
  const { maxUserId, name, address, phone, lat, lon, items } = req.body as {
    maxUserId: string;
    name: string;
    address: string;
    phone: string;
    lat: number;
    lon: number;
    items: { productId: number; quantity: number }[];
  };

  try {
    const result = await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const product = await tx.product.findUniqueOrThrow({
          where: { id: item.productId },
        });
        if (product.availableQty < item.quantity) {
          throw new Error(`Товара «${product.name}» не хватает в наличии`);
        }
      }

      for (const item of items) {
        await tx.product.update({
          where: { id: item.productId },
          data: { availableQty: { decrement: item.quantity } },
        });
      }

      const customer = await tx.customer.upsert({
        where: { maxUserId },
        update: { name, address, phone },
        create: { maxUserId, name, address, phone },
      });

      return tx.order.create({
        data: {
          customerId: customer.id,
          // Снимок имени/адреса/телефона на момент ИМЕННО ЭТОГО заказа —
          // не через customer, потому что его данные перезапишутся при
          // следующем заказе того же покупателя.
          name,
          address,
          phone,
          lat,
          lon,
          items: { create: items },
        },
        include: { items: true },
      });
    });

    io.emit("orders:updated");
    io.emit("products:updated");
    res.json(result);
  } catch (e) {
    res.status(400).json({
      error: e instanceof Error ? e.message : "Не удалось оформить заказ",
    });
  }
});

// Заказы на сегодня для экрана хозяйки — с данными покупателя (снимок именно
// этого заказа, см. комментарий в schema.prisma) и составом.
app.get("/api/orders", async (_req, res) => {
  const orders = await prisma.order.findMany({
    where: { status: { in: ["NEW", "ON_THE_WAY"] } },
    include: { items: { include: { product: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json(orders);
});

// Хозяйка нажала «заказ выдал».
app.post("/api/orders/:id/delivered", async (req, res) => {
  const order = await prisma.order.update({
    where: { id: Number(req.params.id) },
    data: { status: "DELIVERED" },
  });
  io.emit("orders:updated");
  res.json(order);
});

// Покупатель нажал «заказ забрал».
app.post("/api/orders/:id/picked-up", async (req, res) => {
  const order = await prisma.order.update({
    where: { id: Number(req.params.id) },
    data: { status: "PICKED_UP" },
  });
  io.emit("orders:updated");
  res.json(order);
});

// --- Живое положение курьера --------------------------------------------
// Курьер (хозяйка) шлёт своё положение через сокет; сервер рассылает
// его всем подключённым покупателям. Ничего не хранится в базе — только
// последнее известное положение в памяти на время работы сервера.
let courierPosition: { lat: number; lon: number } | null = null;

io.on("connection", (socket) => {
  if (courierPosition) socket.emit("courier:position", courierPosition);

  socket.on("courier:position", (position: { lat: number; lon: number }) => {
    courierPosition = position;
    socket.broadcast.emit("courier:position", position);
  });

  // Хозяйка сама считает маршрут у себя на экране (там же, где карта) и
  // присылает готовое время прибытия по каждому заказу — сервер просто
  // разносит эти цифры всем покупателям, ничего не пересчитывает.
  socket.on("orders:eta", (eta: Record<number, number>) => {
    socket.broadcast.emit("orders:eta", eta);
  });
});

const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, () => {
  console.log(`Сервер доставки запущен: http://localhost:${PORT}`);
});
