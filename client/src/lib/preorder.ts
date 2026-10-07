// Предзаказы — те же правила, что на сервере (server/src/index.ts):
// покупатель заказывает на дату не раньше чем через PREORDER_MIN_DAYS дней,
// хозяйка переводит в активные предзаказы на ближайшие PREORDER_WEEK_DAYS.
export const PREORDER_MIN_DAYS = 8;
export const PREORDER_WEEK_DAYS = 7;
// Остаток для предзаказа не ограничивает — только разумный предел кнопки «+».
export const PREORDER_MAX_QTY = 999;

// Сегодняшняя дата по времени Читы (UTC+9) плюс сколько-то дней, в виде
// "YYYY-MM-DD" — у телефона покупателя может стоять другой часовой пояс.
export function chitaDatePlusDays(days: number): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

// "2026-10-20" → "вт, 20 октября".
export function formatPreorderDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("ru-RU", {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
}
