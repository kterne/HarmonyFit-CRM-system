// Модуль: landing — розклад на головній сторінці

import { supabase } from './supabase.js';

const ENROLL_LINK = 'cabinet/cabinet-login.html';
const ENROLL_ARROW = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>';

let allClasses = [];
let activeScheduleDay = getTodayWeekdayIndex();
let scheduleLoadError = false;

const SCHEDULE_LOADING_HTML = '<p class="landing-schedule-loading">Завантаження розкладу...</p>';
const SCHEDULE_ERROR_HTML = '<p class="landing-schedule-error">Розклад тимчасово недоступний. Спробуйте пізніше.</p>';
const SCHEDULE_EMPTY_HTML = '<p class="landing-schedule-empty">На цей день немає доступних занять</p>';

function getMonday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function getTodayWeekdayIndex() {
  const day = new Date().getDay();
  return day === 0 ? 6 : day - 1;
}

function getDateForScheduleDay(dayIndex) {
  const date = new Date(getMonday());
  date.setDate(date.getDate() + dayIndex);
  return date;
}

function isSameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  );
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadSchedule() {
  const list = document.querySelector('#schedule .schedule-list');
  if (list) list.innerHTML = SCHEDULE_LOADING_HTML;

  const start = getMonday();
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  end.setHours(23, 59, 59, 999);

  const { data, error } = await supabase
    .from('classes')
    .select(`
      id, starts_at, ends_at, status,
      direction:directions(id, name),
      trainer:profiles!classes_trainer_id_fkey(id, full_name)
    `)
    .gte('starts_at', start.toISOString())
    .lt('starts_at', end.toISOString())
    .neq('status', 'cancelled')
    .order('starts_at');

  if (error) {
    console.warn('Landing schedule:', error);
    scheduleLoadError = true;
    allClasses = [];
    renderSchedule();
    return;
  }

  scheduleLoadError = false;
  allClasses = data || [];
  renderSchedule();
}

function renderScheduleRow(cls) {
  const time = new Date(cls.starts_at).toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const trainerName = cls.trainer?.full_name || 'Тренер';
  const className = cls.direction?.name || 'Заняття';

  return `<article class="schedule-row" role="listitem">
    <div class="schedule-trainer">
      <span class="trainer-name-text">${escapeHtml(trainerName)}</span>
    </div>
    <div class="schedule-class-info">
      <span class="class-name-text">${escapeHtml(className)}</span>
      <span class="class-time-text">${escapeHtml(time)}</span>
      <a href="${ENROLL_LINK}" class="enroll-link">
        Записатися
        <span class="enroll-link-icon">${ENROLL_ARROW}</span>
      </a>
    </div>
  </article>`;
}

function renderSchedule() {
  const list = document.querySelector('#schedule .schedule-list');
  if (!list) return;

  if (scheduleLoadError) {
    list.innerHTML = SCHEDULE_ERROR_HTML;
    return;
  }

  const selectedDate = getDateForScheduleDay(activeScheduleDay);
  const now = Date.now();

  const dayClasses = allClasses
    .filter((cls) => isSameCalendarDay(new Date(cls.starts_at), selectedDate))
    .filter((cls) => new Date(cls.starts_at).getTime() > now)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  if (!dayClasses.length) {
    list.innerHTML = SCHEDULE_EMPTY_HTML;
    return;
  }

  list.innerHTML = dayClasses.map(renderScheduleRow).join('');
}

function initScheduleTabs() {
  const tabs = document.querySelectorAll('.schedule-day-tab');
  if (!tabs.length) return;

  activeScheduleDay = getTodayWeekdayIndex();
  tabs.forEach((tab, index) => {
    tab.setAttribute('aria-selected', index === activeScheduleDay ? 'true' : 'false');
    tab.addEventListener('click', () => {
      activeScheduleDay = Number(tab.dataset.scheduleDay);
      tabs.forEach((t) => t.setAttribute('aria-selected', 'false'));
      tab.setAttribute('aria-selected', 'true');
      renderSchedule();
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initScheduleTabs();
  void loadSchedule();
});
