// Модуль: modal-scroll-lock — блокує прокрутку сторінки, поки відкрита модалка

/** Вмикає/вимикає клас modal-scroll-lock на <html>, якщо є видима модалка. */
function syncModalScrollLock() {
  const locked = !!document.querySelector('.modal-backdrop:not(.hidden)');
  document.documentElement.classList.toggle('modal-scroll-lock', locked);
}

function watchModals() {
  document.querySelectorAll('.modal-backdrop').forEach((el) => {
    new MutationObserver(syncModalScrollLock).observe(el, {
      attributes: true,
      attributeFilter: ['class'],
    });
  });
  syncModalScrollLock();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchModals);
} else {
  watchModals();
}
