import { HostRecovery } from './host-recovery';

describe('reprise automatique d’un appareil introuvable', () => {
  it('cherche après deux échecs, puis au plus toutes les 10 minutes', async () => {
    let now = 0;
    const search = vi.fn(async () => ['SMA1-2.local']);
    const recovery = new HostRecovery(
      search,
      (_current, found) => found[0] ?? null,
      () => now,
    );
    expect(await recovery.trouble('SMA1.local')).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(await recovery.trouble('SMA1.local')).toBe('SMA1-2.local');
    expect(await recovery.trouble('SMA1.local')).toBeNull();
    expect(search).toHaveBeenCalledTimes(1);
    now += 10 * 60 * 1000;
    expect(await recovery.trouble('SMA1.local')).toBe('SMA1-2.local');
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('repart de zéro après une lecture réussie et survit à une recherche en échec', async () => {
    const search = vi.fn(async (): Promise<string[]> => {
      throw new Error('dns-sd absent');
    });
    const recovery = new HostRecovery(search, () => 'x');
    expect(await recovery.trouble('a')).toBeNull();
    recovery.reset();
    expect(await recovery.trouble('a')).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(await recovery.trouble('a')).toBeNull();
    expect(search).toHaveBeenCalledTimes(1);
  });
});
