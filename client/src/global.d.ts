// Яндекс Карты подключаются тегом <script> и кладут себя в window.ymaps —
// без этого объявления TypeScript не знает про такое свойство у window.
import type * as ymaps from "yandex-maps";
export {};

// Мост MAX (см. https://dev.max.ru/docs/webapps/bridge) — тоже подключается
// тегом <script> и сам создаёт window.WebApp. Описываем только то, чем
// реально пользуемся в этом проекте.
interface MaxWebApp {
  platform: "ios" | "android" | "desktop" | "web";
  initData: string;
  initDataUnsafe: {
    user?: {
      id: number | string;
      first_name?: string;
      last_name?: string;
      username?: string;
      photo_url?: string;
    };
    start_param?: string;
  };
  DeviceStorage?: {
    setItem(key: string, value: string): void;
    getItem(key: string): string;
    removeItem(key: string): void;
    clear(): void;
  };
}

declare global {
  interface Window {
    ymaps?: typeof ymaps;
    WebApp?: MaxWebApp;
  }
}
