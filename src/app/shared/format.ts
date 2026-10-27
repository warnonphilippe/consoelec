import { Pipe, type PipeTransform } from '@angular/core';
import { dayNumberToDate, toDayNumber } from '../core/calc/time';

const LOCALE = 'fr-BE';
const intFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const decFormat = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const euroFormat = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const euroCentsFormat = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateFormat = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const longDateFormat = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const valid = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v);

export const fmt = {
  kwh: (v: number | null | undefined, decimals = 0): string =>
    valid(v) ? `${decimals === 1 ? decFormat.format(v) : intFormat.format(v)} kWh` : '—',
  /** Valeur signée (+ / −) en kWh. */
  signedKwh: (v: number | null | undefined): string =>
    valid(v) ? `${v > 0.5 ? '+' : v < -0.5 ? '−' : ''}${intFormat.format(Math.abs(v))} kWh` : '—',
  number: (v: number | null | undefined, decimals = 0): string =>
    valid(v) ? (decimals === 1 ? decFormat.format(v) : intFormat.format(v)) : '—',
  pct: (v: number | null | undefined): string => (valid(v) ? `${intFormat.format(v)} %` : '—'),
  /** Montant en euros (arrondi à l'euro, ou au centime avec `cents`). */
  euro: (v: number | null | undefined, cents = false): string =>
    valid(v) ? (cents ? euroCentsFormat : euroFormat).format(v) : '—',
  /** Numéro de jour ou chaîne ISO locale → date courte. */
  date: (v: number | string | null | undefined): string => format(v, dateFormat),
  longDate: (v: number | string | null | undefined): string => format(v, longDateFormat),
  dateTime: (v: number | string | null | undefined): string => format(v, dateTimeFormat),
};

function format(v: number | string | null | undefined, formatter: Intl.DateTimeFormat): string {
  if (v === null || v === undefined) {
    return '—';
  }
  const day = typeof v === 'string' ? toDayNumber(v) : v;
  return Number.isFinite(day) ? formatter.format(dayNumberToDate(day)) : '—';
}

@Pipe({ name: 'kwh' })
export class KwhPipe implements PipeTransform {
  transform(value: number | null | undefined, decimals = 0): string {
    return fmt.kwh(value, decimals);
  }
}

@Pipe({ name: 'skwh' })
export class SignedKwhPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return fmt.signedKwh(value);
  }
}

@Pipe({ name: 'pct' })
export class PctPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return fmt.pct(value);
  }
}

@Pipe({ name: 'num' })
export class NumPipe implements PipeTransform {
  transform(value: number | null | undefined, decimals = 0): string {
    return fmt.number(value, decimals);
  }
}

@Pipe({ name: 'day' })
export class DayPipe implements PipeTransform {
  transform(
    value: number | string | null | undefined,
    style: 'short' | 'long' | 'time' = 'short',
  ): string {
    return style === 'long'
      ? fmt.longDate(value)
      : style === 'time'
        ? fmt.dateTime(value)
        : fmt.date(value);
  }
}

@Pipe({ name: 'euro' })
export class EuroPipe implements PipeTransform {
  transform(value: number | null | undefined, cents = false): string {
    return fmt.euro(value, cents);
  }
}

export const FORMAT_PIPES = [KwhPipe, SignedKwhPipe, PctPipe, NumPipe, DayPipe, EuroPipe] as const;
