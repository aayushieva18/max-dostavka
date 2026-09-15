import { useEffect, useRef, useState } from "react";
import { suggestAddress } from "../lib/yandexMaps";
import { Input } from "./ui";

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  // Название населённого пункта, если оно введено отдельным полем —
  // подсказки тогда ищутся именно по нему (иначе "Ленина" предложит улицы
  // сразу из всех сёл района вперемешку).
  context?: string;
};

// Подсказка приходит вместе с названием населённого пункта впереди (мы сами
// его туда добавили для точности поиска) — убираем перед тем, как положить
// в поле "Улица и дом", иначе оно продублируется с отдельным полем.
function stripContextPrefix(suggestion: string, context?: string): string {
  if (!context?.trim()) return suggestion;
  const prefix = context.trim();
  if (suggestion.toLowerCase().startsWith(prefix.toLowerCase())) {
    return suggestion.slice(prefix.length).replace(/^[,\s]+/, "");
  }
  return suggestion;
}

// Поле адреса с подсказками: пока человек печатает, снизу всплывает список
// похожих улиц/адресов — помогает не ошибиться в названии и не перепутать
// похожие улицы в разных сёлах, если указан населённый пункт (context).
export function AddressInput({ value, onChange, placeholder, context }: Props) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (value.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const currentRequest = ++requestId.current;
    const query = context?.trim() ? `${context.trim()}, ${value}` : value;
    const timeout = setTimeout(() => {
      suggestAddress(query).then((results) => {
        // Игнорируем ответ, если за время запроса человек напечатал что-то ещё.
        if (requestId.current === currentRequest) {
          setSuggestions(results);
          setOpen(results.length > 0);
        }
      });
    }, 300);
    return () => clearTimeout(timeout);
  }, [value, context]);

  // Закрываем список при клике снаружи.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(suggestions.length > 0)}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && (
        <div className="address-suggestions">
          {suggestions.map((suggestion) => (
            <div
              key={suggestion}
              className="address-suggestion-item"
              onClick={() => {
                onChange(stripContextPrefix(suggestion, context));
                setOpen(false);
              }}
            >
              {suggestion}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
