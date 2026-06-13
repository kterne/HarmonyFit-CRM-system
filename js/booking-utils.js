// Модуль: booking-utils — статуси записів на заняття (CRM і кабінет)

import { supabase } from './supabase.js';
import { chargeSubscriptionVisit, restoreSubscriptionVisit } from './subscription-utils.js';

/** Чи заняття вже завершилось (за ends_at або starts_at, якщо кінець не вказано). */
export function isClassFinished(booking) {
  const endsAt = booking?.class?.ends_at;
  const startsAt = booking?.class?.starts_at;
  const when = endsAt || startsAt;
  if (!when) return false;
  return new Date(when).getTime() <= Date.now();
}

/** Логічний статус запису: після кінця заняття «booked» стає «attended». */
export function resolveBookingStatus(booking) {
  if (!booking) return 'booked';
  if (booking.status === 'cancelled') return 'cancelled';
  if (booking.status === 'attended') return 'attended';
  if (booking.status === 'booked' && isClassFinished(booking)) return 'attended';
  return 'booked';
}

/** Скасування дозволене лише для майбутніх записів зі статусом «booked». */
export function canCancelBooking(booking) {
  return resolveBookingStatus(booking) === 'booked';
}

/** Зберігає в БД перехід booked → attended для минулих занять. */
export async function syncPastBookingsToAttended(bookings = []) {
  if (!bookings.length) return bookings;

  const ids = bookings
    .filter(b => b.status === 'booked' && isClassFinished(b))
    .map(b => b.id);

  if (!ids.length) return bookings;

  const { error } = await supabase
    .from('class_bookings')
    .update({ status: 'attended' })
    .in('id', ids);

  if (!error) {
    bookings.forEach(b => {
      if (ids.includes(b.id)) b.status = 'attended';
    });
  }

  return bookings;
}

/**
 * Записує клієнта на заняття: списання з абонемента → insert/update booking.
 * Перевірку вільних місць виконує викликаючий код.
 */

export async function bookClientToClass(clientId, classId) {
  const charge = await chargeSubscriptionVisit(clientId);
  if (!charge.ok) {
    return { ok: false, reason: 'charge_failed', message: charge.message };
  }

  const { data: existing, error: existingErr } = await supabase
    .from('class_bookings')
    .select('id, status')
    .eq('class_id', classId)
    .eq('client_id', clientId)
    .maybeSingle();

  if (existingErr) {
    await restoreSubscriptionVisit(clientId);
    return { ok: false, reason: 'lookup_failed' };
  }

  let error;
  if (existing) {
    if (existing.status !== 'cancelled') {
      await restoreSubscriptionVisit(clientId);
      return { ok: false, reason: 'already_booked' };
    }
    ({ error } = await supabase
      .from('class_bookings')
      .update({ status: 'booked' })
      .eq('id', existing.id));
  } else {
    ({ error } = await supabase.from('class_bookings').insert({
      class_id: classId,
      client_id: clientId,
      status: 'booked',
    }));
  }

  if (error) {
    await restoreSubscriptionVisit(clientId);
    if (error.code === '23505') {
      return { ok: false, reason: 'duplicate' };
    }
    return { ok: false, reason: 'save_failed' };
  }

  return { ok: true };
}
