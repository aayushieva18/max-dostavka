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

export type OrderStatus = "NEW" | "ON_THE_WAY" | "DELIVERED" | "PICKED_UP" | "CANCELLED";

export type Order = {
  id: number;
  status: OrderStatus;
  // Снимок имени/адреса/телефона/стоимости доставки на момент именно этого
  // заказа (не текущие данные покупателя/курьера — те могли поменяться позже).
  name: string;
  address: string;
  phone: string;
  // Заметка покупателя к заказу (домофон, время доставки и т.п.) —
  // необязательная.
  comment: string | null;
  deliveryFee: number;
  lat: number;
  lon: number;
  // Координаты — это центр населённого пункта, а не точный дом (адрес не
  // размечен по улицам ни у одного геокодера). Если таких заказов в одном
  // селе несколько, все точки лягут друг на друга на карте.
  approxLocation: boolean;
  createdAt: string;
  items: OrderItem[];
};

export type Me = { id: number; slug: string; name: string; deliveryFee: number };
export type CourierInfo = { name: string; deliveryFee: number };

// Ошибка запроса к серверу с приложенным HTTP-статусом — по нему экраны
// отличают "магазин временно недоступен" (403, курьер с истёкшим сроком) от
// прочих ошибок сети, чтобы показать не просто "не получилось", а понятную
// причину.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Ошибка запроса: ${res.status}`, res.status);
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
    throw new ApiError(body.error ?? `Ошибка запроса: ${res.status}`, res.status);
  }
  return res.json();
}

export const api = {
  getMe: () => ownerRequest<Me>("/api/me"),

  setDeliveryFee: (deliveryFee: number) =>
    ownerRequest<{ deliveryFee: number }>("/api/me/delivery-fee", {
      method: "POST",
      body: JSON.stringify({ deliveryFee }),
    }),

  getCourierInfo: (courierSlug: string) =>
    request<CourierInfo>(`/api/courier?courier=${encodeURIComponent(courierSlug)}`),

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

  deleteProduct: (productId: number) =>
    ownerRequest<Product>(`/api/products/${productId}/delete`, { method: "POST" }),

  getCustomer: (courierSlug: string, maxUserId: string) =>
    request<Customer>(
      `/api/customers/${maxUserId}?courier=${encodeURIComponent(courierSlug)}`
    ),

  // Вся история заказов покупателя у этого курьера — и для того, чтобы
  // показать её отдельным списком, и чтобы после перезахода восстановить
  // его текущий активный заказ (если есть).
  getCustomerOrders: (courierSlug: string, maxUserId: string) =>
    request<Order[]>(
      `/api/customer-orders/${maxUserId}?courier=${encodeURIComponent(courierSlug)}`
    ),

  getOrders: () => ownerRequest<Order[]>("/api/orders"),

  // История — уже завершённые заказы (выданы/забраны/отменены), можно найти
  // по имени/телефону и/или по диапазону дат оформления (from/to —
  // "YYYY-MM-DD", как отдаёт <input type="date">).
  getOrderHistory: (filters: { search?: string; from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (filters.search?.trim()) params.set("search", filters.search.trim());
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    const query = params.toString();
    return ownerRequest<Order[]>(`/api/orders/history${query ? `?${query}` : ""}`);
  },

  createOrder: (data: {
    courierSlug: string;
    maxUserId: string;
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    approxLocation?: boolean;
    items: { productId: number; quantity: number }[];
  }) =>
    request<Order>("/api/orders", {
      method: "POST",
      body: JSON.stringify({ ...data, courier: data.courierSlug }),
    }),

  // Хозяйка оформляет заказ сама — для покупателей, у которых не получилось
  // сделать это через приложение (например, позвонили по телефону).
  createManualOrder: (data: {
    name: string;
    address: string;
    phone: string;
    comment?: string | null;
    lat: number;
    lon: number;
    approxLocation?: boolean;
    items: { productId: number; quantity: number }[];
  }) =>
    ownerRequest<Order>("/api/orders/manual", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  editOrder: (
    orderId: number,
    data: {
      name: string;
      address: string;
      phone: string;
      comment?: string | null;
      lat: number;
      lon: number;
      approxLocation?: boolean;
      items: { productId: number; quantity: number }[];
    }
  ) =>
    ownerRequest<Order>(`/api/orders/${orderId}/edit`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  editOrderByCustomer: (
    courierSlug: string,
    orderId: number,
    maxUserId: string,
    data: {
      name: string;
      address: string;
      phone: string;
      comment?: string | null;
      lat: number;
      lon: number;
      approxLocation?: boolean;
      items: { productId: number; quantity: number }[];
    }
  ) =>
    request<Order>(
      `/api/orders/${orderId}/edit-by-customer?courier=${encodeURIComponent(courierSlug)}`,
      { method: "POST", body: JSON.stringify({ ...data, maxUserId }) }
    ),

  acceptOrder: (orderId: number) =>
    ownerRequest<Order>(`/api/orders/${orderId}/accept`, { method: "POST" }),

  markDelivered: (orderId: number) =>
    ownerRequest<Order>(`/api/orders/${orderId}/delivered`, { method: "POST" }),

  markPickedUp: (courierSlug: string, orderId: number) =>
    request<Order>(
      `/api/orders/${orderId}/picked-up?courier=${encodeURIComponent(courierSlug)}`,
      { method: "POST" }
    ),

  cancelOrder: (orderId: number) =>
    ownerRequest<Order>(`/api/orders/${orderId}/cancel`, { method: "POST" }),

  cancelOrderByCustomer: (courierSlug: string, orderId: number, maxUserId: string) =>
    request<Order>(
      `/api/orders/${orderId}/cancel-by-customer?courier=${encodeURIComponent(courierSlug)}`,
      { method: "POST", body: JSON.stringify({ maxUserId }) }
    ),
};
