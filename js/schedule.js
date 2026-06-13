// Модуль: schedule — розклад у CRM (календар, заняття, записи клієнтів)

import './modal-scroll-lock.js';
import { supabase } from './supabase.js';
import { requireAuth } from './auth.js';
import { restoreSubscriptionVisit } from './subscription-utils.js';
import {
  bookClientToClass,
  canCancelBooking,
  resolveBookingStatus,
  syncPastBookingsToAttended,
} from './booking-utils.js';

let calendar;
let allClasses = [];
let directions = [];
let trainers = [];
let rooms = [];
let currentClassId = null;
let currentProfile = null;
let bookingTargetClassId = null;
let bookingClientsCache = [];
let bookingBookedClientIds = new Set();
let selectedBookingClientId = null;
let detailClassId = null;
let detailBookingsCache = [];
let activeFilters = { directions: new Set(), trainers: new Set(), statuses: new Set() };

document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initClassModalHandlers();
  initDetailModalHandlers();
  initBookingClientModalHandlers();

  try {
    currentProfile = await requireAuth(['manager']);
    if (!currentProfile) return;

    await Promise.allSettled([
      loadDirections(),
      loadTrainers(),
      loadRooms(),
    ]);

    initCalendar();
    initFilterPanel();
    initCopyWeek();
    localStorage.removeItem('harmonyfit_demo_class');
    localStorage.removeItem('harmonyfit_demo_hidden');
  } catch (err) {
    console.error('Schedule init error:', err);
  }
});

function getClassBookedCount(cls) {
  return cls.booked_count ?? 0;
}

function findClassById(classId) {
  const id = String(classId);
  return allClasses.find(c => String(c.id) === id);
}

const FALLBACK_PALETTE = { bg: '#EEF0FE', text: '#5B6AF0' };

const ICON_USERS = `<svg class="fc-class-card__icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const ICON_TRAINER = `<svg class="fc-class-card__icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

function normalizeHex(color) {
  if (!color) return null;
  let c = String(color).trim();
  if (!c.startsWith('#')) c = `#${c}`;
  if (/^#[0-9A-Fa-f]{3}$/.test(c)) {
    c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  return /^#[0-9A-Fa-f]{6}$/.test(c) ? c.toUpperCase() : null;
}

/** Кольори картки з поля directions.color у БД */
function getDirectionPalette(cls) {
  const hex = normalizeHex(cls.direction?.color);
  if (!hex) return FALLBACK_PALETTE;
  return { bg: `${hex}33`, text: hex };
}

function getClassDirectionId(cls) {
  return String(cls.direction_id || cls.direction?.id || '');
}

function getClassTrainerId(cls) {
  return String(cls.trainer_id || cls.trainer?.id || '');
}

function classMatchesFilters(cls) {
  const displayKey = getClassDisplayStatus(cls).key;

  const dirId = getClassDirectionId(cls);
  if (activeFilters.directions.size > 0) {
    const match = [...activeFilters.directions].some(id => String(id) === dirId);
    if (!match) return false;
  }
  const trainerId = getClassTrainerId(cls);
  if (activeFilters.trainers.size > 0) {
    const match = [...activeFilters.trainers].some(id => String(id) === trainerId);
    if (!match) return false;
  }
  if (activeFilters.statuses.size > 0) {
    if (!activeFilters.statuses.has(displayKey)) return false;
  } else if (displayKey === 'completed') {
    return false;
  }
  return true;
}

/** Заплановано | Завершено | Скасовано */
function getClassDisplayStatus(cls) {
  if (cls.status === 'cancelled') {
    return { key: 'cancelled', label: 'Скасовано' };
  }
  if (cls.status === 'completed') {
    return { key: 'completed', label: 'Завершено' };
  }
  if (new Date(cls.ends_at) < new Date()) {
    return { key: 'completed', label: 'Завершено' };
  }
  return { key: 'scheduled', label: 'Заплановано' };
}

function resolveStatusForForm(cls) {
  return getClassDisplayStatus(cls).key;
}

function statusBadgeHtml(cls) {
  const { key, label } = getClassDisplayStatus(cls);
  const badgeClass = { scheduled: 'badge-scheduled', completed: 'badge-completed', cancelled: 'badge-cancelled' }[key] || 'badge-scheduled';
  return `<span class="badge ${badgeClass}">${label}</span>`;
}

function formatTimeRange(startIso, endIso) {
  return `${toLocalTimeInput(new Date(startIso))} – ${toLocalTimeInput(new Date(endIso))}`;
}

function renderEventCardHtml(cls) {
  const palette = getDirectionPalette(cls);
  const display = getClassDisplayStatus(cls);
  const booked = getClassBookedCount(cls);
  const title = cls.direction?.name || 'Заняття';
  const timeRange = formatTimeRange(cls.starts_at, cls.ends_at);
  const trainer = cls.trainer?.full_name || '';
  const statusIcon = display.key === 'cancelled'
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>'
    : display.key === 'completed'
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';

  const participantsRow = `<div class="fc-class-card__meta-row">
    <span class="fc-class-card__icon" title="Учасники">${ICON_USERS}</span>
    <span class="fc-class-card__meta-text">${booked}/${cls.max_participants}</span>
  </div>`;
  const trainerRow = trainer
    ? `<div class="fc-class-card__meta-row">
        <span class="fc-class-card__icon" title="Тренер">${ICON_TRAINER}</span>
        <span class="fc-class-card__meta-text">${escapeHtml(trainer)}</span>
      </div>`
    : '';

  return `<div class="fc-class-card" style="--card-bg:${palette.bg};--card-text:${palette.text}">
    <div class="fc-class-card__body">
      <div class="fc-class-card__title">${escapeHtml(title)}</div>
      <div class="fc-class-card__time">${escapeHtml(timeRange)}</div>
      ${participantsRow}
      ${trainerRow}
    </div>
    <div class="fc-class-card__footer">
      <span class="fc-class-status-pill fc-class-status-pill--${display.key}">
        <span class="fc-class-status-pill__icon">${statusIcon}</span>
        ${escapeHtml(display.label)}
      </span>
    </div>
  </div>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tableEmptyRow(colspan, title) {
  return `<tr><td colspan="${colspan}"><div class="empty-state">
    <p class="empty-state-title">${escapeHtml(title)}</p>
  </div></td></tr>`;
}

function resolveClassRelations(payload) {
  const direction = directions.find(d => d.id === payload.direction_id);
  const trainer = trainers.find(t => t.id === payload.trainer_id);
  const room = rooms.find(r => r.id === payload.room_id);
  return {
    ...payload,
    direction: direction ? { id: direction.id, name: direction.name, color: direction.color } : null,
    trainer: trainer ? { id: trainer.id, full_name: trainer.full_name } : null,
    room: room ? { id: room.id, name: room.name, capacity: room.capacity } : null,
  };
}

// ── Завантаження даних ─────────────────────────
async function loadDirections() {
  const { data } = await supabase.from('directions').select('*').order('name');
  directions = data || [];
  populateSelect('classDirection', directions, 'id', 'name');
}

async function loadTrainers() {
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'trainer')
    .order('full_name');
  trainers = data || [];
  populateTrainerSelect();
}

async function loadRooms() {
  const { data } = await supabase.from('rooms').select('*').order('name');
  rooms = data || [];
  populateSelect('classRoom', rooms, 'id', 'name');
}

async function loadClasses(start, end) {
  const { data, error } = await supabase
    .from('classes')
    .select(`
      *,
      direction:directions(id, name, color),
      trainer:profiles!classes_trainer_id_fkey(id, full_name),
      room:rooms(id, name)
    `)
    .gte('starts_at', start.toISOString())
    .lte('starts_at', end.toISOString());

  if (error) console.warn('Schedule API:', error);
  allClasses = await attachBookedCounts(data || []);
  return allClasses;
}

/** Підрахунок записів для всіх занять діапазону (один запит) */
async function attachBookedCounts(classes) {
  if (!classes.length) return [];

  const ids = classes.map(c => c.id);
  const { data, error } = await supabase
    .from('class_bookings')
    .select('class_id')
    .in('class_id', ids)
    .neq('status', 'cancelled');

  if (error) {
    console.warn('Booked counts:', error);
    return classes.map(c => ({ ...c, booked_count: 0 }));
  }

  const counts = {};
  for (const row of data || []) {
    counts[row.class_id] = (counts[row.class_id] ?? 0) + 1;
  }

  return classes.map(c => ({ ...c, booked_count: counts[c.id] ?? 0 }));
}

async function refreshClassBookedCount(classId) {
  const count = await fetchBookedCount(classId);
  const cls = findClassById(classId);
  if (cls) cls.booked_count = count;

  const participantsEl = document.getElementById('detailParticipantsValue');
  if (cls && participantsEl) {
    participantsEl.textContent = `${count} / ${cls.max_participants}`;
  }
  return count;
}

async function fetchBookedCount(classId) {
  const { count } = await supabase
    .from('class_bookings')
    .select('id', { count: 'exact', head: true })
    .eq('class_id', classId)
    .neq('status', 'cancelled');
  return count ?? 0;
}

// ── Календар FullCalendar ──────────────────────
function initCalendar() {
  const el = document.getElementById('calendar');
  if (!el || typeof FullCalendar === 'undefined') {
    console.warn('FullCalendar недоступний');
    return;
  }
  calendar = new FullCalendar.Calendar(el, {
    locale: 'uk',
    firstDay: 1,
    initialView: 'timeGridWeek',
    customButtons: {
      filterBtn: {
        text: 'Фільтри',
        click(e) { toggleFilterPanel(e.currentTarget); },
      },
    },
    headerToolbar: {
      left:   'prev next today',
      center: 'title',
      right:  'filterBtn timeGridWeek timeGridDay',
    },
    slotMinTime: '07:00:00',
    slotMaxTime: '22:00:00',
    allDaySlot: false,
    height: 'auto',
    slotEventOverlap: false,
    eventMinHeight: 118,
    eventClick({ event }) {
      const raw = event.extendedProps.classData;
      if (!raw) return;
      openClassDetail(findClassById(raw.id) || raw);
    },
    eventContent(arg) {
      const cls = arg.event.extendedProps.classData;
      if (!cls) return true;
      return { html: renderEventCardHtml(cls) };
    },
    datesSet: async ({ start, end }) => {
      await loadClasses(start, end);
      reapplyCalendarFilters();
    },
  });
  calendar.render();
  initCalendarDatepicker();
}

// ── Фільтри (календар і список) ────────────────
function applyCalendarFilters(classes) {
  return classes.filter(classMatchesFilters);
}

const LIST_LOAD_PAST_DAYS = 30;
const LIST_LOAD_FUTURE_DAYS = 120;
let listClassesRangeKey = '';

async function ensureListClassesLoaded() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - LIST_LOAD_PAST_DAYS);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  end.setDate(end.getDate() + LIST_LOAD_FUTURE_DAYS);
  const key = `${start.toISOString()}|${end.toISOString()}`;
  if (listClassesRangeKey === key && allClasses.length) return;
  await loadClasses(start, end);
  listClassesRangeKey = key;
}

function reapplyCalendarFilters() {
  if (!calendar?.view) return;
  calendar.removeAllEvents();
  calendar.addEventSource(applyCalendarFilters(allClasses).map(classToEvent));
}

function initFilterPanel() {
  const dirContainer     = document.getElementById('calFilterDirections');
  const trainerContainer = document.getElementById('calFilterTrainers');
  if (!dirContainer || !trainerContainer) return;

  dirContainer.innerHTML = directions.map(d => `
    <label class="cal-filter-option">
      <input type="checkbox" data-filter="direction" value="${d.id}">
      <span class="cal-filter-dot" style="background:${d.color || '#9CA3AF'};"></span>
      ${escapeHtml(d.name)}
    </label>`).join('');

  trainerContainer.innerHTML = trainers.map(t => `
    <label class="cal-filter-option">
      <input type="checkbox" data-filter="trainer" value="${t.id}">
      ${escapeHtml(t.full_name)}
    </label>`).join('');

  const panel = document.getElementById('calFilterPanel');
  if (!panel) return;

  panel.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const map = { direction: activeFilters.directions, trainer: activeFilters.trainers, status: activeFilters.statuses };
    const set = map[cb.dataset.filter];
    if (!set) return;
    if (cb.checked) set.add(cb.value); else set.delete(cb.value);
    updateFilterBadge();
    reapplyCalendarFilters();
    renderListView();
  });

  document.getElementById('calFilterReset')?.addEventListener('click', () => {
    activeFilters = { directions: new Set(), trainers: new Set(), statuses: new Set() };
    panel.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    updateFilterBadge();
    reapplyCalendarFilters();
    renderListView();
  });

  document.getElementById('listFilterBtn')?.addEventListener('click', function () {
    toggleFilterPanel(this);
  });

  document.getElementById('listSearch')?.addEventListener('input', renderListView);

  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') &&
        !panel.contains(e.target) &&
        !e.target.closest('#listFilterBtn') &&
        !e.target.closest('.fc-filterBtn-button')) {
      panel.classList.add('hidden');
    }
  });
}

function toggleFilterPanel(triggerBtn) {
  const panel = document.getElementById('calFilterPanel');
  if (!panel) return;
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  const btn = triggerBtn || document.getElementById('listFilterBtn');
  if (btn) {
    const rect = btn.getBoundingClientRect();
    panel.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
    panel.style.left = (rect.right  + window.scrollX - 264) + 'px';
  }
  panel.classList.remove('hidden');
}

function updateFilterBadge() {
  const total = activeFilters.directions.size + activeFilters.trainers.size + activeFilters.statuses.size;
  ['#listFilterBtn', '.fc-filterBtn-button'].forEach(sel => {
    const btn = document.querySelector(sel);
    if (!btn) return;
    const existing = btn.querySelector('.fc-filter-badge');
    if (total > 0) {
      if (existing) { existing.textContent = total; }
      else {
        const badge = document.createElement('span');
        badge.className = 'fc-filter-badge';
        badge.textContent = total;
        btn.appendChild(badge);
      }
      btn.classList.add('has-filters');
    } else {
      existing?.remove();
      btn.classList.remove('has-filters');
    }
  });
}

// ── Вибір дати в заголовку календаря ───────────
function initCalendarDatepicker() {
  requestAnimationFrame(() => {
    const proxyEl = document.getElementById('calDatepickerProxy');
    if (!proxyEl || typeof Datepicker === 'undefined') return;

    const dp = new Datepicker(proxyEl, {
      language: 'uk',
      autohide: true,
      weekStart: 1,
      format: 'dd.mm.yyyy',
      todayBtn: true,
      todayBtnMode: 1,
      clearBtn: false,
    });

    proxyEl.addEventListener('changeDate', () => {
      const date = dp.getDate();
      if (date && calendar) {
        calendar.gotoDate(date);
      }
    });

    const titleEl = document.querySelector('.fc-toolbar-title');
    if (!titleEl) return;

    titleEl.classList.add('fc-toolbar-title--clickable');
    titleEl.title = 'Перейти до дати';

    titleEl.addEventListener('click', () => {
      const rect = titleEl.getBoundingClientRect();
      proxyEl.style.position = 'absolute';
      proxyEl.style.top    = (rect.bottom + window.scrollY) + 'px';
      proxyEl.style.left   = (rect.left   + window.scrollX) + 'px';
      proxyEl.style.width  = Math.max(rect.width, 160) + 'px';
      proxyEl.style.height = '1px';
      proxyEl.style.pointerEvents = 'none';

      const current = calendar?.getDate?.() || new Date();
      dp.setDate(current, { render: false });
      dp.show();
    });
  });
}

function classToEvent(cls) {
  const palette = getDirectionPalette(cls);
  const display = getClassDisplayStatus(cls);
  return {
    id: cls.id,
    title: cls.direction?.name || 'Заняття',
    start: cls.starts_at,
    end: cls.ends_at,
    backgroundColor: palette.bg,
    borderColor: 'transparent',
    textColor: palette.text,
    classNames: ['fc-class-event', `fc-class-event--${display.key}`],
    extendedProps: { classData: cls },
  };
}

// ── Вкладки тиждень / список ───────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('tab-week').classList.toggle('hidden', tab !== 'week');
      document.getElementById('tab-list').classList.toggle('hidden', tab !== 'list');
      if (tab === 'list') {
        ensureListClassesLoaded().then(renderListView);
      }
    });
  });
}

// ── Список занять ──────────────────────────────
async function renderListView() {
  const tbody = document.getElementById('classListBody');
  if (!tbody) return;

  if (document.querySelector('.tab-btn.active')?.dataset.tab === 'list') {
    await ensureListClassesLoaded();
  }

  let filtered = applyCalendarFilters([...allClasses]);

  const q = (document.getElementById('listSearch')?.value || '').toLowerCase();
  if (q) {
    filtered = filtered.filter(c =>
      c.direction?.name?.toLowerCase().includes(q) ||
      c.trainer?.full_name?.toLowerCase().includes(q)
    );
  }

  if (!filtered.length) {
    tbody.innerHTML = tableEmptyRow(8, 'Занять не знайдено');
    return;
  }

  filtered.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  tbody.innerHTML = filtered.map(cls => {
    const dt = new Date(cls.starts_at);
    const dateStr = dt.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = dt.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    const endStr  = new Date(cls.ends_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    const booked = getClassBookedCount(cls);
    const badge = statusBadgeHtml(cls);

    return `<tr onclick="openClassDetail('${cls.id}')">
      <td>
        <span class="direction-tag" style="background:${cls.direction?.color || '#EEF0FE'}20;color:${cls.direction?.color || '#5B6AF0'}">
          ${cls.direction?.name || '—'}
        </span>
      </td>
      <td class="td-muted">${dateStr}</td>
      <td class="td-muted">${timeStr} – ${endStr}</td>
      <td>${cls.trainer?.full_name || '—'}</td>
      <td>${cls.room?.name || '—'}</td>
      <td class="td-muted">${booked}/${cls.max_participants}</td>
      <td>${badge}</td>
      <td>
        <div class="table-actions">
          <button class="btn btn-ghost btn-icon btn-sm" title="Редагувати" onclick="event.stopPropagation();openEditClass('${cls.id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Модалка: створення / редагування заняття ───
function initClassModalHandlers() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('#addClassBtn')) {
      e.preventDefault();
      openClassModal();
      return;
    }
    if (e.target.closest('#classModalClose, #classModalCancel')) {
      e.preventDefault();
      closeClassModal();
      return;
    }
    if (e.target.id === 'classModal') {
      closeClassModal();
    }
  });

  document.getElementById('classForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    saveClass();
  });
  document.getElementById('classModalDelete')?.addEventListener('click', deleteClass);

  document.getElementById('classRoom')?.addEventListener('change', updateRoomCapacityHint);
}


async function openClassModal(cls = null) {
  const modal = document.getElementById('classModal');
  if (!modal) return;

  currentClassId = cls?.id || null;
  const form = document.getElementById('classForm');
  form?.reset();

  const isEdit = Boolean(cls);
  const footer = document.getElementById('classModalFooter');
  footer?.classList.toggle('modal-footer--edit', isEdit);
  footer?.classList.toggle('modal-footer--start', !isEdit);

  document.getElementById('classModalTitle').textContent = isEdit ? 'Редагувати заняття' : 'Нове заняття';
  document.getElementById('classId').value = cls?.id || '';
  document.getElementById('classDirection').value = cls?.direction_id || '';
  populateTrainerSelect();
  document.getElementById('classTrainer').value = cls?.trainer_id || '';
  document.getElementById('classRoom').value = cls?.room_id || '';
  document.getElementById('classMax').value = cls?.max_participants ?? '';
  document.getElementById('classStatus').value = cls ? resolveStatusForForm(cls) : 'scheduled';
  document.getElementById('classModalDelete').style.display = isEdit ? '' : 'none';

  const statusField = document.getElementById('classStatus')?.closest('.form-group');
  if (statusField) statusField.hidden = !isEdit;

  if (cls) {
    const d = new Date(cls.starts_at);
    document.getElementById('classDate').value  = toLocalDateInput(d);
    document.getElementById('classStart').value = toLocalTimeInput(d);
    document.getElementById('classEnd').value   = toLocalTimeInput(new Date(cls.ends_at));
  } else {
    const anchor = calendar?.getDate?.() || new Date();
    document.getElementById('classDate').value  = toLocalDateInput(anchor);
    document.getElementById('classStart').value = '';
    document.getElementById('classEnd').value   = '';
  }

  updateRoomCapacityHint();

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('classDirection')?.focus();
}

function closeClassModal() {
  const modal = document.getElementById('classModal');
  if (!modal) return;
  currentClassId = null;
  document.getElementById('classForm')?.reset();
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

/** Усі тренери — без прив'язки до напрямку (для заміни тощо) */
function populateTrainerSelect() {
  const current = document.getElementById('classTrainer')?.value;
  populateSelect('classTrainer', trainers, 'id', 'full_name');
  if (current && trainers.some(t => t.id === current)) {
    document.getElementById('classTrainer').value = current;
  }
}

function updateRoomCapacityHint() {
  const hint = document.getElementById('classRoomCapacityHint');
  const roomId = document.getElementById('classRoom')?.value;
  const room = rooms.find(r => r.id === roomId);
  if (!hint) return;
  if (room?.capacity) {
    hint.textContent = `Місткість залу: ${room.capacity} осіб`;
    hint.hidden = false;
    const maxEl = document.getElementById('classMax');
    if (maxEl && !maxEl.value) maxEl.placeholder = String(room.capacity);
  } else {
    hint.hidden = true;
    hint.textContent = '';
  }
}

window.openEditClass = function(id) {
  const cls = findClassById(id);
  if (cls) openClassModal(cls);
};

/** Зберігає нове або оновлене заняття з перевіркою конфлікту слотів. */
async function saveClass() {
  const id          = document.getElementById('classId').value;
  const directionId = document.getElementById('classDirection').value;
  const trainerId   = document.getElementById('classTrainer').value;
  const roomId      = document.getElementById('classRoom').value;
  const date        = document.getElementById('classDate').value;
  const startTime   = document.getElementById('classStart').value;
  const endTime     = document.getElementById('classEnd').value;
  const maxRaw      = document.getElementById('classMax').value;
  const maxParticipants = parseInt(maxRaw, 10);

  const required = [
    { ok: directionId, msg: 'Оберіть напрямок', el: 'classDirection' },
    { ok: date,        msg: 'Вкажіть дату заняття', el: 'classDate' },
    { ok: startTime,   msg: 'Вкажіть час початку', el: 'classStart' },
    { ok: endTime,     msg: 'Вкажіть час закінчення', el: 'classEnd' },
    { ok: trainerId,  msg: 'Оберіть тренера', el: 'classTrainer' },
    { ok: roomId,      msg: 'Оберіть зал', el: 'classRoom' },
    { ok: maxRaw,      msg: 'Вкажіть максимальну кількість учасників', el: 'classMax' },
  ];
  const missing = required.find((f) => !f.ok);
  if (missing) {
    showToast(missing.msg, 'error');
    document.getElementById(missing.el)?.focus();
    return;
  }
  if (!Number.isFinite(maxParticipants) || maxParticipants < 1) {
    showToast('Вкажіть коректну кількість учасників', 'error');
    return;
  }
  if (startTime >= endTime) {
    showToast('Час закінчення має бути пізніше за початок', 'error');
    return;
  }

  const room = rooms.find(r => r.id === roomId);
  if (room?.capacity && maxParticipants > room.capacity) {
    showToast(`У залі максимум ${room.capacity} місць`, 'error');
    return;
  }

  const status = document.getElementById('classStatus').value || 'scheduled';

  const startsAt = localInputsToISO(date, startTime);
  const endsAt   = localInputsToISO(date, endTime);

  const conflict = await findSlotConflict(trainerId, roomId, startsAt, id || null);
  if (conflict === 'trainer') {
    showToast('Тренер уже має заняття на цей час', 'error');
    return;
  }
  if (conflict === 'room') {
    showToast('Зал уже зайнятий на цей час', 'error');
    return;
  }
  if (conflict?.error) {
    showToast('Помилка перевірки розкладу', 'error');
    return;
  }

  const payload = {
    direction_id: directionId,
    trainer_id: trainerId,
    room_id: roomId,
    max_participants: maxParticipants,
    starts_at: startsAt,
    ends_at: endsAt,
    status,
  };

  const { error } = id
    ? await supabase.from('classes').update(payload).eq('id', id)
    : await supabase.from('classes').insert(payload);

  if (error) {
    if (isUniqueViolation(error)) {
      showToast(uniqueViolationMessage(error), 'error');
      return;
    }
    showToast('Помилка збереження', 'error');
    return;
  }

  closeClassModal();
  showToast(id ? 'Заняття оновлено' : 'Заняття створено', 'success');
  await refreshCalendar();
}

async function deleteClass() {
  if (!currentClassId) return;
  if (!confirm('Видалити це заняття?')) return;

  const { error } = await supabase.from('classes').delete().eq('id', currentClassId);
  if (error) { showToast('Помилка видалення', 'error'); return; }

  closeClassModal();
  showToast('Заняття видалено', 'success');
  await refreshCalendar();
}

// ── Модалка деталей заняття та записів ────────
window.openClassDetail = async function(clsOrId) {
  const cls = typeof clsOrId === 'object' && clsOrId !== null
    ? clsOrId
    : findClassById(clsOrId);
  if (!cls) return;

  detailClassId = cls.id;

  document.getElementById('detailTitle').textContent =
    `${cls.direction?.name || 'Заняття'} — ${new Date(cls.starts_at).toLocaleDateString('uk-UA')}`;

  const dt = new Date(cls.starts_at);
  const te = new Date(cls.ends_at);
  const booked = cls.booked_count ?? await fetchBookedCount(cls.id);

  document.getElementById('detailMeta').innerHTML = `
    <div class="detail-meta-grid">
      <div class="detail-meta-item">
        <span class="detail-meta-label">Напрямок</span>
        <span class="detail-meta-value">${cls.direction?.name || '—'}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">Статус</span>
        <span class="detail-meta-value">${statusBadgeHtml(cls)}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">Дата</span>
        <span class="detail-meta-value">${dt.toLocaleDateString('uk-UA', {weekday:'long', day:'numeric', month:'long'})}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">Час</span>
        <span class="detail-meta-value">${dt.toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'})} – ${te.toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'})}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">Тренер</span>
        <span class="detail-meta-value">${cls.trainer?.full_name || '—'}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">Учасники</span>
        <span class="detail-meta-value" id="detailParticipantsValue">${booked} / ${cls.max_participants}</span>
      </div>
      <div class="detail-meta-item">
        <span class="detail-meta-label">Зал</span>
        <span class="detail-meta-value">${cls.room?.name || '—'}</span>
      </div>
    </div>`;

  document.getElementById('detailEditBtn').onclick = () => {
    closeDetailModal();
    openClassModal(cls);
  };

  document.getElementById('detailCancelBtn').onclick = () => cancelClass(cls.id);
  document.getElementById('addBookingBtn').onclick   = () => openBookingClientModal(cls.id);

  loadBookings(cls.id);
  document.getElementById('classDetailModal').classList.remove('hidden');
};

function closeDetailModal() {
  detailClassId = null;
  detailBookingsCache = [];
  document.getElementById('classDetailModal').classList.add('hidden');
}

function initDetailModalHandlers() {
  document.getElementById('detailModalClose')?.addEventListener('click', closeDetailModal);
  document.getElementById('classDetailModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('classDetailModal')) closeDetailModal();
  });
}

function bumpDetailParticipantsCount(delta) {
  const el = document.getElementById('detailParticipantsValue');
  const cls = detailClassId ? findClassById(detailClassId) : null;
  if (!el || !cls) return;

  const match = el.textContent.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return;

  const next = Math.max(0, parseInt(match[1], 10) + delta);
  el.textContent = `${next} / ${cls.max_participants}`;
  cls.booked_count = next;
}

async function removeBookingFromList(bookingId) {
  if (!detailClassId || !bookingId) return;

  const classId = detailClassId;
  const bookingKey = String(bookingId);
  const booking = detailBookingsCache.find(b => String(b.id) === bookingKey);
  if (!booking) return;

  if (!canCancelBooking(booking)) {
    showToast('Неможливо скасувати відвідане або минуле заняття', 'error');
    return;
  }

  booking.status = 'cancelled';
  renderBookingsList(classId);
  bumpDetailParticipantsCount(-1);

  const ok = await cancelClientBooking(bookingId, classId, { silent: true });
  if (!ok) {
    await loadBookings(classId);
    await refreshClassBookedCount(classId);
    showToast('Помилка скасування', 'error');
    return;
  }

  showToast('Запис скасовано', 'success');
  await refreshClassBookedCount(classId);
  reapplyCalendarFilters();
  if (document.querySelector('.tab-btn.active')?.dataset.tab === 'list') {
    renderListView();
  }
}

function initBookingClientModalHandlers() {
  const modal = document.getElementById('bookingClientModal');
  const search = document.getElementById('bookingClientSearch');
  if (!modal) return;

  const close = () => closeBookingClientModal();
  document.getElementById('bookingClientModalClose')?.addEventListener('click', close);
  document.getElementById('bookingClientModalCancel')?.addEventListener('click', close);
  modal.addEventListener('click', e => {
    if (e.target === modal) close();
  });

  search?.addEventListener('input', () => {
    renderBookingClientList(
      bookingClientsCache,
      search.value,
      bookingBookedClientIds,
      selectedBookingClientId
    );
  });

  document.getElementById('bookingClientList')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.booking-client-item');
    if (!btn?.dataset.clientId) return;
    selectedBookingClientId = btn.dataset.clientId;
    updateBookingClientSaveButton();
    renderBookingClientList(
      bookingClientsCache,
      document.getElementById('bookingClientSearch')?.value || '',
      bookingBookedClientIds,
      selectedBookingClientId
    );
  });

  document.getElementById('bookingClientModalSave')?.addEventListener('click', async () => {
    if (!selectedBookingClientId) {
      showToast('Оберіть клієнта зі списку', 'error');
      return;
    }
    const ok = await submitBookingClient(selectedBookingClientId);
    if (ok) closeBookingClientModal();
  });
}

function updateBookingClientSaveButton() {
  const btn = document.getElementById('bookingClientModalSave');
  if (btn) btn.disabled = !selectedBookingClientId;
}

function closeBookingClientModal() {
  const modal = document.getElementById('bookingClientModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  bookingTargetClassId = null;
  selectedBookingClientId = null;
  updateBookingClientSaveButton();
}

function renderBookingClientList(clients, query = '', bookedIds = new Set(), selectedId = null) {
  const listEl = document.getElementById('bookingClientList');
  if (!listEl) return;

  const q = query.trim().toLowerCase();
  const filtered = clients.filter(c => {
    if (bookedIds.has(String(c.id))) return false;
    if (!q) return true;
    const phone = (c.phone || '').replace(/\s/g, '');
    const qPhone = q.replace(/\s/g, '');
    return (
      c.full_name?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q) ||
      phone.includes(qPhone)
    );
  });

  if (!filtered.length) {
    listEl.innerHTML = `<p class="booking-client-empty">${
      q ? 'Клієнтів не знайдено' : 'Немає доступних клієнтів для запису'
    }</p>`;
    return;
  }

  listEl.innerHTML = filtered.map(c => {
    const meta = [c.phone, c.email].filter(Boolean).join(' · ') || '—';
    const selected = selectedId === c.id ? ' is-selected' : '';
    return `<button type="button" class="booking-client-item${selected}" data-client-id="${c.id}" role="option" aria-selected="${selectedId === c.id ? 'true' : 'false'}">
      <div class="booking-client-info">
        <span class="booking-client-name">${escapeHtml(c.full_name || '—')}</span>
        <span class="booking-client-meta">${escapeHtml(meta)}</span>
      </div>
    </button>`;
  }).join('');
}

async function fetchBookedClientIds(classId) {
  const { data } = await supabase
    .from('class_bookings')
    .select('client_id')
    .eq('class_id', classId)
    .neq('status', 'cancelled');
  return new Set((data || []).map(b => String(b.client_id)));
}

async function openBookingClientModal(classId) {
  const modal = document.getElementById('bookingClientModal');
  const search = document.getElementById('bookingClientSearch');
  const listEl = document.getElementById('bookingClientList');
  if (!modal || !listEl) return;

  bookingTargetClassId = classId;
  selectedBookingClientId = null;
  updateBookingClientSaveButton();
  listEl.innerHTML = '<p class="booking-client-empty">Завантаження...</p>';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  if (search) {
    search.value = '';
    search.focus();
  }

  const [{ data: clients, error }, bookedIds] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, full_name, email, phone')
      .eq('role', 'client')
      .order('full_name'),
    fetchBookedClientIds(classId),
  ]);

  if (error) {
    showToast('Помилка завантаження клієнтів', 'error');
    closeBookingClientModal();
    return;
  }

  bookingClientsCache = clients || [];
  bookingBookedClientIds = bookedIds;
  renderBookingClientList(bookingClientsCache, search?.value || '', bookingBookedClientIds, selectedBookingClientId);
}

async function submitBookingClient(clientId) {
  const classId = bookingTargetClassId;
  if (!classId) return false;

  const cls = findClassById(classId);
  if (cls) {
    const booked = await refreshClassBookedCount(classId);
    if (booked >= cls.max_participants) {
      showToast('Досягнуто максимум учасників', 'error');
      return false;
    }
  }

  const client = bookingClientsCache.find(c => c.id === clientId);
  const result = await bookClientToClass(clientId, classId);

  if (!result.ok) {
    if (result.reason === 'charge_failed') {
      showToast(result.message, 'error');
    } else if (result.reason === 'already_booked' || result.reason === 'duplicate') {
      showToast('Клієнт уже записаний на це заняття', 'error');
    } else {
      showToast('Помилка запису', 'error');
    }
    return false;
  }

  showToast(`${client?.full_name || 'Клієнт'} записаний`, 'success');
  loadBookings(classId);

  await refreshClassBookedCount(classId);
  reapplyCalendarFilters();
  if (document.querySelector('.tab-btn.active')?.dataset.tab === 'list') {
    renderListView();
  }
  return true;
}

async function loadBookings(classId) {
  const container = document.getElementById('bookingsList');
  if (!container) return;

  const cls = findClassById(classId);
  const { data } = await supabase
    .from('class_bookings')
    .select('id, status, client:profiles!class_bookings_client_id_fkey(id, full_name)')
    .eq('class_id', classId);

  if (!data || !data.length) {
    detailBookingsCache = [];
    container.innerHTML = '<p style="text-align:center;color:var(--text-muted);font-size:var(--font-size-sm);padding:16px 0;">Ще нікого не записано</p>';
    return;
  }

  const bookings = data.map(b => ({
    ...b,
    class: { starts_at: cls?.starts_at, ends_at: cls?.ends_at },
  }));
  detailBookingsCache = await syncPastBookingsToAttended(bookings);
  renderBookingsList(classId);
}

function renderBookingsList(classId) {
  const container = document.getElementById('bookingsList');
  if (!container) return;

  if (!detailBookingsCache.length) {
    container.innerHTML = '<p style="text-align:center;color:var(--text-muted);font-size:var(--font-size-sm);padding:16px 0;">Ще нікого не записано</p>';
    return;
  }

  container.innerHTML = detailBookingsCache.map(b => {
    const st = resolveBookingStatus(b);
    const badgeHtml = st === 'cancelled'
      ? '<span class="badge badge-cancelled">Скасовано</span>'
      : st === 'attended'
      ? '<span class="badge badge-attended">Відвідав</span>'
      : '<span class="badge badge-scheduled">Записаний</span>';
    const cancelBtn = canCancelBooking(b)
      ? `<span class="booking-action"><button type="button" class="btn-icon-cancel" data-cancel-booking="${b.id}" title="Скасувати запис" aria-label="Скасувати запис">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button></span>`
      : '<span class="booking-action" aria-hidden="true"></span>';
    return `
    <div class="booking-row">
      <span class="booking-name">${escapeHtml(b.client?.full_name || '—')}</span>
      <span class="booking-status">${badgeHtml}</span>
      ${cancelBtn}
    </div>`;
  }).join('');

  container.querySelectorAll('[data-cancel-booking]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      removeBookingFromList(btn.getAttribute('data-cancel-booking'));
    });
  });
}

async function cancelClientBooking(bookingId, classId, options = {}) {
  const { silent = false } = options;
  const cls = findClassById(classId);
  const { data: booking, error: fetchErr } = await supabase
    .from('class_bookings')
    .select('id, client_id, status')
    .eq('id', bookingId)
    .maybeSingle();

  if (fetchErr || !booking) {
    if (!silent) showToast('Помилка скасування', 'error');
    return false;
  }
  if (booking.status === 'cancelled') return true;

  const bookingCtx = {
    ...booking,
    class: { starts_at: cls?.starts_at, ends_at: cls?.ends_at },
  };
  if (!canCancelBooking(bookingCtx)) {
    if (!silent) showToast('Неможливо скасувати відвідане або минуле заняття', 'error');
    return false;
  }

  const { error } = await supabase
    .from('class_bookings')
    .update({ status: 'cancelled' })
    .eq('id', bookingId);

  if (error) {
    if (!silent) showToast('Помилка скасування', 'error');
    return false;
  }

  const restored = await restoreSubscriptionVisit(booking.client_id);
  if (!restored.ok && !silent) {
    showToast(restored.message || 'Запис скасовано, але заняття не повернулось на абонемент', 'error');
  } else if (!silent) {
    showToast('Запис скасовано', 'success');
  }

  if (!silent) {
    loadBookings(classId);
    await refreshClassBookedCount(classId);
    reapplyCalendarFilters();
    if (document.querySelector('.tab-btn.active')?.dataset.tab === 'list') {
      renderListView();
    }
  }
  return true;
}

async function cancelClass(classId) {
  if (!confirm('Скасувати це заняття?')) return;

  const { data: activeBookings } = await supabase
    .from('class_bookings')
    .select('id, client_id')
    .eq('class_id', classId)
    .eq('status', 'booked');

  const { error } = await supabase.from('classes').update({ status: 'cancelled' }).eq('id', classId);
  if (error) { showToast('Помилка', 'error'); return; }

  if (activeBookings?.length) {
    const { error: bookingsError } = await supabase
      .from('class_bookings')
      .update({ status: 'cancelled' })
      .eq('class_id', classId)
      .eq('status', 'booked');

    if (bookingsError) {
      showToast('Заняття скасовано, але не вдалося оновити записи клієнтів', 'error');
    } else {
      for (const b of activeBookings) {
        await restoreSubscriptionVisit(b.client_id);
      }
    }
  }

  closeDetailModal();
  showToast('Заняття скасовано', 'success');
  await refreshCalendar();
}

// ── Копіювання тижня розкладу ──────────────────
function initCopyWeek() {
  document.getElementById('copyWeekBtn')?.addEventListener('click', async () => {
    const view   = calendar.view;
    const start  = view.activeStart;
    const end    = view.activeEnd;

    const { data: classes, error } = await supabase
      .from('classes')
      .select('direction_id, trainer_id, room_id, max_participants, starts_at, ends_at')
      .gte('starts_at', start.toISOString())
      .lt('starts_at', end.toISOString())
      .eq('status', 'scheduled');

    if (error || !classes?.length) {
      showToast('Немає занять для копіювання', 'error');
      return;
    }

    const nextStart = addDays(start.toISOString(), 7);
    const nextEnd   = addDays(end.toISOString(), 7);

    const { data: existing, error: existingError } = await supabase
      .from('classes')
      .select('trainer_id, room_id, starts_at')
      .gte('starts_at', nextStart)
      .lt('starts_at', nextEnd);

    if (existingError) { showToast('Помилка перевірки розкладу', 'error'); return; }

    const existingTrainerKeys = new Set(
      (existing || []).map(c => slotTimeKey(c.trainer_id, c.starts_at))
    );
    const existingRoomKeys = new Set(
      (existing || []).map(c => slotTimeKey(c.room_id, c.starts_at))
    );

    const copies = classes
      .map(c => ({
        direction_id: c.direction_id,
        trainer_id: c.trainer_id,
        room_id: c.room_id,
        max_participants: c.max_participants,
        starts_at: addDays(c.starts_at, 7),
        ends_at:   addDays(c.ends_at, 7),
        status: 'scheduled',
      }))
      .filter(c =>
        !existingTrainerKeys.has(slotTimeKey(c.trainer_id, c.starts_at)) &&
        !existingRoomKeys.has(slotTimeKey(c.room_id, c.starts_at))
      );

    const skipped = classes.length - copies.length;

    if (!copies.length) {
      showToast('Розклад уже скопійовано на наступний тиждень', 'info');
      return;
    }

    const { data: inserted, error: insertError } = await supabase
      .from('classes')
      .upsert(copies, { onConflict: 'trainer_id,starts_at', ignoreDuplicates: true })
      .select('id');

    if (insertError) {
      if (isUniqueViolation(insertError)) {
        showToast(uniqueViolationMessage(insertError), 'error');
        return;
      }
      showToast('Помилка копіювання', 'error');
      return;
    }

    const copiedCount = inserted?.length ?? 0;
    const dbSkipped = copies.length - copiedCount;
    const totalSkipped = skipped + dbSkipped;

    showToast(
      totalSkipped > 0
        ? `Скопійовано ${copiedCount}, пропущено наявних: ${totalSkipped}`
        : `Скопійовано ${copiedCount} занять на наступний тиждень`,
      'success'
    );
    await refreshCalendar();
  });
}

async function refreshCalendar() {
  listClassesRangeKey = '';
  if (calendar?.view) {
    const { activeStart: start, activeEnd: end } = calendar.view;
    await loadClasses(start, end);
    reapplyCalendarFilters();
  }
  if (document.querySelector('.tab-btn.active')?.dataset.tab === 'list') {
    await ensureListClassesLoaded();
    renderListView();
  }
}

function addDays(isoStr, days) {
  const d = new Date(isoStr);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function toLocalDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toLocalTimeInput(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Локальні поля дати+часу → коректний UTC-момент (ISO), щоб timestamptz не зсувався */
function localInputsToISO(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0).toISOString();
}

function slotTimeKey(trainerOrRoomId, startsAt) {
  return `${trainerOrRoomId}|${new Date(startsAt).getTime()}`;
}

function isUniqueViolation(error) {
  return error?.code === '23505';
}

function uniqueViolationMessage(error) {
  const c = error?.constraint || '';
  if (c.includes('trainer')) return 'Тренер уже має заняття на цей час';
  if (c.includes('room')) return 'Зал уже зайнятий на цей час';
  return 'Заняття на цей час уже існує';
}

/** trainer_id+starts_at або room_id+starts_at (відповідає UNIQUE у БД) */
async function findSlotConflict(trainerId, roomId, startsAt, excludeId = null) {
  const { data, error } = await supabase
    .from('classes')
    .select('id, trainer_id, room_id')
    .eq('starts_at', startsAt)
    .or(`trainer_id.eq.${trainerId},room_id.eq.${roomId}`);

  if (error) {
    console.warn('Slot conflict check:', error);
    return { error: true };
  }

  const hit = (data || []).find(row => row.id !== excludeId);
  if (!hit) return null;
  if (hit.trainer_id === trainerId) return 'trainer';
  return 'room';
}

// ── Допоміжні функції ──────────────────────────
function populateSelect(id, items, valKey, labelKey) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const first = sel.options[0];
  sel.innerHTML = '';
  if (first) sel.appendChild(first);
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item[valKey];
    opt.textContent = item[labelKey];
    sel.appendChild(opt);
  });
}

function showToast(message, type = '') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type ? 'toast-' + type : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}
