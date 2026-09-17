import { io } from "socket.io-client";
import { SERVER_URL } from "./config";

// Один общий сокет на весь экран: живое положение курьера и сигналы
// "заказы обновились" / "остатки обновились", чтобы экраны сами перечитывали
// данные без ручного обновления страницы. Сервер решает, в какую "комнату"
// (одна на курьера) подключить сокет — по данным в auth, не доверяя тому,
// что сокет сам о себе заявит после подключения.
export const socket = io(SERVER_URL, { autoConnect: false });

export function connectAsCustomer(courierSlug: string) {
  socket.auth = { role: "customer", slug: courierSlug };
  socket.connect();
}

export function connectAsOwner(ownerToken: string) {
  socket.auth = { role: "owner", token: ownerToken };
  socket.connect();
}
