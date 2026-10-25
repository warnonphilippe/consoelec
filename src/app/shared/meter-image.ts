import type { ConsoElecApi, MeterPhoto } from '../../../electron/shared/ipc-contract';

/** Côté maximal envoyé à Claude : au-delà, l'image est réduite sans gain de lisibilité. */
const MAX_SIDE = 1568;
const MAX_FILE_BYTES = 40 * 1024 * 1024;

/**
 * Prépare une photo de compteur pour Claude : lue, réduite et recodée en JPEG.
 * Un format que le navigateur ne décode pas (HEIC des iPhone) est confié aux codecs du système via Electron.
 */
export async function prepareMeterPhoto(file: File, api: ConsoElecApi | null): Promise<MeterPhoto> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('Cette image est trop volumineuse (40 Mo maximum).');
  }
  if (!file.type.startsWith('image/') && !/\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)) {
    throw new Error('Ce fichier n’est pas une image.');
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('Canvas indisponible');
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { mediaType: 'image/jpeg', base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  } catch (error) {
    if (api === null) {
      throw new Error('Format d’image non pris en charge : exportez la photo en JPEG.', {
        cause: error,
      });
    }
    return api.image.toJpeg(await file.arrayBuffer());
  }
}

export function photoDataUrl(photo: MeterPhoto): string {
  return `data:${photo.mediaType};base64,${photo.base64}`;
}
