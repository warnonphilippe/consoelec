import { deriveUuid, setMachOUuid } from './mac-uuid.mjs';

const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;

/** Mach-O 64 bits minimal : une commande LC_SEGMENT_64 (vide) puis LC_UUID. */
function thinMachO(uuidByte: number): Buffer {
  const b = Buffer.alloc(32 + 72 + 24);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(2, 16);
  b.writeUInt32LE(LC_SEGMENT_64, 32);
  b.writeUInt32LE(72, 36);
  b.writeUInt32LE(LC_UUID, 104);
  b.writeUInt32LE(24, 108);
  b.fill(uuidByte, 112, 128);
  return b;
}

const uuidOf = (b: Buffer, offset = 0): Buffer => b.subarray(offset + 112, offset + 128);

describe('UUID Mach-O propre à l’app (autorisation « Réseau local » de macOS)', () => {
  it('est stable d’un build à l’autre et distinct d’une app ou d’un exécutable à l’autre', () => {
    const elec = deriveUuid('io.github.warnonphilippe.consoelec/Contents/MacOS/ConsoElec');
    expect(deriveUuid('io.github.warnonphilippe.consoelec/Contents/MacOS/ConsoElec')).toEqual(elec);
    expect(deriveUuid('io.github.warnonphilippe.consomazout/Contents/MacOS/ConsoElec')).not.toEqual(elec);
    expect(
      deriveUuid('io.github.warnonphilippe.consoelec/Contents/Frameworks/ConsoElec Helper.app/Contents/MacOS/ConsoElec Helper'),
    ).not.toEqual(elec);
    expect(elec).toHaveLength(16);
    expect(elec[6]! >> 4).toBe(5);
    expect(elec[8]! >> 6).toBe(2);
  });

  it('remplace le LC_UUID d’un binaire simple', () => {
    const b = thinMachO(0xaa);
    const uuid = deriveUuid('x');
    expect(setMachOUuid(b, uuid)).toBe(1);
    expect(uuidOf(b)).toEqual(uuid);
  });

  it('remplace le LC_UUID de chaque architecture d’un binaire universel', () => {
    const slice = thinMachO(0xaa);
    const header = Buffer.alloc(8 + 2 * 20);
    header.writeUInt32BE(0xcafebabe, 0);
    header.writeUInt32BE(2, 4);
    const offsets = [256, 256 + slice.length];
    offsets.forEach((offset, i) => {
      header.writeUInt32BE(offset, 8 + i * 20 + 8);
      header.writeUInt32BE(slice.length, 8 + i * 20 + 12);
    });
    const b = Buffer.alloc(offsets[1]! + slice.length);
    header.copy(b, 0);
    offsets.forEach((offset) => slice.copy(b, offset));
    const uuid = deriveUuid('y');
    expect(setMachOUuid(b, uuid)).toBe(2);
    offsets.forEach((offset) => expect(uuidOf(b, offset)).toEqual(uuid));
  });

  it('ne touche à rien sans LC_UUID', () => {
    const b = thinMachO(0xaa);
    b.writeUInt32LE(1, 16);
    expect(setMachOUuid(b, deriveUuid('z'))).toBe(0);
    expect(uuidOf(b)).toEqual(Buffer.alloc(16, 0xaa));
  });
});
