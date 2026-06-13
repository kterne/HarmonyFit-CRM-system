// Модуль: login — сторінка входу менеджера в CRM

import { supabase } from './supabase.js';
import { signIn, getRedirectUrl, redirectIfAuthenticated } from './auth.js';

const DEFAULT_ERROR = 'Невірна адреса електронної пошти або пароль.';
const ACCESS_DENIED = 'Доступ лише для менеджерів.';

function validateLoginForm() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const emailError = document.getElementById('emailError');
  const passwordError = document.getElementById('passwordError');

  let valid = true;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    emailError.classList.remove('hidden');
    valid = false;

  } else {
    emailError.classList.add('hidden');
  }

  if (!password) {
    passwordError.classList.remove('hidden');
    valid = false;
  } else {
    passwordError.classList.add('hidden');
  }

  return valid;
}

document.addEventListener('DOMContentLoaded', async () => {
  await redirectIfAuthenticated('crm');

  const form = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const loginBtn = document.getElementById('loginBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.add('hidden');
    loginError.textContent = DEFAULT_ERROR;

    if (!validateLoginForm()) return;

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    loginBtn.disabled = true;
    loginBtn.textContent = 'Вхід...';

    try {
      const profile = await signIn(email, password);
      const url = getRedirectUrl(profile, 'crm');

      if (!url) {
        loginError.textContent = ACCESS_DENIED;
        loginError.classList.remove('hidden');
        await supabase.auth.signOut();
        loginBtn.disabled = false;
        loginBtn.textContent = 'Увійти';
        return;
      }

      window.location.href = url;

    } catch {
      loginError.classList.remove('hidden');
      loginBtn.disabled = false;
      loginBtn.textContent = 'Увійти';
    }

  });
});