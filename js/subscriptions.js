// Модуль: subscriptions — типи абонементів у CRM

import './modal-scroll-lock.js';
import { supabase } from './supabase.js';
import { requireAuth } from './auth.js';
import { getSubStatus } from './subscription-utils.js';

let subTypes = [];
let currentSubTypeId = null;

window.__subscriptionsModuleReady = true;
initSubTypeModalHandlers();

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const profile = await requireAuth(['manager']);
    if (!profile) return;
    await Promise.allSettled([loadSubTypes(), loadStats()]);
  } catch (err) {
    console.error('Subscriptions init error:', err);
  }
});

async function loadAll() {
  await Promise.allSettled([loadSubTypes(), loadStats()]);
}

// ── Завантаження типів абонементів ─────────────
async function loadSubTypes() {
  const { data } = await supabase
    .from('subscription_types')
    .select('*')
    .order('visit_count');

  subTypes = data || [];
  renderCards();
}

// ── Статистика ─────────────────────────────────
async function loadStats() {
  document.getElementById('statTypesCount').textContent = '—';
  document.getElementById('statActiveCount').textContent = '—';
  document.getElementById('statExpiringCount').textContent = '—';

  const { count: typesCount } = await supabase
    .from('subscription_types')
    .select('id', { count: 'exact', head: true });

  const { data: allSubs } = await supabase
    .from('client_subscriptions')
    .select('end_date, visits_total, visits_used');

  let activeCount = 0;
  let expiringCount = 0;
  for (const sub of allSubs || []) {
    const status = getSubStatus(sub);
    if (status === 'active') activeCount++;
    else if (status === 'expiring') expiringCount++;
  }

  document.getElementById('statTypesCount').textContent = typesCount ?? 0;
  document.getElementById('statActiveCount').textContent = activeCount;
  document.getElementById('statExpiringCount').textContent = expiringCount;
}

// ── Картки типів абонементів ───────────────────
function renderEmptySubTypes() {
  return `<div class="sub-card sub-card-empty"><div class="empty-state">
    <p class="empty-state-title">Типів абонементів ще немає</p>
  </div></div>`;
}

function renderCards() {
  const grid = document.getElementById('subTypesGrid');
  if (!grid) return;

  if (!subTypes.length) {
    grid.innerHTML = renderEmptySubTypes();
    return;
  }

  grid.innerHTML = '';

  subTypes.forEach(type => {
    const perVisit = type.visit_count > 0 ? Math.round(type.price / type.visit_count) : 0;
    const card = document.createElement('div');
    card.className = 'sub-card sub-card--editable';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Редагувати абонемент ${type.name}`);
    card.innerHTML = `
      <div class="sub-card-accent"></div>
      <div class="sub-card-body">
        <h3 class="sub-card-name">${escapeHtml(type.name)}</h3>
        <p class="sub-card-visits">${type.visit_count} ${pluralVisits(type.visit_count)}</p>
        <div class="sub-card-price">${formatPrice(type.price)} <span>грн</span></div>
        <div class="sub-card-meta">
          <span class="sub-card-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            ${type.duration_days} днів
          </span>
          <span class="sub-card-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
            </svg>
            ${perVisit} грн/заняття
          </span>
        </div>
        ${type.description ? `<p class="sub-card-desc">${escapeHtml(type.description)}</p>` : ''}
      </div>`;

    card.addEventListener('click', () => openSubTypeModal(type));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openSubTypeModal(type);
      }
    });

    grid.appendChild(card);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pluralVisits(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'заняття';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'заняття';
  return 'занять';
}

function formatPrice(price) {
  return new Intl.NumberFormat('uk-UA').format(price);
}

// ── Модалка створення / редагування ────────────
function initSubTypeModalHandlers() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('#addSubTypeBtn')) {
      e.preventDefault();
      openSubTypeModal();
      return;
    }
    if (e.target.closest('#subTypeModalClose, #subTypeModalCancel')) {
      e.preventDefault();
      closeSubTypeModal();
      return;
    }
    if (e.target.id === 'subTypeModal') {
      closeSubTypeModal();
    }
  });

  document.getElementById('subTypeForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSubType();
  });
  document.getElementById('subTypeModalDelete')?.addEventListener('click', deleteSubType);
}

function openSubTypeModal(type = null) {
  const modal = document.getElementById('subTypeModal');
  if (!modal) return;

  const isEdit = Boolean(type);
  currentSubTypeId = type?.id || null;

  document.getElementById('subTypeForm')?.reset();

  const footer = document.getElementById('subTypeModalFooter');
  footer?.classList.toggle('modal-footer--edit', isEdit);
  footer?.classList.toggle('modal-footer--start', !isEdit);

  document.getElementById('subTypeModalTitle').textContent = isEdit
    ? 'Редагувати абонемент'
    : 'Новий тип абонементу';
  document.getElementById('subTypeId').value       = type?.id || '';
  document.getElementById('subTypeName').value     = type?.name || '';
  document.getElementById('subTypeVisits').value   = type?.visit_count ?? '';
  document.getElementById('subTypeDuration').value = type?.duration_days ?? 30;
  document.getElementById('subTypePrice').value    = type?.price ?? '';
  document.getElementById('subTypeDesc').value     = type?.description || '';
  document.getElementById('subTypeModalDelete')?.classList.toggle('hidden', !isEdit);

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('subTypeName')?.focus();
}

function closeSubTypeModal() {
  const modal = document.getElementById('subTypeModal');
  if (!modal) return;
  currentSubTypeId = null;
  document.getElementById('subTypeForm')?.reset();
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

window.openEditSubType = function(id) {
  const t = subTypes.find(item => item.id === id);
  if (t) openSubTypeModal(t);
};

function validateSubTypeForm() {
  const name = document.getElementById('subTypeName').value.trim();
  const visitsRaw = document.getElementById('subTypeVisits').value;
  const durationRaw = document.getElementById('subTypeDuration').value;
  const priceRaw = document.getElementById('subTypePrice').value;
  const visits = parseInt(visitsRaw, 10);
  const duration = parseInt(durationRaw, 10);
  const price = parseFloat(priceRaw);

  if (!name) {
    showToast('Введіть назву абонементу', 'error');
    document.getElementById('subTypeName')?.focus();
    return null;
  }
  if (!visitsRaw || !Number.isFinite(visits) || visits < 1) {
    showToast('Вкажіть кількість занять', 'error');
    document.getElementById('subTypeVisits')?.focus();
    return null;
  }
  if (!durationRaw || !Number.isFinite(duration) || duration < 1) {
    showToast('Вкажіть термін дії в днях', 'error');
    document.getElementById('subTypeDuration')?.focus();
    return null;
  }
  if (!priceRaw || !Number.isFinite(price) || price < 0) {
    showToast('Вкажіть ціну абонементу', 'error');
    document.getElementById('subTypePrice')?.focus();
    return null;
  }

  return {
    name,
    visit_count: visits,
    duration_days: duration,
    price,
    description: document.getElementById('subTypeDesc').value.trim() || null,
  };
}

async function saveSubType() {
  const id = document.getElementById('subTypeId').value;
  const payload = validateSubTypeForm();
  if (!payload) return;

  const { error } = id
    ? await supabase.from('subscription_types').update(payload).eq('id', id)
    : await supabase.from('subscription_types').insert(payload);

  if (error) { showToast('Помилка збереження', 'error'); return; }

  closeSubTypeModal();
  showToast(id ? 'Тип оновлено' : 'Тип створено', 'success');
  await loadAll();
}

async function deleteSubType() {
  const id = currentSubTypeId || document.getElementById('subTypeId').value;
  if (!id) return;

  const { count } = await supabase
    .from('client_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('subscription_type_id', id);

  if (count > 0) {
    showToast(`Неможливо видалити: ${count} клієнтів мають цей тип`, 'error');
    return;
  }

  if (!confirm('Видалити цей тип абонементу?')) return;

  const { error } = await supabase.from('subscription_types').delete().eq('id', id);
  if (error) { showToast('Помилка видалення', 'error'); return; }

  closeSubTypeModal();
  showToast('Тип видалено', 'success');
  await loadAll();
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
