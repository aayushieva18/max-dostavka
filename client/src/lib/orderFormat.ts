import type { OrderItem } from "./api";

// Список товаров заказа одной строкой ("колбаса × 2, ветчина × 1") — нужен
// и на экране покупателя, и на экране курьера (список заказов, история,
// модалка с деталями) в одинаковом виде.
export function formatOrderItems(items: OrderItem[]): string {
  return items.map((i) => `${i.product.name} × ${i.quantity}`).join(", ");
}

export function formatOrderDate(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString("ru-RU");
}
