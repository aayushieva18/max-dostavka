import type * as ymaps from "yandex-maps";
import { loadYandexMaps } from "./yandexMaps";

export type RoutePoint = { lat: number; lon: number };

export type RouteStopEta = {
  index: number;
  etaMinutes: number;
};

export type RouteResult = {
  multiRoute: ymaps.multiRouter.MultiRoute;
  stops: RouteStopEta[];
};

// Строит маршрут от текущей точки (обычно — курьер) через все точки заказов
// по порядку, как они переданы. Возвращает готовый объект карты (его нужно
// самим добавить на карту через map.geoObjects.add) и время в пути до каждой
// точки заказа (не считая стартовую), в минутах от старта маршрута.
//
// Порядок точек не переставляется автоматически — маршрут строится в том
// порядке, в котором переданы заказы.
export async function buildDeliveryRoute(
  points: RoutePoint[]
): Promise<RouteResult | null> {
  if (points.length < 2) return null;

  const maps = await loadYandexMaps();

  const multiRoute = new maps.multiRouter.MultiRoute(
    {
      referencePoints: points.map((p) => [p.lat, p.lon]),
      params: { routingMode: "auto" },
    },
    { boundsAutoApply: true }
  );

  // Маршрут считается на сервере Яндекса асинхронно — ждём, пока модель
  // не получит хотя бы один посчитанный вариант (или не истечёт время ожидания).
  const routeModel = await waitForRoute(multiRoute.model);
  if (!routeModel) return { multiRoute, stops: [] };

  const paths = routeModel.getPaths();
  let cumulativeSeconds = 0;
  const stops: RouteStopEta[] = [];

  paths.forEach((path, legIndex) => {
    const duration = path.properties.get("duration", {}) as {
      value?: number;
    };
    cumulativeSeconds += duration.value ?? 0;
    // Нулевая точка — это старт (курьер), поэтому точка заказа №0 — это
    // конец первого отрезка пути (legIndex 0), и так далее.
    stops.push({ index: legIndex, etaMinutes: Math.round(cumulativeSeconds / 60) });
  });

  return { multiRoute, stops };
}

// Тип маршрута (driving/masstransit) не важен — нам нужны только getPaths()
// и properties.get("duration"), которые есть у обоих.
function waitForRoute(
  model: ymaps.multiRouter.MultiRouteModel,
  timeoutMs = 8000
): Promise<{ getPaths(): { properties: { get(key: string, def: object): object } }[] } | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const routes = model.getRoutes();
      if (routes.length > 0) {
        resolve(routes[0]);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(check, 300);
    };
    check();
  });
}
