// Модуль: cabinet — особистий кабінет клієнта (профіль, абонемент, записи)

import { supabase } from './supabase.js';
import { requireAuth, signOut } from './auth.js';
import {
  getSubStatus,
  getSubscriptionRemaining,
  pickActiveSubscription,
  restoreSubscriptionVisit,
} from './subscription-utils.js';
import {
  bookClientToClass,
  canCancelBooking,
  resolveBookingStatus,
  syncPastBookingsToAttended,
} from './booking-utils.js';

const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

/** Приводить id до рядка — DOM і Supabase можуть віддавати число або рядок. */
function idKey(id) {
  return id == null || id === '' ? '' : String(id);
}

function findClassById(classId) {
  const key = idKey(classId);
  return allClasses.find((c) => idKey(c.id) === key) || null;
}

let profile = null;
let activeSubscription = null;
let allClasses = [];
let myBookings = [];
let myBookedClassIds = new Set();
let activeWeek = 0;
let activeDay = 0;
let bookingInFlight = false;

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('logoutBtn')?.addEventListener('click', () => signOut());

  try {
    profile = await requireAuth(['client']);
    if (!profile) return;

    initHeader();
    initProfileEditor();
    initWeekTabs();
    initDayTabs();
    initScheduleBookingHandlers();

    await Promise.all([
      loadSubscription(),
      loadUpcomingBookings(),
      loadSchedule(),
    ]);

    renderSchedule();
  } catch (err) {
    console.error('Cabinet init error:', err);
    showToast('Помилка завантаження кабінету', 'error');
  }
});

// ── Профіль і заголовок ────────────────────────

function initHeader() {
  const name = profile.full_name || 'Клієнт';
  document.getElementById('cabinetUserName').textContent = name;
  document.getElementById('cabinetGreeting').textContent = `Вітаємо, ${name.split(' ')[0]}! Керуйте абонементом та записами на заняття.`;
  renderProfileView();
}

function splitFullName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function formatPhoneDisplay(nationalDigits) {
  let result = '+380';
  if (!nationalDigits.length) return result;
  const parts = [
    nationalDigits.slice(0, 2),
    nationalDigits.slice(2, 5),
    nationalDigits.slice(5, 7),
    nationalDigits.slice(7, 9),
  ].filter(Boolean);
  if (parts[0]) result += ' ' + parts[0];
  if (parts[1]) result += ' ' + parts[1];
  if (parts[2]) result += ' ' + parts[2];
  if (parts[3]) result += ' ' + parts[3];
  return result;
}

function extractNationalDigits(value) {
  let digits = String(value).replace(/\D/g, '');
  if (digits.startsWith('380')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.slice(0, 9);
}

function normalizePhoneValue(value) {
  const national = extractNationalDigits(value);
  return national.length === 9 ? '+380' + national : '';
}

function bindProfilePhoneInput(input) {
  input.addEventListener('focus', () => {
    if (!input.value.trim()) input.value = '+380 ';
  });
  input.addEventListener('blur', () => {
    const national = extractNationalDigits(input.value);
    input.value = national.length ? formatPhoneDisplay(national) : '';
  });
  input.addEventListener('input', () => {
    const selStart = input.selectionStart;
    const prevLen = input.value.length;
    const national = extractNationalDigits(input.value);
    input.value = formatPhoneDisplay(national);
    const diff = input.value.length - prevLen;
    if (typeof selStart === 'number') {
      input.setSelectionRange(selStart + diff, selStart + diff);
    }
    input.classList.remove('is-invalid');
  });
}

function renderProfileView() {
  const view = document.getElementById('profileView');
  if (!view || !profile) return;

  const { firstName, lastName } = splitFullName(profile.full_name);
  const rows = [
    ['Ім\'я', firstName || '—'],
    ['Прізвище', lastName || '—'],
    ['Email', profile.email || '—'],
    ['Телефон', profile.phone || '—'],
  ];

  view.innerHTML = rows.map(([label, value]) => `
    <div class="profile-view-item">
      <span class="profile-view-label">${label}</span>
      <span class="profile-view-value">${escapeHtml(value)}</span>
    </div>
  `).join('');
}

function fillProfileEditForm() {
  const { firstName, lastName } = splitFullName(profile.full_name);
  document.getElementById('profileFirstName').value = firstName;
  document.getElementById('profileLastName').value = lastName;
  document.getElementById('profileEmail').value = profile.email || '';
  const phoneEl = document.getElementById('profilePhone');
  phoneEl.value = profile.phone ? formatPhoneDisplay(extractNationalDigits(profile.phone)) : '';
}

function setProfileEditMode(editing) {
  const view = document.getElementById('profileView');
  const form = document.getElementById('profileEditForm');
  const editBtn = document.getElementById('profileEditBtn');
  if (!view || !form || !editBtn) return;

  view.classList.toggle('hidden', editing);
  form.classList.toggle('hidden', !editing);
  editBtn.classList.toggle('hidden', editing);
  if (editing) fillProfileEditForm();
}

function validateProfileEditForm() {
  const firstName = document.getElementById('profileFirstName').value.trim();
  const lastName = document.getElementById('profileLastName').value.trim();
  const email = document.getElementById('profileEmail').value.trim();
  const phoneEl = document.getElementById('profilePhone');
  const phone = normalizePhoneValue(phoneEl.value);

  phoneEl.classList.remove('is-invalid');
  document.getElementById('profileEmail').classList.remove('is-invalid');

  if (!firstName) {
    showToast("Введіть ім'я", 'error');
    document.getElementById('profileFirstName').focus();
    return null;
  }
  if (!lastName) {
    showToast('Введіть прізвище', 'error');
    document.getElementById('profileLastName').focus();
    return null;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Введіть коректний email', 'error');
    document.getElementById('profileEmail').classList.add('is-invalid');
    document.getElementById('profileEmail').focus();
    return null;
  }
  if (!phone) {
    showToast('Введіть коректний номер телефону', 'error');
    phoneEl.classList.add('is-invalid');
    phoneEl.focus();
    return null;
  }

  return {
    full_name: `${firstName} ${lastName}`.trim(),
    email: email.toLowerCase(),
    phone,
  };
}

function initProfileEditor() {
  const editBtn = document.getElementById('profileEditBtn');
  const form = document.getElementById('profileEditForm');
  const cancelBtn = document.getElementById('profileCancelBtn');
  const phoneEl = document.getElementById('profilePhone');

  if (!editBtn || !form) return;

  bindProfilePhoneInput(phoneEl);
  editBtn.addEventListener('click', () => setProfileEditMode(true));
  cancelBtn?.addEventListener('click', () => setProfileEditMode(false));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = validateProfileEditForm();
    if (!payload) return;

    const saveBtn = document.getElementById('profileSaveBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Збереження...';

    const emailChanged = payload.email !== (profile.email || '').toLowerCase();

    const { data, error } = await supabase
      .from('profiles')
      .update({
        full_name: payload.full_name,
        email: payload.email,
        phone: payload.phone,
      })
      .eq('id', profile.id)
      .select('*')
      .single();

    if (error) {
      showToast('Не вдалося зберегти дані', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Зберегти';
      return;
    }

    if (emailChanged) {
      const { error: authError } = await supabase.auth.updateUser({ email: payload.email });
      if (authError) {
        showToast('Профіль оновлено, але email для входу не змінено. Зверніться до студії.', 'error');
      }
    }

    profile = data;
    initHeader();
    setProfileEditMode(false);
    showToast('Дані збережено', 'success');

    saveBtn.disabled = false;
    saveBtn.textContent = 'Зберегти';
  });
}

// ── Розклад: вкладки тижнів і днів ─────────────

function initWeekTabs() {
  document.querySelectorAll('.week-tabs .schedule-day-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeWeek = Number(tab.dataset.week);
      document.querySelectorAll('.week-tabs .schedule-day-tab').forEach((t) => {
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      updateDayTabsForWeek();
      renderSchedule();
    });
  });
}

function initDayTabs() {
  const container = document.getElementById('scheduleDayTabs');
  container.innerHTML = DAY_LABELS.map((label, i) => `
    <button
      type="button"
      role="tab"
      class="schedule-day-tab"
      data-day="${i}"
      aria-selected="${i === activeDay ? 'true' : 'false'}"
    >${label}</button>
  `).join('');

  container.querySelectorAll('.schedule-day-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeDay = Number(tab.dataset.day);
      container.querySelectorAll('.schedule-day-tab').forEach((t) => {
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      renderSchedule();
    });
  });

  updateDayTabsForWeek();
}

function getMonday(weekOffset = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff + weekOffset * 7);
  return d;
}

function getSelectedDate() {
  const monday = getMonday(activeWeek);
  const date = new Date(monday);
  date.setDate(monday.getDate() + activeDay);
  return date;
}

function updateDayTabsForWeek() {
  const monday = getMonday(activeWeek);

  document.querySelectorAll('#scheduleDayTabs .schedule-day-tab').forEach((tab, i) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + i);
    tab.textContent = formatDayTabLabel(date, i);
  });
}

function isSameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  );
}

function formatDayTabLabel(date, dayIndex) {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const numeric = `${day}.${String(month).padStart(2, '0')}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isToday = date.getTime() === today.getTime();
  return isToday ? `${DAY_LABELS[dayIndex]} ${numeric} · сьогодні` : `${DAY_LABELS[dayIndex]} ${numeric}`;
}

function formatDateNumeric(date) {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function formatDateShort(iso) {
  return new Date(iso).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
}

// ── Абонемент ──────────────────────────────────

/** Завантажує абонементи клієнта та показує активний. */
async function loadSubscription() {
  const { data, error } = await supabase
    .from('client_subscriptions')
    .select(`
      id, visits_total, visits_used, start_date, end_date,
      subscription_type:subscription_types(id, name, visit_count, price)
    `)
    .eq('client_id', profile.id)
    .order('start_date', { ascending: false });

  if (error) {
    document.getElementById('subscriptionContent').innerHTML =
      '<p class="cabinet-empty">Не вдалося завантажити абонемент</p>';
    return;
  }

  activeSubscription = pickActiveSubscription(data || []);
  renderSubscription(activeSubscription);
}

function subStatusLabel(status) {
  const map = {
    active: ['sub-status-active', 'Активний'],
    expiring: ['sub-status-expiring', 'Закінчується'],
    expired: ['sub-status-expired', 'Закінчився'],
    none: ['sub-status-none', 'Без абонементу'],
  };
  return map[status] || map.none;
}

function renderSubscription(sub) {
  const el = document.getElementById('subscriptionContent');
  const status = getSubStatus(sub);
  const [badgeClass, badgeText] = subStatusLabel(status);

  if (!sub) {
    el.innerHTML = `
      <span class="sub-status-badge ${badgeClass}">${badgeText}</span>
      <p class="cabinet-empty">У вас немає активного абонемента. Зверніться до студії, щоб придбати або активувати абонемент.</p>
    `;
    return;
  }

  const remaining = getSubscriptionRemaining(sub);
  const typeName = sub.subscription_type?.name || 'Абонемент';
  const endStr = new Date(sub.end_date).toLocaleDateString('uk-UA');

  el.innerHTML = `
    <span class="sub-status-badge ${badgeClass}">${badgeText}</span>
    <div class="sub-details">
      <div class="sub-detail-row">
        <span class="sub-detail-label">Тип</span>
        <span class="sub-detail-value">${escapeHtml(typeName)}</span>
      </div>
      <div class="sub-detail-row">
        <span class="sub-detail-label">Діє до</span>
        <span class="sub-detail-value">${endStr}</span>
      </div>
      <div class="sub-detail-row">
        <span class="sub-detail-label">Залишилось занять</span>
        <span class="sub-detail-value">${remaining} з ${sub.visits_total}</span>
      </div>
    </div>
  `;
}

// ── Майбутні записи ────────────────────────────

/** Завантажує записи клієнта та синхронізує статуси минулих занять. */
async function loadUpcomingBookings() {
  const { data, error } = await supabase
    .from('class_bookings')
    .select(`
      id, status, class_id,
      class:classes(
        id, starts_at, ends_at, status,
        direction:directions(name),
        trainer:profiles!classes_trainer_id_fkey(full_name),
        room:rooms(name)
      )
    `)
    .eq('client_id', profile.id)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false });

  if (error) {
    document.getElementById('upcomingBookings').innerHTML =
      '<p class="cabinet-empty">Не вдалося завантажити записи</p>';
    return;
  }

  const now = Date.now();
  myBookings = (data || [])
    .filter((b) => b.class && new Date(b.class.starts_at).getTime() > now)
    .sort((a, b) => new Date(a.class.starts_at) - new Date(b.class.starts_at));

  await syncPastBookingsToAttended(myBookings);

  myBookedClassIds = new Set(
    (data || [])
      .filter((b) => b.status !== 'cancelled' && b.class)
      .map((b) => idKey(b.class_id))
  );

  renderUpcomingBookings();
}

function renderUpcomingBookings() {
  const el = document.getElementById('upcomingBookings');
  const upcoming = myBookings.filter((b) => resolveBookingStatus(b) === 'booked');

  if (!upcoming.length) {
    el.innerHTML = '<p class="cabinet-empty">Немає майбутніх записів. Оберіть заняття в розкладі нижче.</p>';
    return;
  }

  el.innerHTML = `<div class="booking-upcoming-list">${upcoming.map((b) => {
    const cls = b.class;
    const dir = cls.direction?.name || 'Заняття';
    const trainer = cls.trainer?.full_name || '—';
    const room = cls.room?.name || '—';
    const dateStr = formatDateShort(cls.starts_at);
    const timeStr = formatTime(cls.starts_at);
    return `
      <article class="booking-upcoming-item">
        <div class="booking-upcoming-title">${escapeHtml(dir)}</div>
        <div class="booking-upcoming-meta">${dateStr}, ${timeStr} · ${escapeHtml(trainer)} · ${escapeHtml(room)}</div>
        <button type="button" class="booking-upcoming-cancel" data-booking-id="${b.id}">Скасувати запис</button>
      </article>
    `;
  }).join('')}</div>`;

  el.querySelectorAll('.booking-upcoming-cancel').forEach((btn) => {
    btn.addEventListener('click', () => cancelBooking(btn.dataset.bookingId));
  });
}

// ── Розклад занять ─────────────────────────────

/** Завантажує заняття на поточний і наступний тиждень з кількістю записів. */
async function loadSchedule() {
  const start = getMonday(0);
  const end = new Date(getMonday(1));
  end.setDate(end.getDate() + 7);
  end.setHours(23, 59, 59, 999);

  const { data, error } = await supabase
    .from('classes')
    .select(`
      id, starts_at, ends_at, max_participants, status,
      direction:directions(id, name, color),
      trainer:profiles!classes_trainer_id_fkey(id, full_name)
    `)
    .gte('starts_at', start.toISOString())
    .lte('starts_at', end.toISOString())
    .neq('status', 'cancelled')
    .order('starts_at');

  if (error) {
    console.warn('Schedule load:', error);
    document.getElementById('scheduleClassList').innerHTML =
      '<p class="cabinet-empty">Розклад тимчасово недоступний</p>';
    allClasses = [];
    return;
  }

  allClasses = await attachBookedCounts(data || []);
}

async function attachBookedCounts(classes) {
  if (!classes.length) return [];

  const ids = classes.map((c) => c.id);
  const { data } = await supabase
    .from('class_bookings')
    .select('class_id')
    .in('class_id', ids)
    .neq('status', 'cancelled');

  const counts = {};
  for (const row of data || []) {
    const key = idKey(row.class_id);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return classes.map((c) => ({ ...c, booked_count: counts[idKey(c.id)] ?? 0 }));
}

async function fetchBookedCount(classId) {
  const { count } = await supabase
    .from('class_bookings')
    .select('id', { count: 'exact', head: true })
    .eq('class_id', classId)
    .neq('status', 'cancelled');
  return count ?? 0;
}

function initScheduleBookingHandlers() {
  document.getElementById('scheduleClassList')?.addEventListener('click', (e) => {
    const bookBtn = e.target.closest('[data-book-class]');
    if (bookBtn && !bookBtn.disabled) {
      e.preventDefault();
      e.stopPropagation();
      void bookClass(bookBtn.getAttribute('data-book-class'));
      return;
    }

    const cancelBtn = e.target.closest('[data-cancel-id]');
    if (cancelBtn && !cancelBtn.disabled) {
      e.preventDefault();
      e.stopPropagation();
      void cancelBooking(cancelBtn.getAttribute('data-cancel-id'));
    }
  });
}

function renderSchedule() {
  const container = document.getElementById('scheduleClassList');
  const selectedDate = getSelectedDate();
  const now = Date.now();

  const dayClasses = allClasses
    .filter((cls) => isSameCalendarDay(new Date(cls.starts_at), selectedDate))
    .filter((cls) => new Date(cls.starts_at).getTime() > now)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  if (!dayClasses.length) {
    container.innerHTML = `
      <p class="cabinet-empty" style="padding: 24px 0;">
        На ${formatDateNumeric(selectedDate)} немає доступних занять для запису.
      </p>
    `;
    return;
  }

  container.innerHTML = dayClasses.map((cls) => {
    const booked = cls.booked_count ?? 0;
    const spotsLeft = cls.max_participants - booked;
    const isBooked = myBookedClassIds.has(idKey(cls.id));
    const canBook = canBookClass(cls, spotsLeft, isBooked);

    let actionHtml;
    if (isBooked) {
      const booking = myBookings.find(
        (b) => idKey(b.class_id) === idKey(cls.id) && b.status !== 'cancelled'
      );
      actionHtml = booking
        ? `<button type="button" class="btn-book btn-book-secondary" data-cancel-id="${booking.id}">Скасувати</button>`
        : '';
    } else if (spotsLeft <= 0) {
      actionHtml = '<button type="button" class="btn-book btn-book-primary" disabled>Немає місць</button>';
    } else if (!activeSubscription || getSubscriptionRemaining(activeSubscription) <= 0) {
      actionHtml = '<button type="button" class="btn-book btn-book-primary" disabled>Немає абонемента</button>';
    } else {
      actionHtml = `<button type="button" class="btn-book btn-book-primary" data-book-class="${cls.id}">Записатися</button>`;
    }

    const dir = cls.direction?.name || 'Заняття';
    const trainer = cls.trainer?.full_name || '—';
    const timeStr = `${formatTime(cls.starts_at)} – ${formatTime(cls.ends_at)}`;

    return `
      <article class="schedule-class-row">
        <div class="schedule-class-name">${escapeHtml(dir)}</div>
        <div class="schedule-class-time">${timeStr}</div>
        <div class="schedule-class-trainer">${escapeHtml(trainer)}</div>
        <div class="schedule-class-spots">Вільних місць: ${Math.max(0, spotsLeft)} з ${cls.max_participants}</div>
        <div class="schedule-class-actions">${actionHtml}</div>
      </article>
    `;
  }).join('');
}

function canBookClass(cls, spotsLeft, isBooked) {
  if (isBooked) return false;
  if (spotsLeft <= 0) return false;
  if (!activeSubscription || getSubscriptionRemaining(activeSubscription) <= 0) return false;
  if (cls.status === 'cancelled') return false;
  if (new Date(cls.starts_at).getTime() <= Date.now()) return false;
  return true;
}

/** Запис на заняття: перевірка місць → списання з абонемента → insert/update booking. */
async function bookClass(classId) {
  const classKey = idKey(classId);
  if (bookingInFlight || !classKey || !profile?.id) return;

  const cls = findClassById(classKey);
  if (!cls) {
    showToast('Заняття не знайдено. Оновіть розклад.', 'error');
    return;
  }

  bookingInFlight = true;
  const bookBtn = document.querySelector(`[data-book-class="${classKey}"]`);
  if (bookBtn) {
    bookBtn.disabled = true;
    bookBtn.textContent = 'Запис...';
  }

  try {
    const bookedCount = await fetchBookedCount(cls.id);
    cls.booked_count = bookedCount;
    const spotsLeft = cls.max_participants - bookedCount;

    if (!canBookClass(cls, spotsLeft, myBookedClassIds.has(classKey))) {
      showToast('Запис на це заняття недоступний', 'error');
      renderSchedule();
      return;
    }

    const result = await bookClientToClass(profile.id, cls.id);
    if (!result.ok) {
      if (result.reason === 'charge_failed') {
        showToast(result.message, 'error');
        await loadSubscription();
      } else if (result.reason === 'already_booked' || result.reason === 'duplicate') {
        showToast('Ви вже записані на це заняття', 'error');
      } else {
        showToast('Не вдалося записатися', 'error');
      }
      return;
    }

    showToast('Ви успішно записані!', 'success');
    await Promise.all([
      loadSubscription(),
      loadUpcomingBookings(),
      loadSchedule(),
    ]);
    renderSchedule();
  } catch (err) {
    console.error('bookClass:', err);
    showToast('Не вдалося записатися', 'error');
  } finally {
    bookingInFlight = false;
  }
}

/** Скасування запису з поверненням заняття на абонемент. */
async function cancelBooking(bookingId) {
  const bookingKey = idKey(bookingId);
  const booking = myBookings.find((b) => idKey(b.id) === bookingKey);
  if (!booking) return;

  const bookingCtx = {
    ...booking,
    class: booking.class,
  };

  if (!canCancelBooking(bookingCtx)) {
    showToast('Неможливо скасувати це заняття', 'error');
    return;
  }

  if (!confirm('Скасувати запис на це заняття?')) return;

  const { error } = await supabase
    .from('class_bookings')
    .update({ status: 'cancelled' })
    .eq('id', booking.id);

  if (error) {
    showToast('Помилка скасування', 'error');
    return;
  }

  const restored = await restoreSubscriptionVisit(profile.id);
  if (!restored.ok) {
    showToast(restored.message || 'Запис скасовано, але заняття не повернулось на абонемент', 'error');
  } else {
    showToast('Запис скасовано', 'success');
  }

  await Promise.all([
    loadSubscription(),
    loadUpcomingBookings(),
    loadSchedule(),
  ]);
  renderSchedule();
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer;
function showToast(message, type = 'info') {
  const el = document.getElementById('cabinetToast');
  if (!el) return;

  el.textContent = message;
  el.className = 'cabinet-toast';
  if (type === 'success') el.classList.add('toast-success');
  if (type === 'error') el.classList.add('toast-error');
  el.classList.remove('hidden');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}
