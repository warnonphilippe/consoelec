import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { P1Client } from './p1';

describe('client du lecteur P1', () => {
  let server: http.Server;
  let port = 0;
  let requested: string[] = [];
  let reply: (res: http.ServerResponse) => void = () => undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requested.push(req.url ?? '');
      reply(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    requested = [];
  });

  const client = (host = '127.0.0.1'): P1Client => {
    const c = new P1Client(() => null, port);
    c.configure({ enabled: true, host });
    return c;
  };

  const json =
    (body: unknown, status = 200) =>
    (res: http.ServerResponse) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

  it("n'est actif qu'avec une adresse et l'option cochée", () => {
    const c = new P1Client(() => null, port);
    expect(c.enabled).toBe(false);
    c.configure({ enabled: true, host: '' });
    expect(c.enabled).toBe(false);
    c.configure({ enabled: true, host: 'p1meter-ABCDEF.local' });
    expect(c.enabled).toBe(true);
    c.configure({ enabled: false, host: 'p1meter-ABCDEF.local' });
    expect(c.enabled).toBe(false);
  });

  it('lit les index sur /api/v1/data', async () => {
    reply = json({
      active_tariff: 2,
      total_power_import_t1_kwh: 10,
      total_power_import_t2_kwh: 20,
      total_power_export_t1_kwh: 30,
      total_power_export_t2_kwh: 40,
      active_power_w: -800,
    });
    const reading = await client().read();
    expect(requested).toEqual(['/api/v1/data']);
    expect(reading).toMatchObject({
      error: null,
      tariff: 2,
      importPeak: 10,
      importOff: 20,
      exportPeak: 30,
      exportOff: 40,
      powerW: -800,
    });
  });

  it("signale l'API locale désactivée", async () => {
    reply = json({ error: 'api:disabled' }, 403);
    const reading = await client().read();
    expect(reading.error).toMatch(/API locale/);
    expect(reading.importPeak).toBeNull();
  });

  it("signale un appareil qui n'est pas un lecteur P1", async () => {
    reply = json({ hello: 'world' });
    expect((await client().read()).error).toMatch(/pas un lecteur P1/);
  });

  it('signale un corps qui ne se lit pas', async () => {
    reply = (res) => res.end('<html>pas du JSON</html>');
    expect((await client().read()).error).toMatch(/pas un lecteur P1/);
  });

  it('demande une adresse', async () => {
    const c = new P1Client(() => null, port);
    expect((await c.read()).error).toMatch(/non renseignée/);
  });

  it('signale un lecteur injoignable sans lever', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const free = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const c = new P1Client(() => null, free);
    c.configure({ enabled: true, host: '127.0.0.1' });
    expect((await c.read()).error).toMatch(/Lecteur P1 injoignable/);
  });
});
