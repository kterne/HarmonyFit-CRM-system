// Модуль: auth — автентифікація, профіль користувача, захист сторінок

import { supabase } from './supabase.js';

const AUTH_BYPASS = false;

function bypassProfile(allowedRoles = []) {

  let role = 'manager';
  if (allowedRoles.length) {
    role = allowedRoles.includes('manager') ? 'manager' : allowedRoles[0];
  }
  return { ...BYPASS_PROFILE, role };
}

/**
 * Вхід за email і паролем.
 * Повертає профіль з таблиці profiles; редірект — на відповідальності викликаючого коду.
 */

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;

  const profile = await getCurrentProfile();
  if (!profile) throw new Error('Profile not found');
  return profile;
}

/**
 * URL для переходу після входу — залежить від ролі профілю та контексту сторінки (crm / landing).
 */

function cabinetRelativeUrl(page) {
  const path = window.location.pathname.replace(/\\/g, '/');
  if (path.includes('/cabinet/')) return page;
  return `cabinet/${page}`;
}

function crmRelativeUrl(page) {
  const path = window.location.pathname.replace(/\\/g, '/');
  if (path.includes('/crm/')) return page;
  return `crm/${page}`;
}

export function getRedirectUrl(profile, context) {
  if (!profile) return null;

  if (context === 'crm') {
    return profile.role === 'manager' ? crmRelativeUrl('schedule.html') : null;
  }

  if (context === 'landing') {
    if (profile.role === 'client') return cabinetRelativeUrl('cabinet.html');
    if (profile.role === 'trainer') return cabinetRelativeUrl('trainer.html');
    return null;
  }

  return null;
}

/** Чекає появу профілю після signUp (тригер БД може створити його з затримкою). */
async function waitForProfile(maxAttempts = 8, delayMs = 250) {
  for (let i = 0; i < maxAttempts; i++) {
    const profile = await getCurrentProfile();
    if (profile) return profile;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/** Реєстрація клієнта: auth + профіль. Якщо email збігається з CRM — абонемент підтягнеться через тригер БД. */
export async function signUpClient({ firstName, lastName, email, phone, password }) {
  const fullName = `${firstName} ${lastName}`.trim();
  const normalizedEmail = email.trim().toLowerCase();

  if (!phone) throw new Error('Phone required');

  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: {
        full_name: fullName,
        phone,
      },
    },
  });

  if (error) throw error;

  if (!data.session) {
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });
    if (signInError) throw signInError;
  }

  const profile = await waitForProfile();
  if (!profile) throw new Error('Profile not found');
  return profile;
}

/**
 * Якщо сесія вже є — одразу перенаправляє на відповідну сторінку (crm або кабінет).
 */

export async function redirectIfAuthenticated(context) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  const profile = await getCurrentProfile();
  const url = getRedirectUrl(profile, context);
  if (url) window.location.href = url;
}



/**
 * Вихід із системи та перехід на сторінку входу (CRM або кабінет).
 */

export async function signOut() {
  await supabase.auth.signOut();

  const path = window.location.pathname.replace(/\\/g, '/');

  if (path.includes('/cabinet/')) {
    window.location.href = 'cabinet-login.html';
    return;
  }

  window.location.href = loginPageUrl();

}



function loginPageUrl() {
  const path = window.location.pathname.replace(/\\/g, '/');

  if (path.includes('/crm/')) return 'login.html';

  if (path.includes('/cabinet/')) return 'cabinet-login.html';

  return 'crm/login.html';
}



/**
 * Поточний профіль з таблиці profiles (за user_id або fallback за id).
 */

export async function getCurrentProfile() {
  if (AUTH_BYPASS) return bypassProfile();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  let { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!data) {
    const fallback = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();
    data = fallback.data;
  }
  return data;
}


/**
 * Захист сторінки: без сесії — редірект на login.
 * З allowedRoles — додатково перевіряє роль (manager, client тощо).
 */

export async function requireAuth(allowedRoles = []) {
  if (AUTH_BYPASS) return bypassProfile(allowedRoles);
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    window.location.href = loginPageUrl();
    return null;
  }

  if (allowedRoles.length > 0) {
    const profile = await getCurrentProfile();
    if (!profile || !allowedRoles.includes(profile.role)) {
      window.location.href = loginPageUrl();
      return null;
    }

    return profile;
  }
  return session.user;
}


// ── Бічна панель: ім'я користувача та вихід ─────
document.addEventListener('DOMContentLoaded', async () => {
  const userNameEl   = document.getElementById('userName');
  const userRoleEl   = document.getElementById('userRole');
  const userInitials = document.getElementById('userInitials');
  const logoutBtn    = document.getElementById('logoutBtn');

  if (logoutBtn) {
    logoutBtn.addEventListener('click', signOut);
  }

  if (userNameEl) {
    const profile = await getCurrentProfile();
    if (profile) {
      userNameEl.textContent = profile.full_name || 'Користувач';
      if (userRoleEl) userRoleEl.textContent = roleLabel(profile.role);
      if (userInitials) {
        const parts = (profile.full_name || '').split(' ');
        userInitials.textContent = parts.slice(0, 2).map(p => p[0]).join('').toUpperCase() || 'U';
      }

    }

  }

});

function roleLabel(role) {
  const map = { manager: 'Менеджер', trainer: 'Тренер', client: 'Клієнт' };
  return map[role] || role;
}