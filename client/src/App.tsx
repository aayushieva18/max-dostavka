import { getMaxUserId } from "./lib/max";
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

  const courierSlug = params.get("courier") ?? DEFAULT_COURIER_SLUG;
  const maxUserId = getMaxUserId();
  return <CustomerScreen courierSlug={courierSlug} maxUserId={maxUserId} />;
}
