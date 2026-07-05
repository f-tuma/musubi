import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";

// Pick a photo, square-crop it, and shrink it hard before upload: 256×256
// JPEG at 0.7 lands around 10–20 KB — small enough to live in Postgres.
// Returns base64, or null if the user cancelled.
export async function pickAvatarBase64(): Promise<string | null> {
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1, // full quality here — compression happens in the resize below
  });
  if (picked.canceled || !picked.assets[0]) return null;

  const result = await manipulateAsync(
    picked.assets[0].uri,
    [{ resize: { width: 256, height: 256 } }],
    { compress: 0.7, format: SaveFormat.JPEG, base64: true },
  );
  return result.base64 ?? null;
}
