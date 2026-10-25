import { parseSmaHosts } from './discovery';

describe('détection des onduleurs SMA (Bonjour)', () => {
  it('extrait le nom réseau des onduleurs annoncés', () => {
    const output = [
      'Browsing for _http._tcp.local.',
      'Timestamp     A/R    Flags  if Domain               Service Type         Instance Name',
      '22:02:37.439  Add        3  14 local.               _http._tcp.          Website for SMA-Inverter: SMA3012345678',
      '22:02:37.440  Add        3  14 local.               _http._tcp.          Imprimante du salon',
      '22:02:37.441  Add        2   4 local.               _http._tcp.          Website for SMA-Inverter: SMA3012345678',
      '22:02:40.100  Rmv        0  14 local.               _http._tcp.          Website for SMA-Inverter: SMA3099999999',
    ].join('\n');
    expect(parseSmaHosts(output)).toEqual(['SMA3012345678.local']);
  });

  it('ne trouve rien sans onduleur', () => {
    expect(parseSmaHosts('Browsing for _http._tcp.local.\n')).toEqual([]);
  });
});
