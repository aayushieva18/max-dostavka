import express from "express";
import cors from "cors";
import { createServer } from "http";
import https from "https";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import path from "path";
import { rootCertificates } from "tls";
import { Server, type Socket } from "socket.io";
import { PrismaClient, Prisma, type Courier } from "@prisma/client";

// Ошибка, которую специально показываем покупателю/курьеру как есть (текст
// понятный, без внутренних деталей) — в отличие от любой другой ошибки
// (например, от Prisma), где наружу должно уходить только общее сообщение.
class UserFacingError extends Error {}

// Сайт MAX использует сертификат, выданный государственным "Russian Trusted
// Root CA" (Минцифры России) — его нет в стандартном списке доверенных
// организаций у Node.js (как и у большинства ПО вне России), поэтому обычный
// fetch() к platform-api2.max.ru падает с "unable to get local issuer
// certificate". Добавляем этот корневой сертификат отдельно, вместе со всеми
// обычными (rootCertificates), не отключая проверку сертификата целиком.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const russianTrustedRootCa = readFileSync(
  path.join(__dirname, "../certs/russian_trusted_root_ca.pem"),
  "utf8"
);
const maxApiAgent = new https.Agent({ ca: [...rootCertificates, russianTrustedRootCa] });

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
// Используем https.request (не fetch) — так можно указать свой доверенный
// сертификат (maxApiAgent), у fetch() в Node такой возможности на запрос нет.
// Никогда не отклоняется: при ошибке сети возвращает status 0.
function maxApiRequest(
  method: string,
  apiPath: string,
  payload?: unknown
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const token = process.env.MAX_BOT_TOKEN ?? "";
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const req = https.request(
      {
        hostname: "platform-api2.max.ru",
        path: apiPath,
        method,
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        agent: maxApiAgent,
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      }
    );
    req.on("error", (e) => {
      console.error("MAX Bot API: ошибка запроса", e);
      resolve({ status: 0, body: "" });
    });
    if (body) req.write(body);
    req.end();
  });
}

// attachments — например, кнопки под сообщением (inline_keyboard).
async function sendMaxMessage(maxUserId: string, text: string, attachments?: unknown[]): Promise<boolean> {
  if (!process.env.MAX_BOT_TOKEN) {
    console.log("MAX Bot API: пропущено — MAX_BOT_TOKEN не задан");
    return false;
  }
  if (!/^\d+$/.test(maxUserId)) {
    console.log("MAX Bot API: пропущено — не настоящий id MAX", maxUserId);
    return false;
  }
  const { status, body } = await maxApiRequest("POST", `/messages?user_id=${maxUserId}`, {
    text,
    ...(attachments ? { attachments } : {}),
  });
  if (status >= 200 && status < 300) {
    console.log("MAX Bot API: сообщение отправлено", maxUserId);
    return true;
  }
  console.error("MAX Bot API: не удалось отправить сообщение", status, body);
  return false;
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
    singleItemFee: courier.singleItemFee,
  });
});

// Курьер меняет свою стоимость доставки (0 — бесплатно) и/или отдельную
// цену для заказа из 1 штуки (null — убрать отдельную цену). Меняется только
// то, что передано. Не трогает уже оформленные заказы — у них своя
// сохранённая на момент заказа цена.
app.post("/api/me/delivery-fee", requireOwner, async (req, res) => {
  const { deliveryFee, singleItemFee } = req.body as {
    deliveryFee?: number;
    singleItemFee?: number | null;
  };
  const courier = await prisma.courier.update({
    where: { id: req.courierId },
    data: {
      ...(deliveryFee !== undefined ? { deliveryFee: Math.max(0, Math.round(deliveryFee) || 0) } : {}),
      ...(singleItemFee !== undefined
        ? { singleItemFee: singleItemFee === null ? null : Math.max(0, Math.round(singleItemFee) || 0) }
        : {}),
    },
  });
  res.json({ deliveryFee: courier.deliveryFee, singleItemFee: courier.singleItemFee });
});

// Публичная информация о курьере (название, стоимость доставки) — нужна
// покупателю в форме заказа, до входа и без пароля.
app.get("/api/courier", resolveCourierBySlug, async (req, res) => {
  const courier = req.courier!;
  res.json({ name: courier.name, deliveryFee: courier.deliveryFee, singleItemFee: courier.singleItemFee });
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

// Стоимость доставки для конкретного состава заказа: если во всём заказе
// ровно 1 штука и у курьера задана отдельная цена для этого — она, иначе
// обычная.
function totalUnits(items: { quantity: number }[]) {
  return items.reduce((sum, i) => sum + i.quantity, 0);
}
function deliveryFeeFor(
  courier: { deliveryFee: number; singleItemFee: number | null },
  items: { quantity: number }[]
) {
  return totalUnits(items) === 1 && courier.singleItemFee !== null
    ? courier.singleItemFee
    : courier.deliveryFee;
}

// Предзаказы: покупатель может заказать на дату не раньше чем через
// PREORDER_MIN_DAYS дней, не глядя на остатки (товар приготовят под
// заказ). Хозяйка переводит в активные предзаказы на ближайшие
// PREORDER_WEEK_DAYS дней — тогда списывается остаток.
const PREORDER_MIN_DAYS = 8;
const PREORDER_WEEK_DAYS = 7;

// Сегодняшняя дата по времени Читы (UTC+9, без перехода на летнее время) в
// виде "YYYY-MM-DD", плюс сколько-то дней — сервер может стоять в другом
// часовом поясе, а "день" для покупателей и хозяйки — читинский.
function chitaDatePlusDays(days: number): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

// Проверка даты предзаказа: формат и не раньше минимальной (покупателю —
// через PREORDER_MIN_DAYS дней, хозяйке — любая начиная с завтра).
function validatePreorderDate(date: unknown, minDays: number): string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new UserFacingError("Неверная дата предзаказа");
  }
  if (date < chitaDatePlusDays(minDays)) {
    throw new UserFacingError(
      minDays > 1
        ? `Предзаказ можно сделать не раньше чем на ${minDays}-й день от сегодня`
        : "Дата предзаказа должна быть в будущем"
    );
  }
  return date;
}

// Для предзаказа остаток не проверяется — но товар должен быть настоящим,
// этого курьера и не удалённым, а количество — разумным целым числом.
async function validatePreorderItems(
  tx: Prisma.TransactionClient,
  courierId: number,
  items: { productId: number; quantity: number }[]
) {
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) {
      throw new UserFacingError("Неверное количество товара");
    }
    const product = await tx.product.findUnique({ where: { id: item.productId, courierId } });
    if (!product || product.archived) throw new UserFacingError("Такого товара не существует");
  }
}

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
    approxLocation?: boolean;
    items: { productId: number; quantity: number }[];
    // Уже проверенная дата предзаказа (validatePreorderDate) — если есть,
    // остаток не списывается, заказ попадает в предзаказы.
    preorderDate?: string | null;
  }
) {
  if (data.preorderDate) {
    await validatePreorderItems(tx, courierId, data.items);
  }
  // Проверка остатка и списание — одним атомарным запросом на товар (а не
  // "сначала проверить, потом списать" отдельно), чтобы не было случая,
  // когда между проверкой и списанием кто-то другой успел разобрать тот же
  // товар. Заодно вдвое короче транзакция — раньше на каждый товар уходило
  // два обращения к базе, теперь одно.
  for (const item of data.preorderDate ? [] : data.items) {
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
      approxLocation: data.approxLocation ?? false,
      ...(data.preorderDate ? { status: "PREORDER" as const, preorderDate: data.preorderDate } : {}),
      items: { create: data.items },
    },
    include: { items: true },
  });
}

app.post("/api/orders", resolveCourierBySlug, async (req, res) => {
  const courierId = req.courierId!;
  const { maxUserId, name, address, phone, comment, lat, lon, approxLocation, items, preorderDate } = req.body as {
    maxUserId: string;
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    approxLocation?: boolean;
    items: { productId: number; quantity: number }[];
    preorderDate?: string | null;
  };

  try {
    const checkedPreorderDate = preorderDate ? validatePreorderDate(preorderDate, PREORDER_MIN_DAYS) : null;
    const result = await prisma.$transaction(
      (tx) =>
        createOrderInTransaction(tx, courierId, deliveryFeeFor(req.courier!, items), {
          maxUserId,
          name,
          address,
          phone,
          comment,
          lat,
          lon,
          approxLocation,
          items,
          preorderDate: checkedPreorderDate,
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
  const { name, address, phone, comment, lat, lon, approxLocation, items, preorderDate } = req.body as {
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    approxLocation?: boolean;
    items: { productId: number; quantity: number }[];
    preorderDate?: string | null;
  };
  const maxUserId = `manual:${phone.trim()}`;

  try {
    const checkedPreorderDate = preorderDate ? validatePreorderDate(preorderDate, 1) : null;
    const result = await prisma.$transaction(
      (tx) =>
        createOrderInTransaction(tx, courierId, deliveryFeeFor(req.courier!, items), {
          maxUserId,
          name,
          address,
          phone,
          comment,
          lat,
          lon,
          approxLocation,
          items,
          preorderDate: checkedPreorderDate,
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

// Предзаказы хозяйки — по дате доставки, ближайшие сверху.
app.get("/api/orders/preorders", requireOwner, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { courierId: req.courierId, status: "PREORDER" },
    include: { items: { include: { product: true } } },
    orderBy: [{ preorderDate: "asc" }, { createdAt: "asc" }],
  });
  res.json(orders);
});

// Перевод предзаказа в обычные активные заказы — со списанием остатка. Если
// товара в остатке меньше, чем в предзаказе, остаток становится 0, а
// недостача возвращается хозяйке предупреждением — сам перевод всё равно
// происходит (под предзаказ товар готовят в любом случае).
type Shortage = { name: string; missing: number };

async function activatePreorderInTransaction(
  tx: Prisma.TransactionClient,
  id: number,
  courierId: number
): Promise<Shortage[]> {
  const order = await tx.order.findUnique({ where: { id, courierId }, include: { items: true } });
  if (!order || order.status !== "PREORDER") throw new UserFacingError("Этот предзаказ уже не найден");
  const shortages: Shortage[] = [];
  for (const item of order.items) {
    const product = await tx.product.findUnique({ where: { id: item.productId } });
    if (!product) continue;
    const taken = Math.min(product.availableQty, item.quantity);
    if (taken < item.quantity) shortages.push({ name: product.name, missing: item.quantity - taken });
    if (taken > 0) {
      await tx.product.update({
        where: { id: product.id },
        data: { availableQty: { decrement: taken } },
      });
    }
  }
  await tx.order.update({ where: { id }, data: { status: "NEW" } });
  return shortages;
}

app.post("/api/orders/:id/activate", requireOwner, async (req, res) => {
  try {
    const shortages = await prisma.$transaction(
      (tx) => activatePreorderInTransaction(tx, Number(req.params.id), req.courierId!),
      { timeout: 15000 }
    );
    io.to(courierRoom(req.courierId!)).emit("orders:updated");
    io.to(courierRoom(req.courierId!)).emit("products:updated");
    res.json({ shortages });
  } catch (e) {
    res.status(400).json({ error: e instanceof UserFacingError ? e.message : "Не удалось перевести предзаказ" });
  }
});

// Все предзаказы на ближайшие PREORDER_WEEK_DAYS дней (и просроченные, если
// такие остались) — разом в активные, например сразу после загрузки остатков.
app.post("/api/orders/activate-week", requireOwner, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        courierId: req.courierId,
        status: "PREORDER",
        preorderDate: { lte: chitaDatePlusDays(PREORDER_WEEK_DAYS) },
      },
      orderBy: [{ preorderDate: "asc" }, { createdAt: "asc" }],
    });
    const shortages = await prisma.$transaction(
      async (tx) => {
        const all: Shortage[] = [];
        for (const order of orders) {
          all.push(...(await activatePreorderInTransaction(tx, order.id, req.courierId!)));
        }
        return all;
      },
      { timeout: 60000 }
    );
    io.to(courierRoom(req.courierId!)).emit("orders:updated");
    io.to(courierRoom(req.courierId!)).emit("products:updated");
    res.json({ shortages, count: orders.length });
  } catch (e) {
    res.status(400).json({ error: e instanceof UserFacingError ? e.message : "Не удалось перевести предзаказы" });
  }
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

// Хозяйка нажала «заказ собран» (или вернула заказ в несобранные, если
// нажала по ошибке) — на статус заказа не влияет.
app.post("/api/orders/:id/collected", requireOwner, async (req, res) => {
  const order = await prisma.order.update({
    where: { id: Number(req.params.id), courierId: req.courierId },
    data: { collected: req.body?.collected !== false },
  });
  io.to(courierRoom(req.courierId!)).emit("orders:updated");
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
  if (existing.status !== "NEW" && existing.status !== "ON_THE_WAY" && existing.status !== "PREORDER") {
    throw new UserFacingError(`Этот заказ уже нельзя ${actionVerb}`);
  }
  return existing;
}

// Отмена заказа — общая логика для курьера и для самого покупателя: товар
// при отмене возвращается в остаток (он был списан при оформлении заказа).
// У предзаказа остаток ещё не списывался — возвращать нечего.
async function cancelOrderInTransaction(
  tx: Prisma.TransactionClient,
  id: number,
  courierId: number,
  requireMaxUserId?: string
) {
  const existing = await loadEditableOrder(tx, id, courierId, requireMaxUserId, "отменить");
  for (const item of existing.status === "PREORDER" ? [] : existing.items) {
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
    approxLocation?: boolean;
    items: { productId: number; quantity: number }[];
    // Новая дата — только для предзаказа (у обычного заказа игнорируется);
    // уже проверена вызывающим (validatePreorderDate).
    preorderDate?: string | null;
  },
  requireMaxUserId?: string
) {
  const existing = await loadEditableOrder(tx, id, courierId, requireMaxUserId, "изменить");
  // Доставку пересчитываем, только если заказ стал «1 штука» или перестал
  // им быть — иначе оставляем сохранённую цену (курьер мог поменять обычную
  // цену уже после оформления этого заказа).
  const wasSingle = totalUnits(existing.items) === 1;
  const isSingle = totalUnits(data.items) === 1;
  let deliveryFee = existing.deliveryFee;
  if (wasSingle !== isSingle) {
    const courier = await tx.courier.findUniqueOrThrow({ where: { id: courierId } });
    deliveryFee = deliveryFeeFor(courier, data.items);
  }
  // У предзаказа остаток не списан — состав меняем свободно, без пересчёта.
  const isPreorder = existing.status === "PREORDER";
  if (isPreorder) await validatePreorderItems(tx, courierId, data.items);

  const oldQtyByProduct = new Map(existing.items.map((i) => [i.productId, i.quantity]));
  const newQtyByProduct = new Map(data.items.map((i) => [i.productId, i.quantity]));
  const productIds = isPreorder
    ? new Set<number>()
    : new Set([...oldQtyByProduct.keys(), ...newQtyByProduct.keys()]);

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
      approxLocation: data.approxLocation ?? false,
      deliveryFee,
      ...(isPreorder && data.preorderDate ? { preorderDate: data.preorderDate } : {}),
      items: { create: data.items },
    },
    include: { items: { include: { product: true } } },
  });
}

// Хозяйка меняет уже оформленный заказ со своего экрана.
app.post("/api/orders/:id/edit", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const { name, address, phone, comment, lat, lon, approxLocation, items, preorderDate } = req.body as {
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    approxLocation?: boolean;
    items: { productId: number; quantity: number }[];
    preorderDate?: string | null;
  };
  try {
    const checkedPreorderDate = preorderDate ? validatePreorderDate(preorderDate, 1) : null;
    const order = await prisma.$transaction(
      (tx) =>
        editOrderInTransaction(tx, id, req.courierId!, {
          name,
          address,
          phone,
          comment: comment?.trim() || null,
          lat,
          lon,
          approxLocation,
          items,
          preorderDate: checkedPreorderDate,
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
  const { maxUserId, name, address, phone, comment, lat, lon, approxLocation, items, preorderDate } = req.body as {
    maxUserId: string;
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    approxLocation?: boolean;
    items: { productId: number; quantity: number }[];
    preorderDate?: string | null;
  };
  try {
    const checkedPreorderDate = preorderDate ? validatePreorderDate(preorderDate, PREORDER_MIN_DAYS) : null;
    const order = await prisma.$transaction(
      (tx) =>
        editOrderInTransaction(
          tx,
          id,
          req.courierId!,
          {
            name,
            address,
            phone,
            comment: comment?.trim() || null,
            lat,
            lon,
            approxLocation,
            items,
            preorderDate: checkedPreorderDate,
          },
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

// --- Чат бота MAX --------------------------------------------------------
// Поле для сообщения в чате бота убрать нельзя (это часть самого MAX), а
// покупатели путают и пишут заказ сообщением. Поэтому: на «Начать» бот
// присылает инструкцию с кнопкой, открывающей мини-приложение; на любое
// сообщение — короткий ответ с той же кнопкой, а само сообщение сохраняется
// и показывается хозяйке на её экране.
//
// Бот один (Арюны) — сообщения в нём относятся к её витрине. Если в «Начать»
// пришёл payload со slug другого курьера (ссылка max.ru/бот?start=<slug>),
// используем его.
const BOT_DEFAULT_COURIER_SLUG = process.env.MAX_BOT_COURIER_SLUG ?? "aryuna";
const BOT_USERNAME = process.env.MAX_BOT_USERNAME ?? "id800200803014_bot";

// Секрет, по которому сервер узнаёт, что запрос к вебхуку пришёл именно от
// MAX — выводится из токена бота, чтобы не заводить отдельную настройку.
function webhookSecret(): string {
  return createHash("sha256")
    .update(`webhook:${process.env.MAX_BOT_TOKEN ?? ""}`)
    .digest("hex")
    .slice(0, 40);
}

function botInstruction(courierName: string): string {
  return [
    `Здравствуйте! Это бот «${courierName}».`,
    "",
    "Как сделать заказ:",
    "1. Нажмите кнопку «Сделать заказ» под этим сообщением.",
    "2. Заполните имя, адрес и телефон — в следующий раз они подставятся сами.",
    "3. Выберите товары кнопками «+» и «−» и нажмите «Заказать».",
    "",
    "Как изменить или отменить заказ:",
    "1. Снова нажмите «Сделать заказ» — откроется ваш текущий заказ.",
    "2. Нажмите «Изменить заказ», поправьте товары, адрес или телефон и нажмите «Сохранить».",
    "3. Если заказ больше не нужен — нажмите «Отменить заказ».",
    "Изменить или отменить заказ можно, пока курьер его не выдал.",
    "",
    `Можно сделать предзаказ на дату — от ${PREORDER_MIN_DAYS} дней вперёд: в форме заказа выберите «Предзаказ на дату». Изменить или отменить предзаказ — в разделе «Мои заказы» внизу экрана.`,
    "",
    "Заказы, написанные сообщением в этот чат, не принимаются — только через кнопку «Сделать заказ».",
  ].join("\n");
}

const BOT_REPLY_TO_MESSAGE =
  "Заказы сообщением в этот чат не принимаются. Чтобы сделать, изменить или отменить заказ, нажмите кнопку «Сделать заказ» ниже. Ваше сообщение мы передали курьеру.";

// Кнопка «Сделать заказ», открывающая мини-приложение нужного курьера.
// Сначала пробуем специальную кнопку open_app; если MAX её не примет —
// обычную ссылку на то же мини-приложение (тот же deep-link, что и везде).
async function sendWithOrderButton(maxUserId: string, text: string, slug: string) {
  const openApp = [
    {
      type: "inline_keyboard",
      payload: {
        buttons: [[{ type: "open_app", text: "Сделать заказ", web_app: BOT_USERNAME, payload: slug }]],
      },
    },
  ];
  if (await sendMaxMessage(maxUserId, text, openApp)) return;
  const link = [
    {
      type: "inline_keyboard",
      payload: {
        buttons: [[{ type: "link", text: "Сделать заказ", url: `https://max.ru/${BOT_USERNAME}?startapp=${slug}` }]],
      },
    },
  ];
  await sendMaxMessage(maxUserId, text, link);
}

async function botCourier(slug?: string | null) {
  if (slug) {
    const courier = await prisma.courier.findUnique({ where: { slug } });
    if (courier) return courier;
  }
  return prisma.courier.findUnique({ where: { slug: BOT_DEFAULT_COURIER_SLUG } });
}

type MaxUser = { user_id: number; first_name?: string; last_name?: string; name?: string; is_bot?: boolean };
type MaxUpdate =
  | { update_type: "bot_started"; user: MaxUser; payload?: string | null }
  | {
      update_type: "message_created";
      message: {
        sender?: MaxUser | null;
        recipient?: { chat_type?: string };
        body?: { text?: string | null };
      };
    }
  | { update_type: string };

async function handleBotUpdate(update: MaxUpdate) {
  if (update.update_type === "bot_started" && "user" in update) {
    const courier = await botCourier(update.payload);
    if (!courier) return;
    await sendWithOrderButton(String(update.user.user_id), botInstruction(courier.name), courier.slug);
    return;
  }
  if (update.update_type === "message_created" && "message" in update) {
    const sender = update.message.sender;
    // Только личные сообщения живых людей (не групповые чаты и не боты,
    // включая собственные ответы этого же бота).
    if (!sender || sender.is_bot) return;
    if (update.message.recipient?.chat_type && update.message.recipient.chat_type !== "dialog") return;
    const text = update.message.body?.text?.trim();
    const courier = await botCourier();
    if (!courier) return;
    const maxUserId = String(sender.user_id);
    if (text) {
      const name =
        [sender.first_name, sender.last_name].filter(Boolean).join(" ") || sender.name || "Без имени";
      await prisma.botMessage.create({
        data: { courierId: courier.id, maxUserId, name, text: text.slice(0, 2000) },
      });
      io.to(courierRoom(courier.id)).emit("bot-messages:updated");
    }
    await sendWithOrderButton(maxUserId, BOT_REPLY_TO_MESSAGE, courier.slug);
  }
}

app.post("/api/max-webhook", (req, res) => {
  if (!process.env.MAX_BOT_TOKEN || req.header("X-Max-Bot-Api-Secret") !== webhookSecret()) {
    res.status(403).end();
    return;
  }
  // MAX ждёт ответ не дольше 30 секунд — отвечаем сразу, обрабатываем после.
  res.status(200).end();
  handleBotUpdate(req.body as MaxUpdate).catch((e) => console.error("Вебхук MAX: ошибка", e));
});

// Подписка бота на события (вебхук) — при каждом запуске сервера проверяем,
// что она есть, и создаём, если нет (MAX сам снимает подписку, если сервер
// долго не отвечал). Адрес сервера Render передаёт сам в RENDER_EXTERNAL_URL;
// локально (без него) не подписываемся.
async function ensureBotWebhook() {
  const baseUrl = process.env.RENDER_EXTERNAL_URL;
  if (!process.env.MAX_BOT_TOKEN || !baseUrl) {
    console.log("Вебхук MAX: пропущено — нет MAX_BOT_TOKEN или RENDER_EXTERNAL_URL");
    return;
  }
  const url = `${baseUrl.replace(/\/$/, "")}/api/max-webhook`;
  const current = await maxApiRequest("GET", "/subscriptions");
  if (current.status === 200 && current.body.includes(url)) {
    console.log("Вебхук MAX: подписка уже есть", url);
    return;
  }
  const created = await maxApiRequest("POST", "/subscriptions", {
    url,
    update_types: ["bot_started", "message_created"],
    secret: webhookSecret(),
  });
  console.log("Вебхук MAX: подписка", url, created.status, created.body);
}

// Сообщения из чата бота — для экрана хозяйки (только не разобранные).
app.get("/api/bot-messages", requireOwner, async (req, res) => {
  const messages = await prisma.botMessage.findMany({
    where: { courierId: req.courierId, handled: false },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  // Если человек уже заказывал раньше — подставляем телефон, чтобы можно
  // было сразу позвонить.
  const customers = await prisma.customer.findMany({
    where: { courierId: req.courierId, maxUserId: { in: [...new Set(messages.map((m) => m.maxUserId))] } },
  });
  const phoneByUser = new Map(customers.map((c) => [c.maxUserId, c.phone]));
  res.json(messages.map((m) => ({ ...m, phone: phoneByUser.get(m.maxUserId) ?? null })));
});

app.post("/api/bot-messages/:id/handled", requireOwner, async (req, res) => {
  await prisma.botMessage.updateMany({
    where: { id: Number(req.params.id), courierId: req.courierId },
    data: { handled: true },
  });
  io.to(courierRoom(req.courierId!)).emit("bot-messages:updated");
  res.json({ ok: true });
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
  ensureBotWebhook().catch((e) => console.error("Вебхук MAX: ошибка подписки", e));
});
