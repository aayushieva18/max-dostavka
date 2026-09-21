// Адрес хранится одной строкой "Населённый пункт, улица и дом" — на экранах
// это два отдельных поля, чтобы человек физически не мог забыть указать
// город/село (реальный случай: заказали "Ленина 2" без указания, что это
// Ага-Хангил, а не Агинское — курьер приехала не туда).
export function splitAddress(saved: string): { settlement: string; street: string } {
  const commaIndex = saved.indexOf(",");
  if (commaIndex === -1) return { settlement: "", street: saved };
  return {
    settlement: saved.slice(0, commaIndex).trim(),
    street: saved.slice(commaIndex + 1).trim(),
  };
}

export function joinAddress(settlement: string, street: string): string {
  return `${settlement.trim()}, ${street.trim()}`;
}
