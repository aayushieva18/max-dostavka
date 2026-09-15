import { io } from "socket.io-client";
import { SERVER_URL } from "./config";

// Один общий сокет на всё приложение: живое положение курьера и сигналы
// "заказы обновились" / "остатки обновились", чтобы экраны сами перечитывали
// данные без ручного обновления страницы.
export const socket = io(SERVER_URL, { autoConnect: true });
