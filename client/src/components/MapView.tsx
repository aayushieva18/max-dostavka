import type * as ymaps from "yandex-maps";
import { useEffect, useRef } from "react";
import { loadYandexMaps } from "../lib/yandexMaps";

export type MapMarker = {
  id: string | number;
  lat: number;
  lon: number;
  color?: string;
  onClick?: () => void;
};

type Props = {
  center: [number, number];
  markers: MapMarker[];
  // Готовый маршрут (см. src/lib/route.ts) — если передан, рисуется поверх меток.
  route?: ymaps.multiRouter.MultiRoute | null;
};

export function MapView({ center, markers, route }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<ymaps.Map | null>(null);

  useEffect(() => {
    let destroyed = false;
    let placemarks: ymaps.Placemark[] = [];

    loadYandexMaps().then((maps) => {
      if (destroyed || !containerRef.current) return;

      if (!mapRef.current) {
        mapRef.current = new maps.Map(containerRef.current, {
          center: [center[0], center[1]],
          zoom: 13,
          controls: ["zoomControl"],
        });
      } else {
        mapRef.current.setCenter([center[0], center[1]]);
      }

      placemarks = markers.map((marker) => {
        const placemark = new maps.Placemark(
          [marker.lat, marker.lon],
          {},
          { preset: colorToPreset(marker.color) }
        );
        if (marker.onClick) {
          placemark.events.add("click", marker.onClick);
        }
        mapRef.current!.geoObjects.add(placemark);
        return placemark;
      });

      if (route) {
        mapRef.current!.geoObjects.add(route);
      }
    });

    return () => {
      destroyed = true;
      for (const placemark of placemarks) {
        mapRef.current?.geoObjects.remove(placemark);
      }
      if (route) {
        mapRef.current?.geoObjects.remove(route);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1], markers, route]);

  useEffect(() => {
    return () => {
      mapRef.current?.destroy();
      mapRef.current = null;
    };
  }, []);

  return <div ref={containerRef} style={{ height: 260, borderRadius: 12 }} />;
}

// Переводит наш простой цвет метки в готовый набор оформления Яндекс Карт
// (без своих иконок — так меньше, что может сломаться).
function colorToPreset(color?: string): string {
  switch (color) {
    case "#22C55E":
      return "islands#greenDotIcon";
    case "#F97316":
      return "islands#orangeDotIcon";
    default:
      return "islands#blueDotIcon";
  }
}
