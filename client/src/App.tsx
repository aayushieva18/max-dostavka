import { getMaxUserId } from "./lib/max";
import { OWNER_MAX_ID } from "./lib/config";
import { CustomerScreen } from "./screens/CustomerScreen";
import { CourierScreen } from "./screens/CourierScreen";
import { OwnerGate } from "./components/OwnerGate";

export default function App() {
  const maxUserId = getMaxUserId();
  const isOwner = maxUserId === OWNER_MAX_ID;

  // Пока настоящий id хозяйки не вписан в config.ts (или чтобы просто узнать
  // свой id) — смотри сюда: консоль браузера (F12 → Console).
  console.log("Твой id в MAX для этого запуска:", maxUserId);

  if (!isOwner) return <CustomerScreen maxUserId={maxUserId} />;

  return (
    <OwnerGate>
      <CourierScreen />
    </OwnerGate>
  );
}
