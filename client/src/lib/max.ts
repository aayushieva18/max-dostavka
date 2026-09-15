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

export function getMaxUserId(): string {
  const user = getWebApp()?.initDataUnsafe?.user as MaxUser | undefined;
  if (user) return String(user.id);
  return getDevOverrideUserId() ?? "test-user-local";
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
