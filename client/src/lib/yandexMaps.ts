import type * as ymaps from "yandex-maps";
import { DELIVERY_REGION_BOUNDS, YANDEX_MAPS_API_KEY } from "./config";
import { splitAddress } from "./address";

let loadPromise: Promise<typeof ymaps> | null = null;

// Яндекс Карты подключаются тегом <script>, а не npm-пакетом — грузим его
// один раз на всё приложение и ждём, пока API инициализируется (ymaps.ready).
export function loadYandexMaps(): Promise<typeof ymaps> {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const existing = window.ymaps;
    if (existing) {
      existing.ready(() => resolve(existing));
      return;
    }

    const script = document.createElement("script");
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${YANDEX_MAPS_API_KEY}&lang=ru_RU`;
    script.onload = () => {
      const loaded = window.ymaps!;
      loaded.ready(() => resolve(loaded));
    };
    script.onerror = () => reject(new Error("Не удалось загрузить Яндекс Карты"));
    document.head.appendChild(script);
  });

  return loadPromise;
}

const REGION_BOUNDED_BY: [[number, number], [number, number]] = [
  [DELIVERY_REGION_BOUNDS.minLat, DELIVERY_REGION_BOUNDS.minLon],
  [DELIVERY_REGION_BOUNDS.maxLat, DELIVERY_REGION_BOUNDS.maxLon],
];

// Люди пишут адрес по-разному ("мкр.", "14.43" вместо "дом 14, кв. 43") —
// геокодеры такие сокращения понимают плохо. Разворачиваем самые частые из
// них и убираем номер квартиры/офиса (для поиска ДОМА на карте он не нужен —
// у квартиры нет своих координат, только у здания).
function normalizeForGeocoding(address: string): string {
  let s = address.trim();
  // "14.43" или "14/43" (дом.квартира, без разделителя-запятой) — оставляем
  // только номер дома.
  s = s.replace(/(\d+)\s*[./](\d+)\b/g, "$1");
  // явное указание квартиры/офиса убираем целиком
  s = s.replace(/,?\s*(кв\.?|квартира|оф\.?|офис)\s*\.?\s*\d+/gi, "");
  s = s.replace(/мкрн?\.(?!\w)/gi, "микрорайон ");
  s = s.replace(/(^|\s)мкрн?(\s|$)/gi, "$1микрорайон$2");
  s = s.replace(/ул\.(?!\w)/gi, "улица ");
  s = s.replace(/пр-?кт\.?(?!\w)/gi, "проспект ");
  s = s.replace(/пер\.(?!\w)/gi, "переулок ");
  return s.replace(/\s+/g, " ").trim();
}

// Подсказки адреса по мере ввода (для выпадающего списка под полем) —
// ограничены зоной доставки, чтобы не предлагать улицы с похожим названием
// из других регионов. Каждый вариант — это полный адрес с названием
// населённого пункта, поэтому, выбирая подсказку, человек уже не забудет
// указать село или город.
export async function suggestAddress(query: string): Promise<string[]> {
  if (query.trim().length < 3) return [];
  try {
    const maps = await loadYandexMaps();
    const results = await maps.suggest(query, {
      results: 5,
      boundedBy: REGION_BOUNDED_BY,
    });
    return results.map((r) => r.displayName);
  } catch {
    return [];
  }
}

export type GeocodeResult = {
  lat: number;
  lon: number;
  // Полный адрес, как его понял геокодер, — показываем покупателю для
  // подтверждения ("правильно ли мы поняли адрес").
  addressLine: string;
  // Удалось ли определить конкретный населённый пункт (город/село).
  // Если нет — велика вероятность, что адрес без него теряется среди
  // одинаковых названий улиц в разных сёлах района.
  hasLocality: boolean;
  // Нашёлся только сам населённый пункт целиком, без улицы (см. фолбэк в
  // geocodeAddress ниже) — точка на карте это центр села, а не точный дом.
  // Если таких точек в одном селе несколько, они все лягут друг на друга.
  approximate: boolean;
};

type RawGeocodeResult = Omit<GeocodeResult, "approximate">;

// Некоторые названия сёл в Забайкальском крае встречаются дважды — один раз
// как маленькое село в другом, дальнем районе, и один раз как более крупный
// населённый пункт именно в зоне доставки этого курьера. Голое название без
// уточнения обычный геокодер иногда находит не там (у "Могойтуй" так и
// произошло: маленькое село в Акшинском округе перевесило по внутренним
// правилам геокодера настоящий районный центр Агинского округа, за сотни км
// в другую сторону). Используется только в самом крайнем случае (см. фолбэк
// ниже, когда даже улица не находится) — при обычном полном адресе со
// найденной улицей эта подмена не нужна, геокодер и так находит верное место.
const KNOWN_SETTLEMENT_OVERRIDES: Record<string, { lat: number; lon: number; label: string }> = {
  могойтуй: {
    lat: 51.2831177,
    lon: 114.9299468,
    label: "Могойтуй, Забайкальский край (районный центр Агинского округа)",
  },
};

// Переводит текстовый адрес в координаты и разбирает его на понятные части.
// Сначала пробует по-человечески развёрнутый адрес через Яндекс Карты (жёстко
// ограничено зоной доставки — см. DELIVERY_REGION_BOUNDS, — адрес из другого
// региона не найдётся вообще, даже если он существует, это осознанно), потом
// запасной вариант через OpenStreetMap с тем же ограничением (бесплатный, без
// ключа, но менее точен для конкретных домов — может найти улицу, но не
// точный номер дома). Если ничего не нашлось — пробует ещё раз с адресом
// ровно как его ввёл покупатель, без разворачивания сокращений (вдруг
// разворачивание не подошло именно для этого случая).
// Возвращает null, только если совсем ничего не нашлось — тогда покажем
// пользователю понятную подсказку вместо непонятной ошибки.
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const normalized = normalizeForGeocoding(address);
  const candidates = normalized === address.trim() ? [address] : [normalized, address];

  for (const candidate of candidates) {
    const viaYandex = await geocodeWithYandex(candidate).catch((e) => {
      console.error("Яндекс.Геокодер: ошибка запроса", e);
      return null;
    });
    if (viaYandex) return { ...viaYandex, approximate: false };

    const viaNominatim = await geocodeWithNominatim(candidate).catch((e) => {
      console.error("OpenStreetMap: ошибка запроса", e);
      return null;
    });
    if (viaNominatim) return { ...viaNominatim, approximate: false };
  }

  // Маленькие сёла (Дульдурга, Кункур, Южный Аргалей, Ага-Хангил и похожие)
  // часто вообще не размечены по улицам ни у Яндекса, ни в OpenStreetMap —
  // геокодер знает само село, но улицу в нём не находит и с домом-улицей
  // отдаёт пустой ответ. Последняя попытка — найти хотя бы центр
  // населённого пункта: курьер доедет до села и уточнит точный дом на
  // месте (по телефону) — это лучше, чем полный отказ принять заказ.
  // Помечаем такой результат approximate — если в одном селе окажется
  // несколько таких заказов, все точки лягут в одно место на карте, и
  // хозяйке нужно будет отличать их не по карте, а по списку.
  const { settlement } = splitAddress(address);
  if (settlement.trim()) {
    const known = KNOWN_SETTLEMENT_OVERRIDES[settlement.trim().toLowerCase()];
    if (known) {
      return { lat: known.lat, lon: known.lon, addressLine: known.label, hasLocality: true, approximate: true };
    }

    const viaYandexSettlement = await geocodeWithYandex(settlement).catch(() => null);
    if (viaYandexSettlement) return { ...viaYandexSettlement, approximate: true };

    const viaNominatimSettlement = await geocodeWithNominatim(settlement).catch(() => null);
    if (viaNominatimSettlement) return { ...viaNominatimSettlement, approximate: true };
  }

  return null;
}

async function geocodeWithYandex(address: string): Promise<RawGeocodeResult | null> {
  const maps = await loadYandexMaps();
  const result = await maps.geocode(address, {
    results: 1,
    boundedBy: REGION_BOUNDED_BY,
    strictBounds: true,
  });
  const firstGeoObject = result.geoObjects.get(0) as
    | (ymaps.GeocodeResult & {
        geometry: { getCoordinates(): number[] | null } | null;
      })
    | undefined;
  const coordinates = firstGeoObject?.geometry?.getCoordinates();
  if (!coordinates || !firstGeoObject) return null;
  // В Яндекс Картах координаты идут как [широта, долгота] — в отличие от
  // большинства других карт (GeoJSON, 2ГИС), где сначала долгота.
  const [lat, lon] = coordinates;
  return {
    lat,
    lon,
    addressLine: firstGeoObject.getAddressLine(),
    hasLocality: firstGeoObject.getLocalities().length > 0,
  };
}

async function geocodeWithNominatim(address: string): Promise<RawGeocodeResult | null> {
  const { minLat, minLon, maxLat, maxLon } = DELIVERY_REGION_BOUNDS;
  const params = new URLSearchParams({
    format: "json",
    limit: "1",
    countrycodes: "ru",
    addressdetails: "1",
    viewbox: `${minLon},${maxLat},${maxLon},${minLat}`,
    bounded: "1",
    q: address,
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error(`OpenStreetMap ответил ${res.status}`);
  const results = (await res.json()) as {
    lat: string;
    lon: string;
    display_name: string;
    address?: Record<string, string>;
  }[];
  const first = results[0];
  if (!first) return null;
  const a = first.address ?? {};
  const hasLocality = Boolean(a.city || a.town || a.village || a.hamlet || a.municipality);
  return {
    lat: Number(first.lat),
    lon: Number(first.lon),
    addressLine: first.display_name,
    hasLocality,
  };
}
