// Модуль: cabinet-login — вхід і реєстрація клієнта в особистому кабінеті

import { supabase } from './supabase.js';
import {
  signIn,
  signUpClient,
  getRedirectUrl,
  redirectIfAuthenticated,
} from './auth.js';

const DEFAULT_LOGIN_ERROR = 'Невірна адреса email або пароль.';
const DEFAULT_REGISTER_ERROR = 'Не вдалося зареєструватися. Спробуйте ще раз.';
const ACCESS_DENIED = 'Немає доступу до особистого кабінету. Менеджери входять через CRM.';
const EMAIL_TAKEN = 'Користувач з таким email уже зареєстрований.';
const PROFILE_PENDING = 'Акаунт створено, але профіль ще не готовий. Спробуйте увійти через кілька секунд.';

const EMAIL_MESSAGES = {
  empty: 'Введіть email',
  invalid: 'Введіть коректну адресу email',
};
const PHONE_MESSAGES = {
  empty: 'Введіть номер телефону',
  invalid: 'Введіть коректний номер: 9 цифр після +380',
};
const PASSWORD_MESSAGES = {
  empty: 'Введіть пароль',
  short: 'Пароль має містити щонайменше 8 символів',
};
const REPEAT_MESSAGES = {
  empty: 'Повторіть пароль',
  mismatch: 'Паролі не збігаються',
};
const NAME_MESSAGES = {
  firstEmpty: "Введіть ім'я",
  lastEmpty: 'Введіть прізвище',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function extractNationalDigits(value) {
  let digits = String(value).replace(/\D/g, '');
  if (digits.startsWith('380')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.slice(0, 9);
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

function syncPhoneInput(input) {
  const national = extractNationalDigits(input.value);
  input.value = national.length ? formatPhoneDisplay(national) : '';
}

function getFullPhoneValue(input) {
  const national = extractNationalDigits(input.value);
  return national.length === 9 ? '+380' + national : '';
}

function setFieldError(input, errorEl, message) {
  input.classList.add('is-invalid');
  errorEl.textContent = message;
  errorEl.classList.add('visible');
  input.setAttribute('aria-invalid', 'true');
}

function clearFieldError(input) {
  const group = input.closest('.field-group');
  const errorEl = group?.querySelector('.field-error');
  input.classList.remove('is-invalid');
  input.removeAttribute('aria-invalid');
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.remove('visible');
  }
}

function focusFirstInvalid(form) {
  const invalid = form.querySelector('.auth-field.is-invalid');
  invalid?.focus();
  invalid?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function validateEmail(input, errorEl) {
  const value = input.value.trim();
  if (!value) {
    setFieldError(input, errorEl, EMAIL_MESSAGES.empty);
    return false;
  }
  if (!EMAIL_RE.test(value)) {
    setFieldError(input, errorEl, EMAIL_MESSAGES.invalid);
    return false;
  }
  clearFieldError(input);
  return true;
}

function validatePhone(input, errorEl) {
  syncPhoneInput(input);
  const national = extractNationalDigits(input.value);
  if (!national.length) {
    setFieldError(input, errorEl, PHONE_MESSAGES.empty);
    return false;
  }
  if (national.length !== 9) {
    setFieldError(input, errorEl, PHONE_MESSAGES.invalid);
    return false;
  }
  clearFieldError(input);
  return true;
}

function validatePassword(input, errorEl) {
  const value = input.value;
  if (!value) {
    setFieldError(input, errorEl, PASSWORD_MESSAGES.empty);
    return false;
  }
  if (value.length < 8) {
    setFieldError(input, errorEl, PASSWORD_MESSAGES.short);
    return false;
  }
  clearFieldError(input);
  return true;
}

function validateName(input, errorEl, emptyMessage) {
  if (!input.value.trim()) {
    setFieldError(input, errorEl, emptyMessage);
    return false;
  }
  clearFieldError(input);
  return true;
}

function validatePasswordRepeat(passwordInput, repeatInput, errorEl) {
  const value = repeatInput.value;
  if (!value) {
    setFieldError(repeatInput, errorEl, REPEAT_MESSAGES.empty);
    return false;
  }
  if (value !== passwordInput.value) {
    setFieldError(repeatInput, errorEl, REPEAT_MESSAGES.mismatch);
    return false;
  }
  clearFieldError(repeatInput);
  return true;
}

function clearFormErrors(form) {
  form.querySelectorAll('.auth-field').forEach(clearFieldError);
}

function bindPhoneInput(input) {
  input.addEventListener('focus', () => {
    if (!input.value.trim()) input.value = '+380 ';
  });

  input.addEventListener('blur', () => syncPhoneInput(input));

  input.addEventListener('input', () => {
    const selStart = input.selectionStart;
    const prevLen = input.value.length;
    const national = extractNationalDigits(input.value);
    input.value = formatPhoneDisplay(national);
    const diff = input.value.length - prevLen;
    if (typeof selStart === 'number') {
      input.setSelectionRange(selStart + diff, selStart + diff);
    }
    clearFieldError(input);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && extractNationalDigits(input.value).length === 0) {
      e.preventDefault();
      input.value = '';
    }
  });
}

function mapAuthError(error, mode) {
  if (!error) return mode === 'register' ? DEFAULT_REGISTER_ERROR : DEFAULT_LOGIN_ERROR;

  const msg = String(error.message || '').toLowerCase();
  if (msg.includes('profile not found')) return PROFILE_PENDING;
  if (msg.includes('already registered') || msg.includes('already been registered')) {
    return EMAIL_TAKEN;
  }
  if (msg.includes('invalid login credentials')) {
    return DEFAULT_LOGIN_ERROR;
  }
  return mode === 'register' ? DEFAULT_REGISTER_ERROR : DEFAULT_LOGIN_ERROR;
}

/** Ініціалізує форми входу/реєстрації, валідацію та перемикання між ними. */
function initCabinetAuth() {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const authTitle = document.getElementById('authTitle');
  const authSubtitle = document.getElementById('authSubtitle');
  const showRegister = document.getElementById('showRegister');
  const showLogin = document.getElementById('showLogin');
  const authError = document.getElementById('authError');

  if (!loginForm || !registerForm || !showRegister || !showLogin) return;

  function hideAuthError() {
    authError?.classList.add('hidden');
    if (authError) authError.textContent = '';
  }

  function showAuthError(message) {
    if (!authError) return;
    authError.textContent = message;
    authError.classList.remove('hidden');
    authError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function switchToRegister() {
    hideAuthError();
    clearFormErrors(loginForm);
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    authTitle.textContent = 'Реєстрація';
    authSubtitle.textContent =
      'Створіть акаунт для входу в кабінет. Якщо ви вже клієнт студії — вкажіть той самий email або телефон, що в базі, і абонемент підтягнеться автоматично.';
  }

  function switchToLogin() {
    hideAuthError();
    clearFormErrors(registerForm);
    registerForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
    authTitle.textContent = 'Вхід';
    authSubtitle.textContent =
      'Увійдіть, якщо ви вже реєструвалися раніше. Перший раз? Натисніть «Зареєструватися» нижче.';
  }

  const passwordToggles = document.querySelectorAll('[data-password-toggle]');
  let passwordsVisible = false;

  function setAllPasswordsVisible(visible) {
    passwordsVisible = visible;
    passwordToggles.forEach((btn) => {
      const input = document.getElementById(btn.getAttribute('data-password-toggle'));
      if (input) input.type = visible ? 'text' : 'password';

      const icon = btn.querySelector('[data-lucide]');
      if (icon) icon.setAttribute('data-lucide', visible ? 'eye-off' : 'eye');
      btn.setAttribute('aria-label', visible ? 'Приховати пароль' : 'Показати пароль');
    });
    if (window.lucide) lucide.createIcons();
  }

  passwordToggles.forEach((btn) => {
    btn.addEventListener('click', () => setAllPasswordsVisible(!passwordsVisible));
  });

  const registerPhone = document.getElementById('register-phone');
  if (registerPhone) bindPhoneInput(registerPhone);

  [
    'login-email',
    'login-password',
    'register-email',
    'register-phone',
    'register-password',
    'register-password-repeat',
    'register-first-name',
    'register-last-name',
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => clearFieldError(el));
  });

  showRegister.addEventListener('click', switchToRegister);
  showLogin.addEventListener('click', switchToLogin);

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAuthError();

    const emailInput = document.getElementById('login-email');
    const emailOk = validateEmail(emailInput, document.getElementById('login-email-error'));
    const passOk = validatePassword(
      document.getElementById('login-password'),
      document.getElementById('login-password-error')
    );
    if (!emailOk || !passOk) {
      focusFirstInvalid(loginForm);
      return;
    }

    const submitBtn = loginForm.querySelector('.submit-btn');
    const email = emailInput.value.trim().toLowerCase();
    const password = document.getElementById('login-password').value;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Вхід...';

    try {
      const profile = await signIn(email, password);
      const url = getRedirectUrl(profile, 'landing');

      if (!url) {
        showAuthError(ACCESS_DENIED);
        await supabase.auth.signOut();
        submitBtn.disabled = false;
        submitBtn.textContent = 'Увійти';
        return;
      }

      window.location.href = url;
    } catch (err) {
      showAuthError(mapAuthError(err, 'login'));
      submitBtn.disabled = false;
      submitBtn.textContent = 'Увійти';
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAuthError();

    const firstNameInput = document.getElementById('register-first-name');
    const lastNameInput = document.getElementById('register-last-name');
    const emailInput = document.getElementById('register-email');
    const phoneInput = document.getElementById('register-phone');
    const passInput = document.getElementById('register-password');
    const repeatInput = document.getElementById('register-password-repeat');

    const firstNameOk = validateName(
      firstNameInput,
      document.getElementById('register-first-name-error'),
      NAME_MESSAGES.firstEmpty
    );
    const lastNameOk = validateName(
      lastNameInput,
      document.getElementById('register-last-name-error'),
      NAME_MESSAGES.lastEmpty
    );
    const emailOk = validateEmail(emailInput, document.getElementById('register-email-error'));
    const phoneOk = validatePhone(phoneInput, document.getElementById('register-phone-error'));
    const passOk = validatePassword(passInput, document.getElementById('register-password-error'));
    const repeatOk = validatePasswordRepeat(
      passInput,
      repeatInput,
      document.getElementById('register-password-repeat-error')
    );
    if (!firstNameOk || !lastNameOk || !emailOk || !phoneOk || !passOk || !repeatOk) {
      focusFirstInvalid(registerForm);
      return;
    }

    const submitBtn = registerForm.querySelector('.submit-btn');
    const email = emailInput.value.trim().toLowerCase();
    const phone = getFullPhoneValue(phoneInput);

    submitBtn.disabled = true;
    submitBtn.textContent = 'Реєстрація...';

    try {
      const profile = await signUpClient({
        firstName: firstNameInput.value.trim(),
        lastName: lastNameInput.value.trim(),
        email,
        phone,
        password: passInput.value,
      });
      const url = getRedirectUrl(profile, 'landing');

      if (!url) {
        showAuthError(ACCESS_DENIED);
        await supabase.auth.signOut();
        submitBtn.disabled = false;
        submitBtn.textContent = 'Зареєструватися';
        return;
      }

      window.location.href = url;
    } catch (err) {
      console.error('Register error:', err);
      showAuthError(mapAuthError(err, 'register'));
      submitBtn.disabled = false;
      submitBtn.textContent = 'Зареєструватися';
    }
  });

  if (window.location.hash === '#register') switchToRegister();
}

document.addEventListener('DOMContentLoaded', () => {
  initCabinetAuth();
  redirectIfAuthenticated('landing').catch((err) => {
    console.warn('Auth session check failed:', err);
  });
});
