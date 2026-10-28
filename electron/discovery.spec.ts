import { parseP1Hosts, parseSmaHosts } from './discovery';

describe('détection des lecteurs P1 HomeWizard (Bonjour)', () => {
  it('extrait le nom réseau des lecteurs annoncés', () => {
    const output = [
      'Browsing for _hwenergy._tcp.local.',
      'Timestamp     A/R    Flags  if Domain               Service Type         Instance Name',
      '17:08:22.754  Add        2  14 local.               _hwenergy._tcp.      p1meter-1A2B3C',
      '17:08:22.800  Add        2   4 local.               _hwenergy._tcp.      p1meter-1A2B3C',
      '17:08:23.100  Add        2  14 local.               _hwenergy._tcp.      energysocket-123456',
      '17:08:25.100  Rmv        0  14 local.               _hwenergy._tcp.      p1meter-999999',
    ].join('\n');
    expect(parseP1Hosts(output)).toEqual(['p1meter-1a2b3c.local']);
  });

  it('ne trouve rien sans lecteur', () => {
    expect(parseP1Hosts('Browsing for _hwenergy._tcp.local.\n')).toEqual([]);
  });
});

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
