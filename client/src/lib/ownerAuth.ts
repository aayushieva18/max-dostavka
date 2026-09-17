// Пароль хозяйки хранится только у неё в браузере (localStorage) — сюда его
// вводят один раз, дальше используется автоматически. В коде (публичный
// репозиторий) сам пароль не хранится — только сравнение на сервере с
// переменной окружения OWNER_SECRET.
const KEY = "max-dostavka-owner-token";

export function getOwnerToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setOwnerToken(token: string) {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // localStorage недоступен — пароль просто не запомнится между визитами
  }
}

export function clearOwnerToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // недоступен — нечего чистить
  }
}
