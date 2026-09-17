import { SERVER_URL } from "./config";

export type Product = {
  id: number;
  name: string;
  availableQty: number;
  imageUrl: string | null;
};

export type Customer = {
  id: number;
  maxUserId: string;
  name: string;
  address: string;
  phone: string;
} | null;

export type OrderItem = {
  id: number;
  productId: number;
  quantity: number;
  product: Product;
};

export type OrderStatus = "NEW" | "ON_THE_WAY" | "DELIVERED" | "PICKED_UP";

export type Order = {
  id: number;
  status: OrderStatus;
  // Снимок имени/адреса/телефона на момент именно этого заказа (не текущие
  // данные покупателя — те могли уже поменяться в более новом заказе).
  name: string;
  address: string;
  phone: string;
  lat: number;
  lon: number;
  createdAt: string;
  items: OrderItem[];
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Ошибка запроса: ${res.status}`);
  }
  return res.json();
}

export const api = {
  getProducts: () => request<Product[]>("/api/products"),

  createProduct: (name: string, availableQty: number, imageUrl?: string | null) =>
    request<Product>("/api/products", {
      method: "POST",
      body: JSON.stringify({ name, availableQty, imageUrl }),
    }),

  renameProduct: (productId: number, name: string) =>
    request<Product>(`/api/products/${productId}/rename`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  setProductImage: (productId: number, imageUrl: string | null) =>
    request<Product>(`/api/products/${productId}/image`, {
      method: "POST",
      body: JSON.stringify({ imageUrl }),
    }),

  setStock: (productId: number, availableQty: number) =>
    request<Product>(`/api/products/${productId}/stock`, {
      method: "POST",
      body: JSON.stringify({ availableQty }),
    }),

  getCustomer: (maxUserId: string) =>
    request<Customer>(`/api/customers/${maxUserId}`),

  getOrders: () => request<Order[]>("/api/orders"),

  createOrder: (data: {
    maxUserId: string;
    name: string;
    address: string;
    phone: string;
    lat: number;
    lon: number;
    items: { productId: number; quantity: number }[];
  }) =>
    request<Order>("/api/orders", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  markDelivered: (orderId: number) =>
    request<Order>(`/api/orders/${orderId}/delivered`, { method: "POST" }),

  markPickedUp: (orderId: number) =>
    request<Order>(`/api/orders/${orderId}/picked-up`, { method: "POST" }),
};
