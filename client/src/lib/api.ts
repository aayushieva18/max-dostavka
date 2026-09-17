import { SERVER_URL } from "./config";
import { getOwnerToken } from "./ownerAuth";

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

export type Me = { id: number; slug: string; name: string };

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

// То же самое, но с паролем хозяйки — для запросов, которые видят/меняют
// данные заказов и товаров (не для обычной формы заказа покупателя).
async function ownerRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-owner-token": getOwnerToken() ?? "",
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Ошибка запроса: ${res.status}`);
  }
  return res.json();
}

export const api = {
  getMe: () => ownerRequest<Me>("/api/me"),

  getProducts: (courierSlug: string) =>
    request<Product[]>(`/api/products?courier=${encodeURIComponent(courierSlug)}`),

  createProduct: (name: string, availableQty: number, imageUrl?: string | null) =>
    ownerRequest<Product>("/api/products", {
      method: "POST",
      body: JSON.stringify({ name, availableQty, imageUrl }),
    }),

  renameProduct: (productId: number, name: string) =>
    ownerRequest<Product>(`/api/products/${productId}/rename`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  setProductImage: (productId: number, imageUrl: string | null) =>
    ownerRequest<Product>(`/api/products/${productId}/image`, {
      method: "POST",
      body: JSON.stringify({ imageUrl }),
    }),

  setStock: (productId: number, availableQty: number) =>
    ownerRequest<Product>(`/api/products/${productId}/stock`, {
      method: "POST",
      body: JSON.stringify({ availableQty }),
    }),

  getCustomer: (courierSlug: string, maxUserId: string) =>
    request<Customer>(
      `/api/customers/${maxUserId}?courier=${encodeURIComponent(courierSlug)}`
    ),

  getOrders: () => ownerRequest<Order[]>("/api/orders"),

  createOrder: (data: {
    courierSlug: string;
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
      body: JSON.stringify({ ...data, courier: data.courierSlug }),
    }),

  markDelivered: (orderId: number) =>
    ownerRequest<Order>(`/api/orders/${orderId}/delivered`, { method: "POST" }),

  markPickedUp: (courierSlug: string, orderId: number) =>
    request<Order>(
      `/api/orders/${orderId}/picked-up?courier=${encodeURIComponent(courierSlug)}`,
      { method: "POST" }
    ),
};
