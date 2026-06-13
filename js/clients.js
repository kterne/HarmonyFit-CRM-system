// Модуль: clients — клієнти та тренери в CRM

import './modal-scroll-lock.js';
import { supabase } from './supabase.js';
import { requireAuth } from './auth.js';
import {
  getSubStatus,
  getClientListSubStatus,
  getSubscriptionRemaining,
  pickActiveSubscription,
  pickDisplaySubscription,
  restoreSubscriptionVisit,
} from './subscription-utils.js';
import { canCancelBooking, resolveBookingStatus, syncPastBookingsToAttended } from './booking-utils.js';

let currentTab = 'clients';
let clients = [];
let trainers = [];
let directions = [];
let subTypes = [];
let selectedClientId = null;
let clientVisitBookings = [];

const CANCEL_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

function cancelIconButton(attrs) {
  return `<button type="button" class="btn-icon-cancel" ${attrs} title="Скасувати запис" aria-label="Скасувати запис">${CANCEL_ICON_SVG}</button>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initPersonModals();
  initClientDetail();
  initAssignSubModal();
  initSearch();

  try {
    const profile = await requireAuth(['manager']);
    if (!profile) return;

    await Promise.allSettled([
      loadClients(),
      loadTrainers(),
      loadDirections(),
      loadSubTypes(),
    ]);
  } catch (err) {
    console.error('Clients init error:', err);
  }
});

// ── Допоміжні функції ──────────────────────────
function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function closeClientModal() {
  document.getElementById('clientForm')?.reset();
  closeModal('clientModal');
}

function closeTrainerModal() {
  document.getElementById('trainerForm')?.reset();
  document.getElementById('trainerId').value = '';
  closeModal('trainerModal');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function validatePersonFields({ nameEl, emailEl, phoneEl, notesEl, roleLabel }) {
  const name = nameEl.value.trim();
  const email = emailEl.value.trim();

  if (!name) {
    showToast(`Введіть повне ім'я ${roleLabel}`, 'error');
    nameEl.focus();
    return null;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Введіть коректний email', 'error');
    emailEl.focus();
    return null;
  }

  const payload = {
    full_name: name,
    phone: phoneEl.value.trim() || null,
    email: email || null,
  };
  if (notesEl) payload.notes = notesEl.value.trim() || null;
  return payload;
}

function validateClientFields(fields) {
  return validatePersonFields({ ...fields, roleLabel: 'клієнта' });
}

function matchesPersonSearch(person, query) {
  const q = query.toLowerCase();
  return (
    person.full_name?.toLowerCase().includes(q) ||
    person.phone?.includes(query) ||
    person.email?.toLowerCase().includes(q)
  );
}

function tableEmptyRow(colspan, title) {
  return `<tr><td colspan="${colspan}"><div class="empty-state">
    <p class="empty-state-title">${escapeHtml(title)}</p>
  </div></td></tr>`;
}

// ── Завантаження даних ─────────────────────────
async function loadClients() {
  const { data } = await supabase
    .from('profiles')
    .select(`
      id, full_name, phone, email, notes,
      client_subscriptions(
        id, visits_total, visits_used, start_date, end_date,
        subscription_type:subscription_types(id, name, visit_count)
      )
    `)
    .eq('role', 'client')
    .order('full_name');
  clients = data || [];
  renderClients();
}

async function loadTrainers() {
  const { data } = await supabase
    .from('profiles')
    .select(`
      id, full_name, phone, email,
      trainer_directions(direction:directions(id, name, color))
    `)
    .eq('role', 'trainer')
    .order('full_name');
  trainers = data || [];
  renderTrainers();
}

async function loadDirections() {
  const { data } = await supabase.from('directions').select('*').order('name');
  directions = data || [];
}

async function loadSubTypes() {
  const { data } = await supabase.from('subscription_types').select('*').order('visit_count');
  subTypes = data || [];
  populateSubTypeSelects();
  updateAssignSubAvailability();
}

function populateSubTypeSelects() {
  const optionsHtml = subTypes.map(t =>
    `<option value="${t.id}">${t.name} (${t.visit_count} зан.) — ${Number(t.price)} грн</option>`
  ).join('');

  ['subTypeSelect', 'clientNewSubType'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const first = id === 'clientNewSubType'
      ? '<option value="">Без абонементу</option>'
      : '<option value="">Оберіть тип</option>';
    sel.innerHTML = first + optionsHtml;
  });
}

function getActiveSub(client) {
  return pickActiveSubscription(client?.client_subscriptions || []);
}

function formatActiveSubBlockMessage(sub) {
  const remaining = getSubscriptionRemaining(sub);
  const endStr = new Date(sub.end_date).toLocaleDateString('uk-UA');
  return `У клієнта вже є активний абонемент «${sub.subscription_type?.name || '—'}» (до ${endStr}, залишилось ${remaining} з ${sub.visits_total} занять). Новий можна призначити після його завершення.`;
}

function updateAssignSubAvailability(client = null) {
  const hasTypes = subTypes.length > 0;
  const c = client || (selectedClientId ? clients.find(x => x.id === selectedClientId) : null);
  const activeSub = c ? getActiveSub(c) : null;
  const blocked = Boolean(activeSub);

  const btn = document.getElementById('openAssignSubBtn');
  if (btn) {
    btn.toggleAttribute('disabled', !hasTypes || blocked);
  }

  const removeBtn = document.getElementById('removeActiveSubBtn');
  if (removeBtn) {
    removeBtn.classList.toggle('hidden', !activeSub);
  }

  document.getElementById('clientNewSubBlock')?.classList.toggle('hidden', !hasTypes);

  const msgEl = document.getElementById('assignSubBlockedMsg');
  if (msgEl) {
    if (blocked && activeSub) {
      msgEl.textContent = formatActiveSubBlockMessage(activeSub);
      msgEl.classList.remove('hidden');
    } else {
      msgEl.textContent = '';
      msgEl.classList.add('hidden');
    }
  }
}

function subStatusBadge(sub) {
  const s = getSubStatus(sub);
  const map = {
    active:   ['badge-active', 'Активний'],
    expiring: ['badge-expiring', 'Закінчується'],
    expired:  ['badge-expired', 'Закінчився'],
    none:     ['badge-cancelled', 'Без абонементу'],
  };
  const [cls, label] = map[s] || map.none;
  return `<span class="badge ${cls}">${label}</span>`;
}

function getSubHistory(client) {
  const active = getActiveSub(client);
  const activeId = active?.id;
  return [...(client?.client_subscriptions || [])]
    .filter(s => s.id !== activeId)
    .sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
}

// ── Відображення таблиць ───────────────────────
function renderClients(query = '', statusFilter = '') {
  const tbody = document.getElementById('clientsTableBody');
  let filtered = [...clients];

  if (query) {
    filtered = filtered.filter(c => matchesPersonSearch(c, query));
  }

  if (statusFilter) {
    filtered = filtered.filter(c => getClientListSubStatus(c) === statusFilter);
  }

  document.getElementById('clientsCount').textContent = `${filtered.length} клієнтів`;

  if (!filtered.length) {
    tbody.innerHTML = tableEmptyRow(7, 'Клієнтів не знайдено');
    return;
  }

  tbody.innerHTML = filtered.map(c => {
    const sub = pickDisplaySubscription(c.client_subscriptions || []);
    return `<tr>
      <td><span class="fw-600">${escapeHtml(c.full_name || '—')}</span></td>
      <td class="td-muted">${escapeHtml(c.phone || '—')}</td>
      <td class="td-muted">${escapeHtml(c.email || '—')}</td>
      <td>${sub ? escapeHtml(sub.subscription_type?.name || '—') : '—'}</td>
      <td>${subStatusBadge(sub)}</td>
      <td class="td-muted td-notes">${escapeHtml(truncateText(c.notes, 48))}</td>
      <td>
        <div class="table-actions">
          <button class="btn btn-ghost btn-icon btn-sm" title="Редагувати" onclick="openClientDetail('${c.id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderTrainers(query = '') {
  const tbody = document.getElementById('trainersTableBody');
  let filtered = [...trainers];

  if (query) {
    filtered = filtered.filter(t => matchesPersonSearch(t, query));
  }

  document.getElementById('trainersCount').textContent = `${filtered.length} тренерів`;

  if (!filtered.length) {
    tbody.innerHTML = tableEmptyRow(5, 'Тренерів не знайдено');
    return;
  }

  tbody.innerHTML = filtered.map(t => {
    const dirs = (t.trainer_directions || []).map(td =>
      `<span class="direction-tag" style="background:${td.direction?.color || '#EEF0FE'}20;color:${td.direction?.color || '#5B6AF0'}">${escapeHtml(td.direction?.name || '')}</span>`
    ).join(' ');
    return `<tr>
      <td><span class="fw-600">${escapeHtml(t.full_name || '—')}</span></td>
      <td class="td-muted">${escapeHtml(t.phone || '—')}</td>
      <td class="td-muted">${escapeHtml(t.email || '—')}</td>
      <td>${dirs || '—'}</td>
      <td>
        <div class="table-actions">
          <button class="btn btn-ghost btn-icon btn-sm" title="Редагувати" onclick="event.stopPropagation();openEditTrainer('${t.id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Вкладки клієнти / тренери ──────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      document.getElementById('tab-clients').classList.toggle('hidden', currentTab !== 'clients');
      document.getElementById('tab-trainers').classList.toggle('hidden', currentTab !== 'trainers');
      document.getElementById('addBtnLabel').textContent = currentTab === 'clients' ? 'Додати клієнта' : 'Додати тренера';
      document.getElementById('breadcrumbCurrent').textContent = currentTab === 'clients' ? 'Клієнти' : 'Тренери';
    });
  });
}

// ── Пошук і фільтр ─────────────────────────────
function initSearch() {
  document.getElementById('clientSearch')?.addEventListener('input', e => {
    renderClients(e.target.value, document.getElementById('filterSubStatus').value);
  });
  document.getElementById('filterSubStatus')?.addEventListener('change', e => {
    renderClients(document.getElementById('clientSearch').value, e.target.value);
  });
  document.getElementById('trainerSearch')?.addEventListener('input', e => {
    renderTrainers(e.target.value);
  });
}

// ── Модалки: створення клієнта, CRUD тренера ───
function initPersonModals() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('#addPersonBtn')) {
      e.preventDefault();
      if (currentTab === 'clients') openClientModal();
      else openTrainerModal();
      return;
    }
    if (e.target.closest('#clientModalClose, #clientModalCancel')) {
      e.preventDefault();
      closeClientModal();
      return;
    }
    if (e.target.id === 'clientModal') {
      closeClientModal();
      return;
    }
    if (e.target.closest('#trainerModalClose, #trainerModalCancel')) {
      e.preventDefault();
      closeTrainerModal();
      return;
    }
    if (e.target.id === 'trainerModal') {
      closeTrainerModal();
    }
  });

  document.getElementById('clientForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    saveClient();
  });
  document.getElementById('trainerForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    saveTrainer();
  });
  document.getElementById('trainerModalDelete')?.addEventListener('click', deleteTrainer);
}

function openClientModal() {
  document.getElementById('clientForm')?.reset();
  document.getElementById('clientNewSubBlock')?.classList.toggle('hidden', !subTypes.length);
  document.getElementById('clientNewSubType').value = '';
  document.getElementById('clientNewSubStart').value = new Date().toISOString().slice(0, 10);
  openModal('clientModal');
  document.getElementById('clientName')?.focus();
}

async function saveClient() {
  const payload = validateClientFields({
    nameEl: document.getElementById('clientName'),
    emailEl: document.getElementById('clientEmail'),
    phoneEl: document.getElementById('clientPhone'),
    notesEl: document.getElementById('clientNotes'),
  });
  if (!payload) return;

  const newSubTypeId = document.getElementById('clientNewSubType')?.value;
  const newSubStart = document.getElementById('clientNewSubStart')?.value;

  payload.role = 'client';
  const { data, error } = await supabase
    .from('profiles')
    .insert(payload)
    .select('id')
    .single();

  if (error) { showToast('Помилка збереження', 'error'); return; }

  const newClientId = data?.id;
  if (newClientId && newSubTypeId) {
    const subError = await createClientSubscription(newClientId, newSubTypeId, newSubStart);
    if (subError) {
      showToast('Клієнта створено, але абонемент не призначено', 'error');
      await loadClients();
      closeClientModal();
      window.openClientDetail(newClientId);
      return;
    }
  }

  closeClientModal();
  showToast('Клієнта додано', 'success');
  await loadClients();
  if (newClientId) window.openClientDetail(newClientId);
}

// ── Модалка тренера ────────────────────────────

function openTrainerModal(trainer = null) {
  const isEdit = Boolean(trainer);
  const footer = document.getElementById('trainerModalFooter');
  footer?.classList.toggle('modal-footer--edit', isEdit);
  footer?.classList.toggle('modal-footer--start', !isEdit);

  document.getElementById('trainerModalTitle').textContent = isEdit ? 'Редагувати тренера' : 'Новий тренер';
  document.getElementById('trainerId').value    = trainer?.id || '';
  document.getElementById('trainerName').value  = trainer?.full_name || '';
  document.getElementById('trainerPhone').value = trainer?.phone || '';
  document.getElementById('trainerEmail').value = trainer?.email || '';
  document.getElementById('trainerModalDelete').classList.toggle('hidden', !isEdit);

  const selectedDirs = new Set((trainer?.trainer_directions || []).map(td => td.direction?.id));
  const container = document.getElementById('trainerDirectionsCheckboxes');
  container.innerHTML = directions.map(d => {
    const checked = selectedDirs.has(d.id);
    return `<label class="direction-checkbox-item${checked ? ' checked' : ''}">
      <input type="checkbox" value="${d.id}"${checked ? ' checked' : ''} onchange="this.closest('label').classList.toggle('checked',this.checked)">
      ${escapeHtml(d.name)}
    </label>`;
  }).join('');

  openModal('trainerModal');
}

window.openEditTrainer = function(id) {
  const t = trainers.find(t => t.id === id);
  if (t) openTrainerModal(t);
};

async function saveTrainer() {
  const id = document.getElementById('trainerId').value;
  const payload = validatePersonFields({
    nameEl: document.getElementById('trainerName'),
    emailEl: document.getElementById('trainerEmail'),
    phoneEl: document.getElementById('trainerPhone'),
    roleLabel: 'тренера',
  });
  if (!payload) return;

  let profileId = id;
  let error;

  if (id) {
    ({ error } = await supabase.from('profiles').update(payload).eq('id', id));
  } else {
    payload.role = 'trainer';
    const { data, error: e } = await supabase.from('profiles').insert(payload).select().single();
    error = e;
    profileId = data?.id;
  }

  if (error || !profileId) { showToast('Помилка збереження', 'error'); return; }

  // Оновлення прив'язаних напрямків тренера
  const checked = Array.from(
    document.querySelectorAll('#trainerDirectionsCheckboxes input:checked')
  ).map(i => i.value);

  await supabase.from('trainer_directions').delete().eq('trainer_id', profileId);
  if (checked.length) {
    await supabase.from('trainer_directions').insert(
      checked.map(dId => ({ trainer_id: profileId, direction_id: dId }))
    );
  }

  closeTrainerModal();
  showToast(id ? 'Тренера оновлено' : 'Тренера додано', 'success');
  await loadTrainers();
}

async function deleteTrainer() {
  const id = document.getElementById('trainerId').value;
  if (!id || !confirm('Видалити цього тренера?')) return;
  const { error } = await supabase.from('profiles').delete().eq('id', id);
  if (error) { showToast('Помилка видалення', 'error'); return; }
  closeTrainerModal();
  showToast('Тренера видалено', 'success');
  await loadTrainers();
}

// ── Картка клієнта: контакти, абонемент, візити ─
function initClientDetail() {
  const modal = document.getElementById('clientDetailModal');
  const close = () => closeClientDetail();

  document.getElementById('clientDetailClose')?.addEventListener('click', close);
  document.getElementById('clientDetailCancel')?.addEventListener('click', close);
  modal?.addEventListener('click', e => {
    if (e.target === modal) closeClientDetail();
  });

  document.getElementById('clientCardForm')?.addEventListener('submit', e => {
    e.preventDefault();
    saveClientCard();
  });
  document.getElementById('clientCardDelete')?.addEventListener('click', deleteClientFromCard);
  document.getElementById('openAssignSubBtn')?.addEventListener('click', openAssignSubModal);
  document.getElementById('removeActiveSubBtn')?.addEventListener('click', removeActiveSubscription);

  document.getElementById('clientVisitHistory')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cancel-booking]');
    if (!btn) return;
    e.preventDefault();
    void cancelClientBooking(btn.getAttribute('data-cancel-booking'));
  });
}

function initAssignSubModal() {
  const modal = document.getElementById('assignSubModal');
  if (!modal) return;

  const close = () => closeAssignSubModal();
  document.getElementById('assignSubModalClose')?.addEventListener('click', close);
  document.getElementById('assignSubModalCancel')?.addEventListener('click', close);
  modal.addEventListener('click', e => {
    if (e.target === modal) closeAssignSubModal();
  });

  document.getElementById('assignSubSave')?.addEventListener('click', assignSubscription);

  const updatePreview = () => {
    const preview = document.getElementById('assignSubPreview');
    const typeId = document.getElementById('subTypeSelect')?.value;
    const startDate = document.getElementById('subStartDate')?.value;
    if (!preview || !typeId || !startDate) {
      preview?.classList.add('hidden');
      return;
    }
    const type = subTypes.find(t => String(t.id) === String(typeId));
    if (!type) {
      preview.classList.add('hidden');
      return;
    }
    const end = calcSubEndDate(startDate, type.duration_days);
    preview.textContent = `${type.visit_count} занять, діє до ${end.toLocaleDateString('uk-UA')}`;
    preview.classList.remove('hidden');
  };

  document.getElementById('subTypeSelect')?.addEventListener('change', updatePreview);
  document.getElementById('subStartDate')?.addEventListener('change', updatePreview);
}

function calcSubEndDate(startDateStr, durationDays = 30) {
  const start = new Date(startDateStr);
  const end = new Date(start);
  end.setDate(end.getDate() + (durationDays || 30));
  return end;
}

function setAssignSubModalBlocked(blocked, activeSub = null) {
  const alertEl = document.getElementById('assignSubBlockedAlert');
  const formEl = document.getElementById('assignSubFormFields');
  const saveBtn = document.getElementById('assignSubSave');
  const preview = document.getElementById('assignSubPreview');

  if (blocked && activeSub) {
    alertEl.textContent = formatActiveSubBlockMessage(activeSub);
    alertEl.classList.remove('hidden');
    formEl?.classList.add('hidden');
    saveBtn?.classList.add('hidden');
    preview?.classList.add('hidden');
  } else {
    alertEl.textContent = '';
    alertEl.classList.add('hidden');
    formEl?.classList.remove('hidden');
    saveBtn?.classList.remove('hidden');
  }
}

function openAssignSubModal() {
  if (!selectedClientId) return;
  if (!subTypes.length) {
    showToast('Немає типів абонементів. Створіть їх у розділі «Абонементи»', 'error');
    return;
  }

  const client = clients.find(c => c.id === selectedClientId);
  const activeSub = client ? getActiveSub(client) : null;

  document.getElementById('assignSubModalTitle').textContent = activeSub
    ? 'Призначення недоступне'
    : 'Призначити абонемент';
  document.getElementById('assignSubClientName').textContent = client?.full_name
    ? `Клієнт: ${client.full_name}`
    : '';

  setAssignSubModalBlocked(Boolean(activeSub), activeSub);

  if (!activeSub) {
    document.getElementById('subTypeSelect').value = '';
    document.getElementById('subStartDate').value = new Date().toISOString().slice(0, 10);
    document.getElementById('assignSubPreview')?.classList.add('hidden');
  }

  openModal('assignSubModal');
  if (!activeSub) document.getElementById('subTypeSelect')?.focus();
}

function closeAssignSubModal() {
  document.getElementById('subTypeSelect').value = '';
  document.getElementById('subStartDate').value = '';
  document.getElementById('assignSubPreview')?.classList.add('hidden');
  closeModal('assignSubModal');
  setAssignSubModalBlocked(false);
  document.getElementById('assignSubModalTitle').textContent = 'Призначити абонемент';
}

function renderSubHistory(client, container) {
  if (!container) return;
  const history = getSubHistory(client);

  if (!history.length) {
    container.innerHTML = '<p class="visit-history-empty">Немає минулих абонементів</p>';
    return;
  }

  container.innerHTML = history.map(sub => {
    const remaining = getSubscriptionRemaining(sub);
    const startStr = new Date(sub.start_date).toLocaleDateString('uk-UA');
    const endStr = new Date(sub.end_date).toLocaleDateString('uk-UA');
    return `<div class="sub-history-row">
      <div class="sub-history-row__main">
        <span class="sub-history-row__name">${escapeHtml(sub.subscription_type?.name || '—')}</span>
        ${subStatusBadge(sub)}
      </div>
      <div class="sub-history-row__meta">
        ${startStr} – ${endStr} · використано ${sub.visits_used} з ${sub.visits_total}
        ${remaining > 0 && getSubStatus(sub) === 'expired' ? ` (залишилось ${remaining})` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderClientSubInfo(sub, container) {
  if (!container) return;
  if (sub) {
    const remaining = getSubscriptionRemaining(sub);
    container.innerHTML = `
      <div class="sub-summary">
        <div class="sub-summary-item">
          <span class="sub-summary-label">Тип</span>
          <span class="sub-summary-value">${escapeHtml(sub.subscription_type?.name || '—')}</span>
        </div>
        <div class="sub-summary-item">
          <span class="sub-summary-label">Статус</span>
          <span>${subStatusBadge(sub)}</span>
        </div>
        <div class="sub-summary-item">
          <span class="sub-summary-label">Початок</span>
          <span class="sub-summary-value">${new Date(sub.start_date).toLocaleDateString('uk-UA')}</span>
        </div>
        <div class="sub-summary-item">
          <span class="sub-summary-label">Залишилось занять</span>
          <span class="sub-summary-value">${remaining} з ${sub.visits_total}</span>
        </div>
        <div class="sub-summary-item">
          <span class="sub-summary-label">Діє до</span>
          <span class="sub-summary-value">${new Date(sub.end_date).toLocaleDateString('uk-UA')}</span>
        </div>
      </div>`;
  } else {
    container.innerHTML = '<p class="visit-history-empty" style="padding:8px 0;">Абонемент не призначено</p>';
  }
}

function renderVisitHistory(bookings, container) {
  if (!container) return;
  if (!bookings?.length) {
    container.innerHTML = '<p class="visit-history-empty">Немає відвідувань</p>';
    return;
  }
  const sorted = [...bookings].sort((a, b) => {
    const ta = a.class?.starts_at ? new Date(a.class.starts_at).getTime() : 0;
    const tb = b.class?.starts_at ? new Date(b.class.starts_at).getTime() : 0;
    return tb - ta;
  });
  container.innerHTML = `
    <div class="visit-history-list">
      <div class="visit-row visit-row--header">
        <span>Заняття</span>
        <span>Дата</span>
        <span>Статус</span>
        <span class="visit-row-action" aria-hidden="true"></span>
      </div>
      ${sorted.map(b => {
    const dt = b.class?.starts_at ? new Date(b.class.starts_at) : null;
    const dateStr = dt
      ? dt.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    const st = resolveBookingStatus(b);
    const badge = st === 'attended'
      ? '<span class="badge badge-attended">Відвідав</span>'
      : st === 'cancelled'
      ? '<span class="badge badge-cancelled">Скасовано</span>'
      : '<span class="badge badge-scheduled">Записаний</span>';
    const canCancel = canCancelBooking({ ...b, class: b.class });
    const actionCell = canCancel
      ? `<span class="visit-row-action">${cancelIconButton(`data-cancel-booking="${b.id}"`)}</span>`
      : '<span class="visit-row-action" aria-hidden="true"></span>';
    return `<div class="visit-row">
      <span class="visit-direction">${escapeHtml(b.class?.direction?.name || '—')}</span>
      <span class="visit-date">${dateStr}</span>
      <span class="visit-status">${badge}</span>
      ${actionCell}
    </div>`;
  }).join('')}
    </div>`;
}

async function loadClientVisitHistory(clientId) {
  const histContainer = document.getElementById('clientVisitHistory');
  if (!histContainer) return;

  histContainer.innerHTML = '<p class="visit-history-empty">Завантаження...</p>';

  const { data: bookings, error } = await supabase
    .from('class_bookings')
    .select(`
      id, status,
      class:classes(starts_at, ends_at, direction:directions(name))
    `)
    .eq('client_id', clientId)
    .limit(50);

  if (selectedClientId !== clientId) return;

  if (error) {
    histContainer.innerHTML = '<p class="visit-history-empty">Не вдалося завантажити записи</p>';
    clientVisitBookings = [];
    return;
  }

  await syncPastBookingsToAttended(bookings || []);
  clientVisitBookings = bookings || [];
  renderVisitHistory(clientVisitBookings, histContainer);
}

async function cancelClientBooking(bookingId) {
  const bookingKey = String(bookingId);
  const booking = clientVisitBookings.find((b) => String(b.id) === bookingKey);
  if (!booking || !selectedClientId) return;

  if (!canCancelBooking({ ...booking, class: booking.class })) {
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

  const restored = await restoreSubscriptionVisit(selectedClientId);
  if (!restored.ok) {
    showToast(restored.message || 'Запис скасовано, але заняття не повернулось на абонемент', 'error');
  } else {
    showToast('Запис скасовано', 'success');
  }

  await loadClients();
  const client = clients.find((c) => c.id === selectedClientId);
  if (client) {
    renderClientSubInfo(getActiveSub(client), document.getElementById('clientSubInfo'));
    updateAssignSubAvailability(client);
  }
  await loadClientVisitHistory(selectedClientId);
}

function fillClientCardForm(client) {
  document.getElementById('clientCardId').value = client.id;
  document.getElementById('clientCardName').value = client.full_name || '';
  document.getElementById('clientCardPhone').value = client.phone || '';
  document.getElementById('clientCardEmail').value = client.email || '';
  document.getElementById('clientCardNotes').value = client.notes || '';
}

window.openClientDetail = async function(clientId) {
  selectedClientId = clientId;
  let client = clients.find(c => c.id === clientId);
  if (!client) return;

  openModal('clientDetailModal');
  document.getElementById('clientDetailName').textContent = client.full_name || 'Клієнт';

  const sub = getActiveSub(client);
  const displaySub = pickDisplaySubscription(client.client_subscriptions || []);
  document.getElementById('clientCardSubBadge').innerHTML = subStatusBadge(displaySub);
  renderClientSubInfo(sub, document.getElementById('clientSubInfo'));
  renderSubHistory(client, document.getElementById('clientSubHistory'));
  fillClientCardForm(client);

  updateAssignSubAvailability(client);

  await loadClientVisitHistory(clientId);
};

function closeClientDetail() {
  const clientId = selectedClientId;
  closeModal('clientDetailModal');
  selectedClientId = null;
  if (clientId) {
    const client = clients.find(c => c.id === clientId);
    if (client) fillClientCardForm(client);
  }
}

async function saveClientCard() {
  const id = document.getElementById('clientCardId').value || selectedClientId;
  if (!id) return;

  const payload = validateClientFields({
    nameEl: document.getElementById('clientCardName'),
    emailEl: document.getElementById('clientCardEmail'),
    phoneEl: document.getElementById('clientCardPhone'),
    notesEl: document.getElementById('clientCardNotes'),
  });
  if (!payload) return;

  const { error } = await supabase.from('profiles').update(payload).eq('id', id);
  if (error) {
    showToast('Помилка збереження', 'error');
    return;
  }

  showToast('Дані клієнта збережено', 'success');
  await loadClients();
  if (selectedClientId === id) {
    window.openClientDetail(id);
  }
}

async function deleteClientFromCard() {
  const id = document.getElementById('clientCardId').value || selectedClientId;
  if (!id || !confirm('Видалити цього клієнта?')) return;

  const { error } = await supabase.from('profiles').delete().eq('id', id);
  if (error) {
    showToast('Помилка видалення', 'error');
    return;
  }

  closeClientDetail();
  showToast('Клієнта видалено', 'success');
  await loadClients();
}

async function createClientSubscription(clientId, typeId, startDate) {
  const client = clients.find(c => c.id === clientId);
  const activeSub = client ? getActiveSub(client) : null;
  if (activeSub) {
    return formatActiveSubBlockMessage(activeSub);
  }

  const type = subTypes.find(t => String(t.id) === String(typeId));
  if (!type) return 'Тип абонементу не знайдено';
  if (!startDate) return 'Вкажіть дату початку';

  const end = calcSubEndDate(startDate, type.duration_days);

  const { error } = await supabase.from('client_subscriptions').insert({
    client_id: clientId,
    subscription_type_id: type.id,
    start_date: startDate,
    end_date: end.toISOString().slice(0, 10),
    visits_total: type.visit_count,
    visits_used: 0,
  });

  return error ? (error.message || 'Помилка призначення') : null;
}

async function assignSubscription() {
  if (!selectedClientId) return;

  const client = clients.find(c => c.id === selectedClientId);
  const activeSub = client ? getActiveSub(client) : null;
  if (activeSub) {
    setAssignSubModalBlocked(true, activeSub);
    return;
  }

  const typeId = document.getElementById('subTypeSelect')?.value;
  const startDate = document.getElementById('subStartDate')?.value;
  if (!typeId || !startDate) {
    showToast('Оберіть тип і дату початку', 'error');
    return;
  }

  const errMsg = await createClientSubscription(selectedClientId, typeId, startDate);
  if (errMsg) {
    showToast(typeof errMsg === 'string' ? errMsg : 'Помилка призначення', 'error');
    console.warn('assignSubscription:', errMsg);
    return;
  }

  showToast('Абонемент призначено', 'success');
  closeAssignSubModal();
  await loadClients();
  window.openClientDetail(selectedClientId);
}

async function removeActiveSubscription() {
  if (!selectedClientId) return;

  const client = clients.find(c => c.id === selectedClientId);
  const activeSub = client ? getActiveSub(client) : null;
  if (!activeSub) {
    showToast('Немає активного абонемента для видалення', 'error');
    return;
  }

  const subName = activeSub.subscription_type?.name || 'абонемент';
  if (!confirm(`Видалити активний абонемент «${subName}»? Цю дію не можна скасувати.`)) return;

  const { error } = await supabase
    .from('client_subscriptions')
    .delete()
    .eq('id', activeSub.id);

  if (error) {
    showToast('Не вдалося видалити абонемент', 'error');
    console.warn('removeActiveSubscription:', error);
    return;
  }

  showToast('Абонемент видалено', 'success');
  await loadClients();
  window.openClientDetail(selectedClientId);
}

function truncateText(text, max = 48) {
  if (!text) return '—';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── Сповіщення (toast) ─────────────────────────
function showToast(message, type = '') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type ? 'toast-' + type : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}
