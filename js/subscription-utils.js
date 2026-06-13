// Модуль: subscription-utils — статуси абонементів і списання/повернення занять

import { supabase } from './supabase.js';

/** Статус абонемента: active | expiring | expired | none (за датою та залишком візитів). */
export function getSubStatus(sub) {
  if (!sub) return 'none';
  const remaining = sub.visits_total - sub.visits_used;
  const daysLeft = Math.floor((new Date(sub.end_date) - Date.now()) / 86400000);
  if (daysLeft < 0 || remaining <= 0) return 'expired';
  if (daysLeft <= 7 || remaining <= 2) return 'expiring';
  return 'active';
}

/** Скільки занять залишилось на абонементі. */
export function getSubscriptionRemaining(sub) {
  return (sub?.visits_total ?? 0) - (sub?.visits_used ?? 0);
}

/** Перший активний або «закінчується» абонемент зі списку. */
export function pickActiveSubscription(subs = []) {
  return subs.find(s => {
    const st = getSubStatus(s);
    return st === 'active' || st === 'expiring';
  }) || null;
}

/** Абонемент для відображення в списку: активний, інакше останній за датою початку. */
export function pickDisplaySubscription(subs = []) {
  const active = pickActiveSubscription(subs);
  if (active) return active;
  if (!subs.length) return null;
  return [...subs].sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0];
}

/** Статус абонемента клієнта для списку та фільтрів CRM. */
export function getClientListSubStatus(client) {
  const subs = client?.client_subscriptions || [];
  if (!subs.length) return 'none';
  return getSubStatus(pickDisplaySubscription(subs));
}

/** Завантажує всі абонементи клієнта з БД. */
export async function fetchClientSubscriptions(clientId) {
  const { data, error } = await supabase
    .from('client_subscriptions')
    .select('id, client_id, visits_total, visits_used, start_date, end_date')
    .eq('client_id', clientId)
    .order('start_date', { ascending: false });
  return { data: data || [], error };
}

/** Списує одне заняття з абонемента клієнта. Повертає { ok, sub } або { ok: false, message }. */
export async function chargeSubscriptionVisit(clientId) {
  const { data: subs, error } = await fetchClientSubscriptions(clientId);
  if (error) return { ok: false, message: 'Помилка перевірки абонемента' };

  const sub = pickActiveSubscription(subs);
  if (!sub) return { ok: false, message: 'У клієнта немає активного абонемента' };
  if (getSubscriptionRemaining(sub) <= 0) {
    return { ok: false, message: 'На абонементі не залишилось занять' };
  }

  const { error: updErr } = await supabase
    .from('client_subscriptions')
    .update({ visits_used: sub.visits_used + 1 })
    .eq('id', sub.id);

  if (updErr) return { ok: false, message: 'Не вдалося списати заняття з абонемента' };
  return { ok: true, sub };
}

/** Повертає одне заняття на абонемент (при скасуванні запису). */
export async function restoreSubscriptionVisit(clientId) {
  const { data: subs, error } = await fetchClientSubscriptions(clientId);
  if (error) return { ok: false, message: 'Помилка повернення заняття на абонемент' };

  const sub = subs.find(s => s.visits_used > 0);
  if (!sub) return { ok: true };

  const { error: updErr } = await supabase
    .from('client_subscriptions')
    .update({ visits_used: Math.max(0, sub.visits_used - 1) })
    .eq('id', sub.id);

  if (updErr) return { ok: false, message: 'Не вдалося повернути заняття на абонемент' };
  return { ok: true };
}
