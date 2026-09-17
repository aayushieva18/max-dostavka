import { getMaxUserId, getMaxStartParam } from "./lib/max";
import { DEFAULT_COURIER_SLUG } from "./lib/config";
import { CustomerScreen } from "./screens/CustomerScreen";
import { CourierScreen } from "./screens/CourierScreen";
import { OwnerGate } from "./components/OwnerGate";

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const isAdmin = params.get("admin") === "1";

  if (isAdmin) {
    return (
      <OwnerGate>
        <CourierScreen />
      </OwnerGate>
    );
  }

  // Внутри MAX разные курьеры различаются через deep-link (?startapp=slug
  // в ссылке на бота), а не через обычный адрес сайта — один и тот же бот
  // обслуживает всех курьеров. Вне MAX (обычная ссылка в браузере) курьер
  // определяется по ?courier= в адресе, как раньше.
  const courierSlug = getMaxStartParam() ?? params.get("courier") ?? DEFAULT_COURIER_SLUG;
  const maxUserId = getMaxUserId();
  return <CustomerScreen courierSlug={courierSlug} maxUserId={maxUserId} />;
}
