// Фото товара хранится прямо в базе данных (без отдельного файлового
// хранилища), поэтому перед отправкой сжимаем картинку — иначе фото с
// телефона (несколько мегабайт) будут перегружать базу и сервер.
// Уменьшаем до ширины 500px и пережимаем в JPEG среднего качества — для
// маленькой карточки товара этого более чем достаточно.
export function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Не удалось загрузить изображение"));
      img.onload = () => {
        const maxWidth = 500;
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas недоступен"));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
