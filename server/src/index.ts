import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server, type Socket } from "socket.io";
import { PrismaClient, Prisma, type Courier } from "@prisma/client";

// Ошибка, которую специально показываем покупателю/курьеру как есть (текст
// понятный, без внутренних деталей) — в отличие от любой другой ошибки
// (например, от Prisma), где наружу должно уходить только общее сообщение.
class UserFacingError extends Error {}

// Настоящее сообщение покупателю прямо в MAX (через Bot API того же бота,
// что открывает мини-приложение) — в отличие от живого обновления статуса
// на экране, доходит, даже если покупатель уже закрыл приложение. Работает
// только для покупателей, реально открывших мини-приложение ВНУТРИ MAX —
// у них maxUserId это настоящий числовой id пользователя MAX; у заказов из
// обычного браузера (без MAX) там либо случайный id браузера (с дефисами),
// либо "manual:<телефон>" (ручной заказ хозяйки) — таким отправить нельзя,
// у них нет открытого диалога с ботом. MAX_BOT_TOKEN берётся из настроек
// бота на business.max.ru → "Токен доступа"; если переменная не задана,
// просто тихо не отправляем (чтобы это не ломало саму отметку заказа).
async function sendMaxMessage(maxUserId: string, text: string) {
  const token = process.env.MAX_BOT_TOKEN;
  if (!token) {
    console.log("MAX Bot API: пропущено — MAX_BOT_TOKEN не задан");
    return;
  }
  if (!/^\d+$/.test(maxUserId)) {
    console.log("MAX Bot API: пропущено — не настоящий id MAX", maxUserId);
    return;
  }
  try {
    const res = await fetch(`https://platform-api2.max.ru/messages?user_id=${maxUserId}`, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error("MAX Bot API: не удалось отправить сообщение", res.status, await res.text());
    } else {
      console.log("MAX Bot API: сообщение отправлено", maxUserId);
    }
  } catch (e) {
    console.error("MAX Bot API: ошибка запроса", e);
  }
}

const prisma = new PrismaClient();
const app = express();
app.use(cors());
// Фото товара едет как data-url прямо в теле запроса — увеличиваем лимит
// (по умолчанию у express он всего 100кб, фото туда не влезет).
app.use(express.json({ limit: "5mb" }));
// Данные (заказы, остатки) постоянно меняются, а сеть перед сервером (Render
// работает через Cloudflare) может закешировать ответ и отдавать всем один и
// тот же старый — из-за этого один раз даже правильный пароль хозяйки не
// проходил, потому что сеть запомнила первый неудачный ответ. Запрещаем
// кеширование вообще для всех запросов к API.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// --- Курьеры (многокурьерность) -----------------------------------------
// Каждый курьер видит только свои товары, покупателей и заказы. У курьера
// свой пароль (ownerToken) для входа на свой экран и свой публичный slug
// для ссылки покупателям (?courier=slug) — не секрет, можно давать всем.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Полный объект курьера (не только id) — чтобы в самой транзакции
      // оформления заказа не делать лишний запрос к базе (это уже стоило
      // одного упавшего по таймауту заказа, когда транзакция стала на один
      // запрос длиннее допустимых 5 секунд).
      courier?: Courier;
      courierId?: number;
    }
  }
}

// Список заказов и управление товарами — это данные и действия курьера
// (имена/адреса/телефоны покупателей, изменение остатков), а не покупателей.
// Раньше эти пути были открыты вообще без проверки — любой человек с
// адресом сервера мог посмотреть все заказы. Закрываем секретным паролем;
// заодно по этому паролю сервер узнаёт, КАКОГО именно курьера показывать.
// Курьер с истёкшим сроком (expiresAt в прошлом) не должен работать вообще —
// ни его собственный экран, ни витрина для его покупателей. null означает
// "без ограничения" (так у Арюны — первого курьера в проекте).
function isExpired(courier: Courier): boolean {
  return courier.expiresAt !== null && courier.expiresAt < new Date();
}

async function requireOwner(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.header("x-owner-token");
  const courier = token ? await prisma.courier.findUnique({ where: { ownerToken: token } }) : null;
  if (!courier) {
    res.status(401).json({ error: "Неверный пароль хозяйки" });
    return;
  }
  if (isExpired(courier)) {
    res.status(403).json({ error: "Доступ временно приостановлен — обратись к администратору" });
    return;
  }
  req.courier = courier;
  req.courierId = courier.id;
  next();
}

// Покупательские запросы указывают курьера открыто, по slug из ссылки
// (?courier=slug) — это не секрет, просто адрес конкретной витрины.
async function resolveCourierBySlug(req: express.Request, res: express.Response, next: express.NextFunction) {
  const slug = (req.query.courier as string) || (req.body?.courier as string);
  const courier = slug ? await prisma.courier.findUnique({ where: { slug } }) : null;
  if (!courier) {
    res.status(404).json({ error: "Такой ссылки для заказа не существует" });
    return;
  }
  if (isExpired(courier)) {
    res.status(403).json({ error: "Магазин временно недоступен" });
    return;
  }
  req.courier = courier;
  req.courierId = courier.id;
  next();
}

// Данные о самом курьере (свой slug/название) — нужно клиенту, чтобы знать,
// в какую "комнату" сокета подключаться, и что показать в шапке экрана.
app.get("/api/me", requireOwner, async (req, res) => {
  const courier = req.courier!;
  res.json({
    id: courier.id,
    slug: courier.slug,
    name: courier.name,
    deliveryFee: courier.deliveryFee,
  });
});

// Курьер меняет свою стоимость доставки (0 — бесплатно). Не трогает уже
// оформленные заказы — у них своя сохранённая на момент заказа цена.
app.post("/api/me/delivery-fee", requireOwner, async (req, res) => {
  const { deliveryFee } = req.body as { deliveryFee: number };
  const courier = await prisma.courier.update({
    where: { id: req.courierId },
    data: { deliveryFee: Math.max(0, Math.round(deliveryFee) || 0) },
  });
  res.json({ deliveryFee: courier.deliveryFee });
});

// Публичная информация о курьере (название, стоимость доставки) — нужна
// покупателю в форме заказа, до входа и без пароля.
app.get("/api/courier", resolveCourierBySlug, async (req, res) => {
  const courier = req.courier!;
  res.json({ name: courier.name, deliveryFee: courier.deliveryFee });
});

// --- Товары и остатки -------------------------------------------------

// Список товаров, доступных к заказу прямо сейчас (availableQty > 0),
// у конкретного курьера.
app.get("/api/products", resolveCourierBySlug, async (req, res) => {
  const products = await prisma.product.findMany({
    where: { courierId: req.courierId, archived: false },
    orderBy: { id: "asc" },
  });
  res.json(products);
});

// Хозяйка заводит новый товар (название + сколько есть в наличии сейчас,
// фото — необязательно).
app.post("/api/products", requireOwner, async (req, res) => {
  const { name, availableQty, imageUrl } = req.body as {
    name: string;
    availableQty: number;
    imageUrl?: string | null;
  };
  if (!name.trim()) {
    res.status(400).json({ error: "Название товара не может быть пустым" });
    return;
  }
  const product = await prisma.product.create({
    data: {
      courierId: req.courierId!,
      name: name.trim(),
      availableQty: availableQty ?? 0,
      imageUrl: imageUrl ?? null,
    },
  });
  io.to(courierRoom(req.courierId!)).emit("products:updated");
  res.json(product);
});

// Хозяйка добавляет или меняет фото товара.
app.post("/api/products/:id/image", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const { imageUrl } = req.body as { imageUrl: string | null };
  const product = await prisma.product.update({
    where: { id, courierId: req.courierId },
    data: { imageUrl },
  });
  io.to(courierRoom(req.courierId!)).emit("products:updated");
  res.json(product);
});

// Хозяйка переименовывает существующий товар.
app.post("/api/products/:id/rename", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body as { name: string };
  if (!name.trim()) {
    res.status(400).json({ error: "Название товара не может быть пустым" });
    return;
  }
  const product = await prisma.product.update({
    where: { id, courierId: req.courierId },
    data: { name: name.trim() },
  });
  io.to(courierRoom(req.courierId!)).emit("products:updated");
  res.json(product);
});

// Хозяйка загружает остаток перед выездом. Полностью задаёт доступное
// количество (не прибавляет, а именно "вот сколько есть сейчас").
app.post("/api/products/:id/stock", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const { availableQty } = req.body as { availableQty: number };
  const product = await prisma.product.update({
    where: { id, courierId: req.courierId },
    data: { availableQty },
  });
  io.to(courierRoom(req.courierId!)).emit("products:updated");
  res.json(product);
});

// "Удаление" товара — на самом деле скрытие (archived = true), не настоящее
// удаление строки: если товар уже фигурировал в чьих-то прошлых заказах,
// обычный DELETE упёрся бы в внешний ключ OrderItem → Product и либо упал с
// ошибкой, либо (если бы разрешили каскад) стёр бы состав старых заказов.
// Скрытый товар просто перестаёт отдаваться и покупателям, и на экране
// хозяйки — прошлые заказы с ним по-прежнему показываются как есть.
app.post("/api/products/:id/delete", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const product = await prisma.product.update({
    where: { id, courierId: req.courierId },
    data: { archived: true },
  });
  io.to(courierRoom(req.courierId!)).emit("products:updated");
  res.json(product);
});

// --- Покупатель: данные для повторного заказа --------------------------

// Возвращает сохранённые имя/адрес/телефон покупателя (у конкретного
// курьера) по его id в MAX, если он уже когда-то заказывал именно у него.
app.get("/api/customers/:maxUserId", resolveCourierBySlug, async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { courierId_maxUserId: { courierId: req.courierId!, maxUserId: String(req.params.maxUserId) } },
  });
  res.json(customer);
});

// Вся история заказов ЭТОГО покупателя у этого курьера (не только текущий
// активный) — чтобы после перезахода в приложение покупатель видел, что уже
// заказывал, и не терял из виду свой заказ в пути.
app.get("/api/customer-orders/:maxUserId", resolveCourierBySlug, async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { courierId_maxUserId: { courierId: req.courierId!, maxUserId: String(req.params.maxUserId) } },
  });
  if (!customer) {
    res.json([]);
    return;
  }
  const orders = await prisma.order.findMany({
    where: { customerId: customer.id },
    include: { items: { include: { product: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(orders);
});

// --- Заказы -------------------------------------------------------------

// Оформление заказа — общая логика и для обычной формы покупателя, и для
// ручного оформления хозяйкой (когда покупатель звонит сам, потому что не
// смог разобраться с приложением). Проверяет остатки на каждый товар и
// отклоняет заказ целиком, если чего-то уже не хватает (чтобы не
// разъезжались "частично оформленные" заказы).
async function createOrderInTransaction(
  tx: Prisma.TransactionClient,
  courierId: number,
  deliveryFee: number,
  data: {
    maxUserId: string;
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    items: { productId: number; quantity: number }[];
  }
) {
  // Проверка остатка и списание — одним атомарным запросом на товар (а не
  // "сначала проверить, потом списать" отдельно), чтобы не было случая,
  // когда между проверкой и списанием кто-то другой успел разобрать тот же
  // товар. Заодно вдвое короче транзакция — раньше на каждый товар уходило
  // два обращения к базе, теперь одно.
  for (const item of data.items) {
    const decremented = await tx.product.updateMany({
      where: { id: item.productId, courierId, availableQty: { gte: item.quantity } },
      data: { availableQty: { decrement: item.quantity } },
    });
    if (decremented.count === 0) {
      const product = await tx.product.findUnique({ where: { id: item.productId, courierId } });
      throw new UserFacingError(
        product ? `Товара «${product.name}» не хватает в наличии` : "Такого товара не существует"
      );
    }
  }

  const customer = await tx.customer.upsert({
    where: { courierId_maxUserId: { courierId, maxUserId: data.maxUserId } },
    update: { name: data.name, address: data.address, phone: data.phone },
    create: { courierId, maxUserId: data.maxUserId, name: data.name, address: data.address, phone: data.phone },
  });

  return tx.order.create({
    data: {
      courierId,
      customerId: customer.id,
      // Снимок имени/адреса/телефона/стоимости доставки на момент ИМЕННО
      // ЭТОГО заказа — не через customer/courier напрямую, потому что их
      // данные могут поменяться позже (адрес — при следующем заказе, цена
      // доставки — если курьер её изменит).
      name: data.name,
      address: data.address,
      phone: data.phone,
      comment: data.comment?.trim() || null,
      deliveryFee,
      lat: data.lat,
      lon: data.lon,
      items: { create: data.items },
    },
    include: { items: true },
  });
}

app.post("/api/orders", resolveCourierBySlug, async (req, res) => {
  const courierId = req.courierId!;
  const { maxUserId, name, address, phone, comment, lat, lon, items } = req.body as {
    maxUserId: string;
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    items: { productId: number; quantity: number }[];
  };

  try {
    const result = await prisma.$transaction(
      (tx) =>
        createOrderInTransaction(tx, courierId, req.courier!.deliveryFee, {
          maxUserId,
          name,
          address,
          phone,
          comment,
          lat,
          lon,
          items,
        }),
      // Стандартный лимит Prisma на такую транзакцию — 5 секунд, и с базой в
      // облаке (не на этом же компьютере) при заказе из нескольких товаров
      // этого впритык не хватало ("transaction not found" — по сути истёк
      // срок). Увеличиваем с запасом.
      { timeout: 15000 }
    );

    io.to(courierRoom(courierId)).emit("orders:updated");
    io.to(courierRoom(courierId)).emit("products:updated");
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(400).json({
      error: e instanceof UserFacingError ? e.message : "Не удалось оформить заказ",
    });
  }
});

// Хозяйка оформляет заказ сама — для покупателей, у которых не получилось
// сделать это через приложение (например, позвонили по телефону). Такой
// покупатель определяется по номеру телефона (а не по maxUserId из MAX,
// которого у него нет) — так повторные звонки того же человека попадают в
// того же "покупателя", и его прошлые заказы видны в истории вместе.
app.post("/api/orders/manual", requireOwner, async (req, res) => {
  const courierId = req.courierId!;
  const { name, address, phone, comment, lat, lon, items } = req.body as {
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    items: { productId: number; quantity: number }[];
  };
  const maxUserId = `manual:${phone.trim()}`;

  try {
    const result = await prisma.$transaction(
      (tx) =>
        createOrderInTransaction(tx, courierId, req.courier!.deliveryFee, {
          maxUserId,
          name,
          address,
          phone,
          comment,
          lat,
          lon,
          items,
        }),
      { timeout: 15000 }
    );

    io.to(courierRoom(courierId)).emit("orders:updated");
    io.to(courierRoom(courierId)).emit("products:updated");
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(400).json({
      error: e instanceof UserFacingError ? e.message : "Не удалось оформить заказ",
    });
  }
});

// Заказы на сегодня для экрана хозяйки — с данными покупателя (снимок именно
// этого заказа, см. комментарий в schema.prisma) и составом.
app.get("/api/orders", requireOwner, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { courierId: req.courierId, status: { in: ["NEW", "ON_THE_WAY"] } },
    include: { items: { include: { product: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json(orders);
});

// История — уже завершённые заказы (выданы/забраны/отменены), с поиском по
// имени/телефону покупателя и/или по диапазону дат оформления заказа. Без
// фильтров отдаёт последние 50, чтобы не тащить сразу всю историю целиком.
app.get("/api/orders/history", requireOwner, async (req, res) => {
  const search = (req.query.search as string | undefined)?.trim();
  // Даты приходят как "YYYY-MM-DD" (обычный <input type="date">) — "до"
  // включает весь день целиком, а не только полночь.
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const fromDate = from ? new Date(`${from}T00:00:00`) : undefined;
  const toDate = to ? new Date(`${to}T23:59:59.999`) : undefined;

  const orders = await prisma.order.findMany({
    where: {
      courierId: req.courierId,
      status: { in: ["DELIVERED", "PICKED_UP", "CANCELLED"] },
      ...(fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { phone: { contains: search } },
            ],
          }
        : {}),
    },
    include: { items: { include: { product: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(orders);
});

// Хозяйка нажала «заказ принят» — покупатель сразу видит у себя на экране
// (через сокет "orders:updated") приветливое сообщение вместо простого
// "оформлен". Реального чата/пуш-уведомлений в приложении нет — это самый
// быстрый способ дать покупателю знать, что заказ увидели и уже готовят.
app.post("/api/orders/:id/accept", requireOwner, async (req, res) => {
  const order = await prisma.order.update({
    where: { id: Number(req.params.id), courierId: req.courierId },
    data: { status: "ON_THE_WAY" },
    include: { customer: true },
  });
  io.to(courierRoom(req.courierId!)).emit("orders:updated");
  sendMaxMessage(
    order.customer.maxUserId,
    "Спасибо за заказ! Уже готовим и привезём в ближайшее время."
  );
  res.json(order);
});

// Хозяйка нажала «заказ выдал».
app.post("/api/orders/:id/delivered", requireOwner, async (req, res) => {
  const order = await prisma.order.update({
    where: { id: Number(req.params.id), courierId: req.courierId },
    data: { status: "DELIVERED" },
  });
  io.to(courierRoom(req.courierId!)).emit("orders:updated");
  res.json(order);
});

// Покупатель нажал «заказ забрал».
app.post("/api/orders/:id/picked-up", resolveCourierBySlug, async (req, res) => {
  const order = await prisma.order.update({
    where: { id: Number(req.params.id), courierId: req.courierId },
    data: { status: "PICKED_UP" },
  });
  io.to(courierRoom(req.courierId!)).emit("orders:updated");
  res.json(order);
});

// Общая проверка и для отмены, и для редактирования заказа: существует ли
// он, принадлежит ли он покупателю (если проверка со стороны покупателя —
// requireMaxUserId), и не поздно ли его ещё трогать (пока не выдан/не
// забран/не отменён). actionVerb — только для текста ошибки.
async function loadEditableOrder(
  tx: Prisma.TransactionClient,
  id: number,
  courierId: number,
  requireMaxUserId: string | undefined,
  actionVerb: string
) {
  const existing = await tx.order.findUnique({
    where: { id, courierId },
    include: { items: true, customer: true },
  });
  if (!existing) throw new UserFacingError("Заказ не найден");
  if (requireMaxUserId !== undefined && existing.customer.maxUserId !== requireMaxUserId) {
    throw new UserFacingError("Это не твой заказ");
  }
  if (existing.status !== "NEW" && existing.status !== "ON_THE_WAY") {
    throw new UserFacingError(`Этот заказ уже нельзя ${actionVerb}`);
  }
  return existing;
}

// Отмена заказа — общая логика для курьера и для самого покупателя: товар
// при отмене возвращается в остаток (он был списан при оформлении заказа).
async function cancelOrderInTransaction(
  tx: Prisma.TransactionClient,
  id: number,
  courierId: number,
  requireMaxUserId?: string
) {
  const existing = await loadEditableOrder(tx, id, courierId, requireMaxUserId, "отменить");
  for (const item of existing.items) {
    await tx.product.update({
      where: { id: item.productId },
      data: { availableQty: { increment: item.quantity } },
    });
  }
  return tx.order.update({
    where: { id },
    data: { status: "CANCELLED" },
    include: { items: { include: { product: true } } },
  });
}

// Хозяйка отменяет заказ со своего экрана.
app.post("/api/orders/:id/cancel", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const order = await prisma.$transaction((tx) => cancelOrderInTransaction(tx, id, req.courierId!));
    io.to(courierRoom(req.courierId!)).emit("orders:updated");
    io.to(courierRoom(req.courierId!)).emit("products:updated");
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e instanceof UserFacingError ? e.message : "Не удалось отменить заказ" });
  }
});

// Покупатель отменяет свой заказ.
app.post("/api/orders/:id/cancel-by-customer", resolveCourierBySlug, async (req, res) => {
  const id = Number(req.params.id);
  const { maxUserId } = req.body as { maxUserId: string };
  try {
    const order = await prisma.$transaction((tx) =>
      cancelOrderInTransaction(tx, id, req.courierId!, maxUserId)
    );
    io.to(courierRoom(req.courierId!)).emit("orders:updated");
    io.to(courierRoom(req.courierId!)).emit("products:updated");
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e instanceof UserFacingError ? e.message : "Не удалось отменить заказ" });
  }
});

// Редактирование заказа — общая логика для курьера и для самого покупателя:
// можно менять имя/адрес/телефон/комментарий и состав товаров, пока заказ
// не выдан/не забран/не отменён (те же условия, что у отмены). Состав
// товаров при этом можно менять свободно — по каждому товару считаем
// разницу между старым и новым количеством и одним атомарным запросом
// списываем/возвращаем именно эту разницу (не весь заказ целиком), с той же
// проверкой остатка, что и при первом оформлении.
async function editOrderInTransaction(
  tx: Prisma.TransactionClient,
  id: number,
  courierId: number,
  data: {
    name: string;
    address: string;
    phone: string;
    comment: string | null;
    lat: number;
    lon: number;
    items: { productId: number; quantity: number }[];
  },
  requireMaxUserId?: string
) {
  const existing = await loadEditableOrder(tx, id, courierId, requireMaxUserId, "изменить");

  const oldQtyByProduct = new Map(existing.items.map((i) => [i.productId, i.quantity]));
  const newQtyByProduct = new Map(data.items.map((i) => [i.productId, i.quantity]));
  const productIds = new Set([...oldQtyByProduct.keys(), ...newQtyByProduct.keys()]);

  for (const productId of productIds) {
    const oldQty = oldQtyByProduct.get(productId) ?? 0;
    const newQty = newQtyByProduct.get(productId) ?? 0;
    const delta = newQty - oldQty;
    if (delta === 0) continue;
    if (delta > 0) {
      const decremented = await tx.product.updateMany({
        where: { id: productId, courierId, availableQty: { gte: delta } },
        data: { availableQty: { decrement: delta } },
      });
      if (decremented.count === 0) {
        const product = await tx.product.findUnique({ where: { id: productId, courierId } });
        throw new UserFacingError(
          product ? `Товара «${product.name}» не хватает в наличии` : "Такого товара не существует"
        );
      }
    } else {
      await tx.product.update({
        where: { id: productId, courierId },
        data: { availableQty: { increment: -delta } },
      });
    }
  }

  await tx.customer.update({
    where: { id: existing.customerId },
    data: { name: data.name, address: data.address, phone: data.phone },
  });

  await tx.orderItem.deleteMany({ where: { orderId: id } });

  return tx.order.update({
    where: { id },
    data: {
      name: data.name,
      address: data.address,
      phone: data.phone,
      comment: data.comment,
      lat: data.lat,
      lon: data.lon,
      items: { create: data.items },
    },
    include: { items: { include: { product: true } } },
  });
}

// Хозяйка меняет уже оформленный заказ со своего экрана.
app.post("/api/orders/:id/edit", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const { name, address, phone, comment, lat, lon, items } = req.body as {
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    items: { productId: number; quantity: number }[];
  };
  try {
    const order = await prisma.$transaction(
      (tx) =>
        editOrderInTransaction(tx, id, req.courierId!, {
          name,
          address,
          phone,
          comment: comment?.trim() || null,
          lat,
          lon,
          items,
        }),
      { timeout: 15000 }
    );
    io.to(courierRoom(req.courierId!)).emit("orders:updated");
    io.to(courierRoom(req.courierId!)).emit("products:updated");
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e instanceof UserFacingError ? e.message : "Не удалось изменить заказ" });
  }
});

// Покупатель меняет свой заказ.
app.post("/api/orders/:id/edit-by-customer", resolveCourierBySlug, async (req, res) => {
  const id = Number(req.params.id);
  const { maxUserId, name, address, phone, comment, lat, lon, items } = req.body as {
    maxUserId: string;
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    items: { productId: number; quantity: number }[];
  };
  try {
    const order = await prisma.$transaction(
      (tx) =>
        editOrderInTransaction(
          tx,
          id,
          req.courierId!,
          { name, address, phone, comment: comment?.trim() || null, lat, lon, items },
          maxUserId
        ),
      { timeout: 15000 }
    );
    io.to(courierRoom(req.courierId!)).emit("orders:updated");
    io.to(courierRoom(req.courierId!)).emit("products:updated");
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e instanceof UserFacingError ? e.message : "Не удалось изменить заказ" });
  }
});

// --- Живое положение курьера --------------------------------------------
// Курьер шлёт своё положение через сокет; сервер рассылает его только
// подключённым к НЕМУ ЖЕ покупателям (по комнатам socket.io, одна комната
// на курьера). Ничего не хранится в базе — только последнее известное
// положение в памяти на время работы сервера.
function courierRoom(courierId: number) {
  return `courier:${courierId}`;
}

const lastKnownPosition = new Map<number, { lat: number; lon: number }>();

io.on("connection", async (socket: Socket) => {
  const auth = socket.handshake.auth as { role?: string; token?: string; slug?: string };

  let courierId: number | null = null;
  let isOwnerSocket = false;

  if (auth.role === "owner" && auth.token) {
    const courier = await prisma.courier.findUnique({ where: { ownerToken: auth.token } });
    if (courier && !isExpired(courier)) {
      courierId = courier.id;
      isOwnerSocket = true;
    }
  } else if (auth.role === "customer" && auth.slug) {
    const courier = await prisma.courier.findUnique({ where: { slug: auth.slug } });
    if (courier && !isExpired(courier)) courierId = courier.id;
  }

  if (!courierId) {
    socket.disconnect();
    return;
  }

  socket.join(courierRoom(courierId));

  const known = lastKnownPosition.get(courierId);
  if (known) socket.emit("courier:position", known);

  // Только сам курьер (проверенный по паролю выше) может присылать своё
  // положение и время прибытия — покупательский сокет этого сделать не может,
  // даже если попробует отправить такое же событие.
  if (isOwnerSocket) {
    socket.on("courier:position", (position: { lat: number; lon: number }) => {
      lastKnownPosition.set(courierId!, position);
      socket.to(courierRoom(courierId!)).emit("courier:position", position);
    });

    socket.on("orders:eta", (eta: Record<number, number>) => {
      socket.to(courierRoom(courierId!)).emit("orders:eta", eta);
    });
  }
});

// Express 5 сам перехватывает отклонённые промисы из async-обработчиков —
// без этой заглушки такая ошибка ушла бы наружу целой HTML-страницей со
// стеком вызовов (внутренние пути, номера строк кода). Например, попытка
// изменить чужой (не своего курьера) товар — так и должно быть отклонено,
// но пользователю/атакующему не нужно видеть внутренности сервера.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(400).json({ error: "Не удалось выполнить запрос" });
});

const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, () => {
  console.log(`Сервер доставки запущен: http://localhost:${PORT}`);
});
