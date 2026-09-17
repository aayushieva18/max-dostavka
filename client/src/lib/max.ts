// Мост с мессенджером MAX подключается тегом <script> в index.html
// (https://st.max.ru/js/max-web-app.js) и сам создаёт window.WebApp —
// отдельной инициализации не требует. Вне MAX (обычный браузер при
// разработке) этого объекта нет — тогда работаем с тестовыми значениями.

type MaxUser = {
  id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
};

function getWebApp() {
  return window.WebApp;
}

// Параметр в адресной строке для локальной разработки вне MAX — чтобы можно
// было открыть экран хозяйки, подставив ?max_user_id=её-id.
function getDevOverrideUserId(): string | null {
  return new URLSearchParams(window.location.search).get("max_user_id");
}

// Пока нет бота в MAX, покупатели открывают обычную ссылку в своём браузере,
// а не изнутри MAX — там нет window.WebApp, и узнать, кто именно открыл
// страницу, неоткуда. Раньше в этом случае ВСЕ покупатели считались одним и
// тем же условным "test-user-local" — из-за этого один видел данные другого.
// Теперь для каждого браузера/телефона создаём и запоминаем свой собственный
// случайный номер (один раз, дальше берётся из localStorage) — так у каждого
// покупателя свои данные, не пересекающиеся с чужими.
function getOrCreateBrowserId(): string {
  const key = "max-dostavka-browser-id";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    // localStorage недоступен (например, приватный режим с жёсткими
    // ограничениями) — данные между заказами просто не запомнятся,
    // но приложение не должно из-за этого падать.
    return crypto.randomUUID();
  }
}

// Ссылка на конкретного курьера внутри MAX работает не через обычный адрес
// браузера (?courier=slug — его там не подставишь), а через deep-link вида
// https://max.ru/ИмяБота?startapp=slug — MAX передаёт этот "slug" в
// initDataUnsafe.start_param. Вне MAX такого нет — тогда берём ?courier=
// из обычной адресной строки (см. App.tsx).
export function getMaxStartParam(): string | null {
  return getWebApp()?.initDataUnsafe?.start_param ?? null;
}

export function getMaxUserId(): string {
  const user = getWebApp()?.initDataUnsafe?.user as MaxUser | undefined;
  if (user) return String(user.id);
  const override = getDevOverrideUserId();
  if (override) return override;
  return getOrCreateBrowserId();
}

// Имя покупателя MAX уже знает — подставляем как подсказку, чтобы не
// заставлять вводить его вручную (можно поменять, если человек не хочет
// заказывать под своим именем в MAX).
export function getMaxUserFirstName(): string {
  const user = getWebApp()?.initDataUnsafe?.user as MaxUser | undefined;
  return user?.first_name ?? "";
}

// Сохранение данных покупателя в хранилище MAX (DeviceStorage) — резервная
// копия того, что уже хранится на сервере, на случай временной
// недоступности сервера.
export function saveCustomerToDeviceStorage(data: {
  name: string;
  address: string;
  phone: string;
}) {
  try {
    getWebApp()?.DeviceStorage?.setItem("customer-data", JSON.stringify(data));
  } catch {
    // вне MAX хранилище недоступно — молча пропускаем
  }
}

export function loadCustomerFromDeviceStorage(): {
  name: string;
  address: string;
  phone: string;
} | null {
  try {
    const raw = getWebApp()?.DeviceStorage?.getItem("customer-data");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
