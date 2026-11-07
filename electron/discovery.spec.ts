import {
  p1Identity,
  parseP1Hosts,
  parseResolvedHost,
  parseSmaHosts,
  parseSmaInstances,
  relocatedHost,
  smaSerial,
} from './discovery';

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

describe('appareils renommés après un conflit de nom Bonjour', () => {
  it('garde le suffixe de conflit dans le nom réseau', () => {
    const output = [
      '10:38:13.539  Add        2  14 local.               _http._tcp.          Website for SMA-Inverter: SMA3087654321-2',
      '17:08:22.754  Add        2  14 local.               _hwenergy._tcp.      p1meter-1A2B3C-2',
    ].join('\n');
    expect(parseSmaHosts(output)).toEqual(['SMA3087654321-2.local']);
    expect(parseSmaInstances(output)).toEqual(['Website for SMA-Inverter: SMA3087654321-2']);
    expect(parseP1Hosts(output)).toEqual(['p1meter-1a2b3c-2.local']);
  });

  it('lit le nom réseau donné par la résolution du service', () => {
    const output =
      '10:38:22.940  Website\\032for\\032SMA-Inverter:\\032SMA3087654321-2._http._tcp.local. can be reached at SMA3087654321-2.local.:443 (interface 14)';
    expect(parseResolvedHost(output)).toBe('SMA3087654321-2.local');
    expect(parseResolvedHost('...STARTING...')).toBeNull();
  });

  it('reconnaît le même appareil quel que soit le suffixe', () => {
    expect(smaSerial('SMA3087654321.local')).toBe('SMA3087654321');
    expect(smaSerial('sma3087654321-2.local')).toBe('SMA3087654321');
    expect(smaSerial('192.168.1.42')).toBeNull();
    expect(p1Identity('p1meter-1A2B3C-3.local')).toBe('p1meter-1a2b3c');
    expect(p1Identity('energysocket-123456.local')).toBeNull();
  });

  it('propose le nouveau nom du même appareil', () => {
    const found = ['SMA3099999999.local', 'SMA3087654321-2.local'];
    expect(relocatedHost('SMA3087654321.local', found, smaSerial)).toBe('SMA3087654321-2.local');
    // Le nom actuel est encore annoncé : rien à changer.
    expect(relocatedHost('SMA3087654321-2.local', found, smaSerial)).toBeNull();
    // Autre appareil seulement : refusé, sauf « seul appareil trouvé » quand c'est permis.
    expect(relocatedHost('SMA3087654321.local', ['SMA3099999999.local'], smaSerial)).toBeNull();
    expect(relocatedHost('192.168.1.42', ['SMA3099999999.local'], smaSerial, true)).toBe(
      'SMA3099999999.local',
    );
    expect(relocatedHost('192.168.1.42', found, smaSerial, true)).toBeNull();
  });
});
