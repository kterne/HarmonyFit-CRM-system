// Модуль: trainer-cabinet — особистий кабінет тренера (профіль, розклад, учасники)

import { supabase } from './supabase.js';
import { requireAuth, signOut } from './auth.js';

const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

function idKey(id) {
  return id == null || id === '' ? '' : String(id);
}

let profile = null;
let trainerDirections = [];
let allClasses = [];
let bookingsByClass = new Map();
let expandedClassIds = new Set();
let activeWeek = 0;
let activeDay = 0;

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('logoutBtn')?.addEventListener('click', () => signOut());

  try {
    profile = await requireAuth(['trainer']);
    if (!profile) return;

    initHeader();
    initProfileEditor();
    initWeekTabs();
    initDayTabs();
    initScheduleHandlers();

    await Promise.all([
      loadTrainerDirections(),
      loadSchedule(),
    ]);

    renderSchedule();
  } catch (err) {
    console.error('Trainer cabinet init error:', err);
    showToast('Помилка завантаження кабінету', 'error');
  }
});

// ── Профіль ────────────────────────────────────

function initHeader() {
  const name = profile.full_name || 'Тренер';
  document.getElementById('cabinetUserName').textContent = name;
  document.getElementById('cabinetGreeting').textContent =
    `Вітаємо, ${name.split(' ')[0]}! Переглядайте розклад та список записаних учасників.`;
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

function formatDirectionsList() {
  if (!trainerDirections.length) return '—';
  return trainerDirections
    .map((td) => td.direction?.name)
    .filter(Boolean)
    .join(', ');
}

async function loadTrainerDirections() {
  const { data, error } = await supabase
    .from('trainer_directions')
    .select('direction:directions(name, color)')
    .eq('trainer_id', profile.id);

  if (error) {
    console.warn('Trainer directions load:', error);
    trainerDirections = [];
  } else {
    trainerDirections = data || [];
  }
  renderProfileView();
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
    ['Напрямки тренувань', formatDirectionsList()],
  ];

  view.innerHTML = rows.map(([label, value], i) => {
    const isDirections = i === rows.length - 1;
    const valueClass = isDirections ? 'profile-view-value profile-directions-value' : 'profile-view-value';
    return `
      <div class="profile-view-item${isDirections ? ' profile-view-item--full' : ''}">
        <span class="profile-view-label">${label}</span>
        <span class="${valueClass}">${escapeHtml(value)}</span>
      </div>
    `;
  }).join('');
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

// ── Розклад: вкладки ───────────────────────────

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

// ── Розклад і записи ───────────────────────────

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
      room:rooms(name)
    `)
    .eq('trainer_id', profile.id)
    .gte('starts_at', start.toISOString())
    .lte('starts_at', end.toISOString())
    .neq('status', 'cancelled')
    .order('starts_at');

  if (error) {
    console.warn('Schedule load:', error);
    document.getElementById('scheduleClassList').innerHTML =
      '<p class="cabinet-empty">Розклад тимчасово недоступний</p>';
    allClasses = [];
    bookingsByClass = new Map();
    return;
  }

  allClasses = data || [];
  await loadBookingsForClasses(allClasses.map((c) => c.id));
}

async function loadBookingsForClasses(classIds) {
  bookingsByClass = new Map();
  if (!classIds.length) return;

  const { data, error } = await supabase
    .from('class_bookings')
    .select(`
      id, class_id, status,
      client:profiles!class_bookings_client_id_fkey(full_name, phone)
    `)
    .in('class_id', classIds)
    .neq('status', 'cancelled');

  if (error) {
    console.warn('Bookings load:', error);
    return;
  }

  for (const row of data || []) {
    const key = idKey(row.class_id);
    if (!bookingsByClass.has(key)) bookingsByClass.set(key, []);
    bookingsByClass.get(key).push(row);
  }
}

function getBookingsForClass(classId) {
  return bookingsByClass.get(idKey(classId)) || [];
}

function initScheduleHandlers() {
  document.getElementById('scheduleClassList')?.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-toggle-participants]');
    if (!toggleBtn) return;

    const classKey = idKey(toggleBtn.getAttribute('data-toggle-participants'));
    if (expandedClassIds.has(classKey)) {
      expandedClassIds.delete(classKey);
    } else {
      expandedClassIds.add(classKey);
    }
    renderSchedule();
  });
}

function renderParticipantsPanel(cls, bookings) {
  if (!bookings.length) {
    return `
      <div class="trainer-participants-panel">
        <p class="cabinet-empty">Ще нікого не записано</p>
      </div>
    `;
  }

  return `
    <div class="trainer-participants-panel">
      <p class="trainer-participants-heading">Записані учасники (${bookings.length})</p>
      <ul class="trainer-participants-list">
        ${bookings.map((b) => {
          const name = b.client?.full_name || 'Клієнт';
          const phone = b.client?.phone || '';
          return `
            <li class="trainer-participant-item">
              <span class="trainer-participant-name">${escapeHtml(name)}</span>
              ${phone ? `<span class="trainer-participant-phone">${escapeHtml(phone)}</span>` : ''}
            </li>
          `;
        }).join('')}
      </ul>
    </div>
  `;
}

function renderSchedule() {
  const container = document.getElementById('scheduleClassList');
  const selectedDate = getSelectedDate();

  const dayClasses = allClasses
    .filter((cls) => isSameCalendarDay(new Date(cls.starts_at), selectedDate))
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  if (!dayClasses.length) {
    container.innerHTML = `
      <p class="cabinet-empty" style="padding: 24px 0;">
        На ${formatDateNumeric(selectedDate)} у вас немає занять.
      </p>
    `;
    return;
  }

  container.innerHTML = dayClasses.map((cls) => {
    const classKey = idKey(cls.id);
    const bookings = getBookingsForClass(cls.id);
    const booked = bookings.length;
    const isExpanded = expandedClassIds.has(classKey);
    const dir = cls.direction?.name || 'Заняття';
    const room = cls.room?.name || '—';
    const timeStr = `${formatTime(cls.starts_at)} – ${formatTime(cls.ends_at)}`;

    return `
      <article class="trainer-class-block">
        <div class="schedule-class-row trainer-class-row">
          <div class="schedule-class-name">${escapeHtml(dir)}</div>
          <div class="schedule-class-time">${timeStr}</div>
          <div class="schedule-class-trainer">${escapeHtml(room)}</div>
          <div class="schedule-class-spots">${booked} з ${cls.max_participants} записано</div>
          <div class="schedule-class-actions">
            <button
              type="button"
              class="btn-book btn-book-secondary trainer-toggle-btn"
              data-toggle-participants="${cls.id}"
              aria-expanded="${isExpanded ? 'true' : 'false'}"
            >${isExpanded ? 'Сховати' : 'Учасники'}</button>
          </div>
        </div>
        ${isExpanded ? renderParticipantsPanel(cls, bookings) : ''}
      </article>
    `;
  }).join('');
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
