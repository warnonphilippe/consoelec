import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nativeImage } from 'electron';
import type { MeterPhoto } from './shared/ipc-contract';

const run = promisify(execFile);
const FAIL = 'Format d’image non pris en charge : exportez la photo en JPEG.';

/**
 * Convertit une image en JPEG de `maxSide` pixels au plus. Chromium ne décode que les formats web ;
 * pour le HEIC des iPhone, on s'appuie sur les codecs de macOS (`sips`, présent sur tous les Mac).
 */
export async function convertToJpeg(bytes: Buffer, maxSide: number): Promise<MeterPhoto> {
  const direct = nativeImage.createFromBuffer(bytes);
  if (!direct.isEmpty()) {
    return toPhoto(direct, maxSide);
  }
  if (process.platform !== 'darwin') {
    throw new Error(FAIL);
  }
  const dir = await mkdtemp(join(tmpdir(), 'consoelec-img-'));
  try {
    const input = join(dir, 'in');
    const output = join(dir, 'out.jpg');
    await writeFile(input, bytes);
    await run(
      '/usr/bin/sips',
      [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '85',
        '-Z',
        String(maxSide),
        input,
        '--out',
        output,
      ],
      {
        timeout: 30_000,
      },
    );
    return { mediaType: 'image/jpeg', base64: (await readFile(output)).toString('base64') };
  } catch {
    throw new Error(FAIL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function toPhoto(image: Electron.NativeImage, maxSide: number): MeterPhoto {
  const { width, height } = image.getSize();
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const resized =
    scale < 1
      ? image.resize({
          width: Math.round(width * scale),
          height: Math.round(height * scale),
          quality: 'best',
        })
      : image;
  return { mediaType: 'image/jpeg', base64: resized.toJPEG(85).toString('base64') };
}
