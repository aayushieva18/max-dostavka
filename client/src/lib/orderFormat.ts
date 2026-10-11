import type { OrderItem } from "./api";

// Список товаров заказа одной строкой ("колбаса × 2, ветчина × 1") — нужен
// и на экране покупателя, и на экране курьера (список заказов, история,
// модалка с деталями) в одинаковом виде.
export function formatOrderItems(items: OrderItem[]): string {
  // product?. — на случай, если с сервера пришёл заказ без названий
  // товаров: лучше «товар × 2», чем упавший целиком экран.
  return items.map((i) => `${i.product?.name ?? "товар"} × ${i.quantity}`).join(", ");
}

export function formatOrderDate(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString("ru-RU");
}
